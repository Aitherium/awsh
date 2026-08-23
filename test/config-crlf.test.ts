/**
 * Regression: shell.yaml must parse when written with CRLF line endings.
 *
 * The bug this pins down (2026-07-25): the loader split on '\n', leaving a
 * trailing '\r' on every line. In JS, '.' does NOT match '\r' (it is a line
 * terminator), so `/^(\w+):\s*(.+)$/` never anchored and EVERY line was silently
 * discarded. On Windows — where the file is written CRLF — the entire config file
 * was ignored: api_url, mcp_url, identity_url and model all fell back to defaults,
 * with no error. Two user-visible consequences:
 *   1. the shell ignored its configured endpoint and "went cloud" on its own;
 *   2. main.ts's TLS gate saw an EMPTY url set, concluded "all loopback", and
 *      disabled certificate verification process-wide.
 * A parser that drops everything is indistinguishable from an absent file, so
 * nothing failed loudly. Hence this test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// loadConfig() resolves homedir() on every call, so one static import is enough —
// each call re-reads whatever HOME points at.
import { loadConfig } from '../src/config.js';

const YAML_KEYS = [
  'identity_url: https://127.0.0.1:8115',
  'mcp_url: http://127.0.0.1:8182/mcp',
  'model: test-model',
  'stream: true',
];

/** Write a shell.yaml with the given EOL into an isolated HOME, then loadConfig(). */
async function loadWithEol(eol: string) {
  const home = mkdtempSync(join(tmpdir(), 'aither-cfg-'));
  mkdirSync(join(home, '.aither'), { recursive: true });
  writeFileSync(join(home, '.aither', 'shell.yaml'), YAML_KEYS.join(eol) + eol, 'utf-8');

  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return loadConfig();
  } finally {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  }
}

test('shell.yaml with CRLF endings is parsed (not silently dropped)', async () => {
  const config = await loadWithEol('\r\n');
  assert.equal(config.identityUrl, 'https://127.0.0.1:8115',
    'CRLF shell.yaml was ignored — identity_url fell back to the default');
  assert.equal(config.mcpUrl, 'http://127.0.0.1:8182/mcp',
    'CRLF shell.yaml was ignored — mcp_url fell back to empty');
  assert.equal(config.model, 'test-model');
});

test('LF and CRLF produce identical config', async () => {
  const lf = await loadWithEol('\n');
  const crlf = await loadWithEol('\r\n');
  for (const key of ['identityUrl', 'mcpUrl', 'model'] as const) {
    assert.equal(crlf[key], lf[key], `${key} differs between LF and CRLF`);
  }
});

test('no value carries a stray carriage return', async () => {
  const config = await loadWithEol('\r\n');
  for (const v of [config.identityUrl, config.mcpUrl, config.model]) {
    assert.ok(!String(v).includes('\r'), `value retained a CR: ${JSON.stringify(v)}`);
  }
});
