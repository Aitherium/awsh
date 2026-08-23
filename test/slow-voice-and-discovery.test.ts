/**
 * Regression tests for the two defects that made AitherShell feel broken on
 * 2026-07-29. Both were invisible to every existing test because both are about
 * TIMING and ENVIRONMENT, not pure logic.
 *
 * 1. A slow TTS backend blanked the screen for the whole synthesis. Genesis
 *    returned a complete answer in 1.2s; the shell rendered it at 33.7s, because
 *    `speakSynced` awaited synthesis before revealing a single character and
 *    edge-tts (a CLOUD round-trip) took 7.2s cold.
 * 2. `buildProbes` hardcoded ports, so healthy services were reported DOWN —
 *    `aitheros-node` publishes 8490->8090 but was probed on :8090 forever.
 */
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { test, describe } from 'node:test';

import { REVEAL_BUDGET_MS, VoiceController } from '../src/tui/voice.js';
import { buildProbes, parseDockerPs, type DiscoveredService } from '../src/status-banner.js';

/** A TTS stand-in that answers only after `delayMs` — the cold edge-tts case. */
function slowVoiceServer(delayMs: number): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, audio_base64: '', duration_seconds: 1 }));
      }, delayMs);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}/voice` });
    });
  });
}

describe('slow TTS must never hold the answer hostage', () => {
  test('reveals the full text within the budget even when synthesis is slow', async () => {
    // 8x the budget — comfortably the "7.2s cold edge-tts" case.
    const { server, url } = await slowVoiceServer(REVEAL_BUDGET_MS * 8);
    try {
      const voice = new VoiceController({ baseUrl: url });
      voice.enable();

      const answer = 'Hello! How can I help you?';
      let revealed = '';
      const started = Date.now();
      const res = await voice.speakSynced(answer, (d) => { revealed += d; });
      const elapsed = Date.now() - started;

      assert.equal(revealed, answer, 'the whole answer must be on screen');
      assert.equal(res.deferred, true, 'a slow synth must take the deferred path');
      assert.ok(
        elapsed < REVEAL_BUDGET_MS * 3,
        `text must appear at ~the budget, not at synthesis time (took ${elapsed}ms)`,
      );
    } finally { server.close(); }
  });

  test('disabled voice reveals immediately and never defers', async () => {
    const voice = new VoiceController();      // not enabled
    let revealed = '';
    const res = await voice.speakSynced('text', (d) => { revealed += d; });
    assert.equal(revealed, 'text');
    assert.ok(!res.deferred);
    assert.equal(res.ok, true);
  });
});

describe('docker discovery drives the probe set', () => {
  const PS_OUTPUT = [
    // The exact shape that broke: published host port != container port.
    'aitheros-node\tUp 20 minutes (healthy)\t127.0.0.1:8490->8090/tcp',
    'aitheros-genesis-lb\tUp 2 hours (healthy)\t127.0.0.1:8001->8001/tcp',
    'aitheros-security-core-lb\tUp 2 hours (healthy)\t127.0.0.1:8115->8115/tcp',
    // Running but publishes NOTHING reachable from the host (the ComfyUI case).
    'aither-comfyui-dgx-worker\tUp 2 hours (healthy)\t',
    'aitheros-pulse\tUp 2 hours (unhealthy)\t127.0.0.1:8081->8081/tcp',
    'aitheros-secrets\tExited (0) 5 minutes ago\t',
  ].join('\n');

  test('parseDockerPs extracts the PUBLISHED host port, not the container port', () => {
    const m = parseDockerPs(PS_OUTPUT);
    assert.equal(m.get('aitheros-node')?.hostPort, '8490');   // NOT 8090
    assert.equal(m.get('aitheros-node')?.running, true);
    assert.equal(m.get('aitheros-node')?.health, 'healthy');
    assert.equal(m.get('aither-comfyui-dgx-worker')?.hostPort, undefined);
    assert.equal(m.get('aitheros-pulse')?.health, 'unhealthy');
    assert.equal(m.get('aitheros-secrets')?.running, false);
  });

  test('parseDockerPs ignores blank lines and malformed rows', () => {
    const m = parseDockerPs('\n\n   \nonlyname\n');
    assert.equal(m.has('onlyname'), true);
    assert.equal(m.get('onlyname')?.running, false);
  });

  const cfg: any = { genesisUrl: 'http://127.0.0.1:8001', identityUrl: '', requireAuth: false };

  test('probes use the discovered port and skip services that are not running', () => {
    const live = parseDockerPs(PS_OUTPUT);
    const probes = buildProbes(cfg, live);
    const byName = Object.fromEntries(probes.map(p => [p.name, p.url]));

    // The actual regression: Node probed on its REAL published port.
    assert.equal(byName['Node'], 'https://127.0.0.1:8490/health');
    // Genesis is http on the host (the LB terminates TLS) — https wastes a connect.
    assert.equal(byName['Genesis'], 'http://127.0.0.1:8001/health');
    // EXITED must still be probed so it renders RED — a crashed service that
    // silently disappears from the banner is worse than the wrong port this
    // discovery replaced.
    assert.equal(byName['Secrets'], 'https://127.0.0.1:8111/health');
    // ABSENT from docker entirely -> not deployed on this host, so omit it
    // rather than show a permanently-red row (e.g. chronicle/strata here).
    assert.equal(byName['Chronicle'], undefined);
    assert.equal(byName['Strata'], undefined);
    // No locally-published ComfyUI -> omitted instead of probing a dead :8188.
    assert.equal(byName['ComfyUI'], undefined);
    // MediaForge is a HOST process, so it survives docker-gating.
    assert.equal(byName['MediaForge'], 'http://127.0.0.1:8200/');
  });

  test('falls back to static ports when docker is unreachable', () => {
    const probes = buildProbes(cfg, null);
    const byName = Object.fromEntries(probes.map(p => [p.name, p.url]));
    // Nothing is docker-gated away, and ComfyUI's legacy probe returns.
    assert.equal(byName['Secrets'], 'https://127.0.0.1:8111/health');
    assert.ok(byName['ComfyUI']?.includes('8188'));
    assert.equal(byName['Node'], 'https://127.0.0.1:8490/health');
  });

  test('remote config is unaffected by local docker state', () => {
    const remote: any = {
      genesisUrl: 'https://gateway.aitherium.com',
      identityUrl: 'https://id.aitherium.com',
      requireAuth: true,
    };
    const probes = buildProbes(remote, parseDockerPs(PS_OUTPUT));
    assert.deepEqual(probes.map(p => p.name), ['Gateway', 'Identity']);
    assert.ok(probes[0].url.startsWith('https://gateway.aitherium.com'));
  });
});
