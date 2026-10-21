import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILES_DEFAULT, FILES_MAX, attachmentPreamble, buildFilesPanel, buildMemPanel, newestFirst, parseContextCommand,
  type FileEntry,
} from '../src/tui/context-view.js';

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('/mem needs a query', () => {
  assert.deepEqual(parseContextCommand('mem', '  photo search '), { kind: 'mem', query: 'photo search' });
  assert.equal(parseContextCommand('memory', '')?.kind, 'usage');
});

test('/files count: default, clamp, junk refused', () => {
  assert.deepEqual(parseContextCommand('files', ''), { kind: 'files', count: FILES_DEFAULT });
  assert.deepEqual(parseContextCommand('files', '3'), { kind: 'files', count: 3 });
  assert.deepEqual(parseContextCommand('files', '9999'), { kind: 'files', count: FILES_MAX });
  for (const bad of ['0', '-2', 'x', '2.5', '3 4']) assert.equal(parseContextCommand('files', bad)?.kind, 'usage', bad);
});

test('/attach: numbers, dedupe, clear, list, junk refused', () => {
  assert.deepEqual(parseContextCommand('attach', '1 3,3'), { kind: 'attach', indexes: [1, 3] });
  assert.deepEqual(parseContextCommand('attach', 'clear'), { kind: 'attach-clear' });
  assert.deepEqual(parseContextCommand('attach', ''), { kind: 'attach-list' });
  assert.equal(parseContextCommand('attach', '0')?.kind, 'usage');
  assert.equal(parseContextCommand('attach', 'a.png')?.kind, 'usage');
  assert.equal(parseContextCommand('relay', 'x'), null);
});

const files: FileEntry[] = [
  { path: '/d/old.txt', name: 'old.txt', size: 10, mtimeMs: 1_000 },
  { path: '/d/new.zip', name: 'new.zip', size: 3 * 1024 * 1024, mtimeMs: 9_000 },
  { path: '/d/b.png', name: 'b.png', size: 2048, mtimeMs: 5_000 },
  { path: '/d/a.png', name: 'a.png', size: 2048, mtimeMs: 5_000 },
];

test('newest first, stable on ties, capped', () => {
  assert.deepEqual(newestFirst(files, 3).map(f => f.name), ['new.zip', 'a.png', 'b.png']);
});

test('files panel numbers rows and marks attached ones', () => {
  const rows = buildFilesPanel('/d', newestFirst(files, 4), 80, ['/d/a.png'], 10_000).map(plain);
  assert.match(rows[0], /newest 4/);
  const a = rows.find(r => r.includes('a.png'))!;
  assert.match(a, /^\+\s+2\s+a\.png/);
  assert.match(rows.find(r => r.includes('new.zip'))!, /^\s+1\s+new\.zip.*3\.0 MB/);
  assert.match(buildFilesPanel('/d', [], 80, []).map(plain).join('\n'), /no files here/);
});

test('mem panel: hits, empty, and the degraded arm is said out loud', () => {
  assert.ok(buildMemPanel({ ok: true, query: 'q', lines: ['one', '', 'two'] }, 60).map(plain).includes('two'));
  assert.match(buildMemPanel({ ok: true, query: 'q', lines: [] }, 60).map(plain).join('\n'), /nothing recalled/);
  assert.match(buildMemPanel({ ok: false, query: 'q', error: 'awm not found' }, 60).map(plain).join('\n'),
    /unavailable: awm not found/);
});

test('attachment preamble lists every path, empty when none', () => {
  assert.equal(attachmentPreamble([]), '');
  const p = attachmentPreamble(['/d/a.png', 'C:\\Users\\x\\b.pdf']);
  assert.match(p, /^\[attached files/);
  assert.ok(p.includes('- /d/a.png\n') && p.includes('- C:\\Users\\x\\b.pdf\n') && p.endsWith('\n\n'));
});
