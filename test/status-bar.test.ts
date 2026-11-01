/**
 * The status BAR's content, and the boot banner's ONE next-action line.
 *
 * Measured 2026-11-01 from the owner's screenshots: the bar said `10 down` with no
 * remedy (and the old segment said only `1/11`, which names a ratio and nothing to
 * do), and the inline boot printed "Connected … 10 down · 1 agents · gateway" and
 * then a cursor. Both now carry an instruction, and neither may overflow the terminal.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatStatusBar, type StatusInfo } from '../src/status-banner.ts';
import { renderBanner } from '../src/renderer.ts';

const ESC = String.fromCharCode(27);
function visible(s: string): number {
  let n = 0;
  let inEscape = false;
  for (const ch of s) {
    if (ch === ESC) { inEscape = true; continue; }
    if (inEscape) { if (ch === 'm') inEscape = false; continue; }
    n++;
  }
  return n;
}

/** Strip colour so assertions can read the words the reader actually sees. */
function plain(s: string): string {
  let out = '';
  let inEscape = false;
  for (const ch of s) {
    if (ch === ESC) { inEscape = true; continue; }
    if (inEscape) { if (ch === 'm') inEscape = false; continue; }
    out += ch;
  }
  return out;
}

const statusInfo = (lines: { name: string; up: boolean }[]): StatusInfo => ({
  online: true, backendName: 'genesis', models: [], serviceLines: lines,
} as unknown as StatusInfo);

test('a down count carries its remedy on the same segment', () => {
  // Mutation: plain back to "1/3" or "2 down" alone -> this fails (law 5: never a
  // bare failure; name the command that acts on it).
  const seg = formatStatusBar(statusInfo([
    { name: 'Pulse', up: true }, { name: 'Strata', up: false }, { name: 'Node', up: false },
  ])).find((s) => s.key === 'fabric');
  assert.ok(seg);
  assert.equal(seg!.plain, '■ 2 down · /doctor');
  assert.match(seg!.text, /\/doctor/);
});

test('an all-up fleet shows the numeric fabric count instead', () => {
  const seg = formatStatusBar(statusInfo([
    { name: 'Pulse', up: true }, { name: 'Strata', up: true },
  ])).find((s) => s.key === 'fabric');
  assert.equal(seg!.plain, '■ 2/2 up');
});

test('no services probed: no fabric segment (never a permanent zero)', () => {
  const segs = formatStatusBar(statusInfo([])).map((s) => s.key);
  assert.ok(!segs.includes('fabric'), segs.join(','));
});

/** Render the banner at a width and return its plain lines. */
function renderAt(columns: number, nextLine?: string): string[] {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    renderBanner({
      genesis: 'http://127.0.0.1:8182',
      genesisOnline: true,
      services: 11,
      llm: 'test-model-a @ vLLM (local)',
      user: 'David',
      columns,
      serviceLines: [
        { name: 'Pulse', up: true }, { name: 'Strata', up: false },
        { name: 'Node', up: false }, { name: 'Identity', up: false },
      ],
      nextLine,
    });
  } finally {
    console.log = origLog;
  }
  return lines;
}

test('the boot banner prints the NEXT line it was handed', () => {
  const joined = renderAt(80, '3 down — run /doctor: Strata, Node, Identity').map(plain).join('\n');
  assert.match(joined, /NEXT 3 down — run \/doctor: Strata, Node, Identity/);
});

test('no banner line exceeds the terminal at 40, 80 or 200 columns', () => {
  const long = '10 down — run /doctor: Pulse, Strata, Identity, Node, Secrets, Chronicle, Perception';
  for (const columns of [40, 80, 200]) {
    for (const line of renderAt(columns, long)) {
      assert.ok(visible(line) <= columns,
        `at ${columns} cols a line is ${visible(line)} wide: ${JSON.stringify(line)}`);
    }
  }
});

test('a banner without a next line stays exactly as it was', () => {
  assert.ok(!renderAt(80).map(plain).join('\n').includes('NEXT'));
});
