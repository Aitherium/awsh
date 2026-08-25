/**
 * The omnibox framing must ride in the SYSTEM slot, never in front of the line.
 *
 * WHY THIS FILE EXISTS. On 2026-08-23 the owner typed `what is in the news
 * today` at a shell prompt and the agent answered "I cannot directly fetch
 * news... would you like me to search?" -- while `web_search` was registered,
 * bound and answering. The reflex reading was "intent classification is
 * broken"; it was not. The omnibox concatenated ~130 words of command-correction
 * instructions in FRONT of the question, so the model received the instructions
 * AS the question and answered them in prose.
 *
 * Measured that day against the live daemon -- same endpoint, same model, same
 * registered tools, three runs per cell:
 *
 *     "what is in the news today"   no framing            : tool called 3/3
 *                                   framing as system     : tool called 3/3
 *                                   framing prepended     : tool called 0/3
 *                                   framing prepended,
 *                                     reworded to invite
 *                                     tool use            : tool called 1/3
 *
 * The last row is why this is a test and not a better sentence: rewording the
 * prompt while leaving it in the user slot moved 0/3 to 1/3, which reads like
 * progress and is a coin flip. The SLOT is the fix.
 *
 * Asserted end-to-end through the real argv path against a stub backend,
 * because the defect lived in argv assembly and every unit-level read of the
 * client was correct throughout.
 */

import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', 'src', 'main.ts');

/** A phrase that appears ONLY in the framing, never in a user's line. */
const FRAMING_MARK = 'typed this at a shell prompt';
const LINE = 'what is in the news today';

interface Captured { message: string; system_additions: string[] }

/** Stand up a backend that answers /health as an ADK daemon (so detectBackend
 *  routes to the agent pipeline) and captures the /chat/stream body. */
async function stubBackend(): Promise<{ port: number; bodies: Captured[]; close: () => Promise<void> }> {
  const bodies: Captured[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', agent: 'adk-daemon', llm_backend: 'stub' }));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url?.includes('/chat')) {
        try {
          const b = JSON.parse(raw || '{}');
          bodies.push({
            message: String(b.message ?? ''),
            system_additions: (b.system_additions ?? []) as string[],
          });
        } catch { /* a malformed body is caught by the assertions below */ }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"type":"done","data":{"content":"ok"}}\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, bodies, close: () => new Promise<void>((r) => { server.close(() => r()); }) };
}

function runOmnibox(port: number, line: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'ask', '--omnibox', '--', ...line.split(' ')], {
      env: {
        ...process.env,
        AITHER_API_URL: `http://127.0.0.1:${port}`,
        // A fresh transcript id per run, or a previous turn resumes into this one.
        AWSH_OMNIBOX_SESSION: `test-${Math.random().toString(36).slice(2)}`,
      },
      stdio: 'ignore',
    });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
}

describe('omnibox framing rides in the system slot', () => {
  test('the MESSAGE is the bare line and the framing is a system addition', async () => {
    const be = await stubBackend();
    try {
      await runOmnibox(be.port, LINE);
      assert.ok(be.bodies.length > 0, 'the omnibox made no chat request at all');
      const body = be.bodies[0];

      // The half that regressed: the question the model is asked must be the
      // question the human asked.
      assert.equal(body.message.trim(), LINE,
        `the framing is still concatenated onto the user's line; the model is being ` +
        `asked to answer an instruction paragraph, not a question. Got: ${body.message.slice(0, 120)}`);
      assert.ok(!body.message.includes(FRAMING_MARK),
        'framing text found inside the user message');

      // The other half: it must still be DELIVERED. Moving it out of the message
      // and dropping it on the floor would pass the assertion above while
      // deleting the shell-correction behaviour the framing exists for -- the
      // silent-no-op this suite exists to catch.
      assert.ok(Array.isArray(body.system_additions) && body.system_additions.length > 0,
        'no system additions were sent -- the framing was moved out of the message and lost');
      assert.ok(body.system_additions.some((a) => String(a).includes(FRAMING_MARK)),
        'the framing reached neither the message nor the system slot');
    } finally {
      await be.close();
    }
  });

  test('a NON-omnibox turn carries no omnibox framing', async () => {
    // The other direction. A rule that only checks the present case passes on an
    // implementation that always injects, which would put shell-correction
    // instructions on every ordinary `awsh ask`.
    const be = await stubBackend();
    try {
      await new Promise<void>((resolve) => {
        const p = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'ask', LINE], {
          env: { ...process.env, AITHER_API_URL: `http://127.0.0.1:${be.port}` },
          stdio: 'ignore',
        });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      });
      assert.ok(be.bodies.length > 0, 'the plain ask made no chat request at all');
      assert.ok(!JSON.stringify(be.bodies[0]).includes(FRAMING_MARK),
        'omnibox framing leaked into a turn that was not typed at a shell prompt');
    } finally {
      await be.close();
    }
  });
});
