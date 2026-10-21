import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTEXT_COMMANDS, buildNexusPanel, buildStrataPanel, buildToolPanel, parseContextCommand,
} from '../src/tui/context-view.js';

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const text = (lines: string[]) => plain(lines.join('\n'));

test('knowledge commands parse; empty args give usage, never a run', () => {
  assert.deepEqual(parseContextCommand('graph', ' who calls resolve '), { kind: 'graph', query: 'who calls resolve' });
  assert.deepEqual(parseContextCommand('strata', 'photos'), { kind: 'strata', query: 'photos' });
  assert.deepEqual(parseContextCommand('nexus', 'media forge'), { kind: 'nexus', query: 'media forge' });
  assert.deepEqual(parseContextCommand('git', ''), { kind: 'git' });
  for (const n of ['graph', 'strata', 'nexus', 'share', 'seal']) {
    assert.equal(parseContextCommand(n, '   ')?.kind, 'usage', n);
  }
});

test('/share and /seal strip quotes so Windows paths with spaces work', () => {
  assert.deepEqual(parseContextCommand('share', '"C:\\Users\\me\\My Photos"'), { kind: 'share', path: 'C:\\Users\\me\\My Photos' });
  assert.deepEqual(parseContextCommand('seal', "'D:\\out dir'"), { kind: 'seal', path: 'D:\\out dir' });
  assert.deepEqual(parseContextCommand('share', 'plain/path'), { kind: 'share', path: 'plain/path' });
});

test('every context command name is dispatched by runCommand', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/tui/repl-tui.ts'), 'utf8');
  assert.match(src, /CONTEXT_COMMANDS\.includes\(name\)/);
  for (const n of CONTEXT_COMMANDS) assert.notEqual(parseContextCommand(n, 'x'), null, n);
});

test('a missing brick is one plain line, never a fake result', () => {
  const out = text(buildToolPanel('awseal sign · D:\\x', { ok: false, tool: 'awseal', notInstalled: true }, 80));
  assert.match(out, /awseal not installed/);
  assert.doesNotMatch(out, /failed|signed/);
});

test('a failed brick shows its error and stderr tail; success shows stdout', () => {
  const bad = text(buildToolPanel('awgraph', { ok: false, tool: 'awgraph', error: 'timed out after 120s', stderr: 'a\nb\nlast line' }, 80));
  assert.match(bad, /awgraph failed: timed out after 120s/);
  assert.match(bad, /last line/);
  const good = text(buildToolPanel('awgit status', { ok: true, tool: 'awgit', stdout: 'vcs: 12 ops\n\n  last: x' }, 80));
  assert.match(good, /vcs: 12 ops/);
  assert.match(text(buildToolPanel('t', { ok: true, tool: 'x', stdout: '' }, 80)), /\(no output\)/);
});

test('strata panel: rows, partial warning, and an honest error', () => {
  const ok = text(buildStrataPanel({
    ok: true, query: 'beach', partial: true,
    items: [{ node: 'desktop', path: 'D:/Photos/beach.jpg', bytes: 2_500_000 }, { node: 'dgx', path: '/data/beach.mp4', size: 10 }],
  }, 90));
  assert.match(ok, /desktop\s+D:\/Photos\/beach\.jpg\s+2\.4 MB/);
  assert.match(ok, /dgx\s+\/data\/beach\.mp4\s+10 B/);
  assert.match(ok, /partial: some machines did not answer/);
  assert.match(text(buildStrataPanel({ ok: true, query: 'q', items: [] }, 80)), /no indexed file matches/);
  assert.match(text(buildStrataPanel({ ok: false, query: 'q', error: 'Unauthorized (HTTP 401)' }, 80)), /file index unavailable: Unauthorized \(HTTP 401\)/);
});

test('nexus panel: score, tier, any of content/text/memory', () => {
  const out = text(buildNexusPanel({
    ok: true, query: 'tor',
    memories: [{ content: 'Tor is bundled', score: 0.91, tier: 'nexus' }, { text: 'second', source: 'spirit' }, { memory: 'third' }],
  }, 80));
  assert.match(out, /91% \[nexus\] Tor is bundled/);
  assert.match(out, /\[spirit\] second/);
  assert.match(out, /third/);
  assert.match(text(buildNexusPanel({ ok: false, query: 'q', error: 'Genesis down' }, 80)), /platform memory unavailable: Genesis down/);
});
