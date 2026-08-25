/**
 * The startup header must FIT the terminal.
 *
 * Measured 2026-08-21. The header had just been trimmed from twelve lines to
 * five and was still 100 columns wide -- and 80 is the default terminal. A
 * status line that WRAPS is worse than the twelve lines it replaced: it costs
 * two rows anyway, and the second one is a ragged fragment with no label.
 *
 * The first fix was worse than the bug and this file is why it was caught: the
 * segments were joined into one string before measuring, so an 80-column
 * terminal dropped the service count to make room for a model name it could
 * not fit either, and the loop STOPPED at the first overflow so nothing shorter
 * behind it was ever tried. Result: a header that said only "Connected", which
 * is the one thing you could already see.
 */

import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { renderBanner } from '../src/renderer.js';

const ESC = String.fromCharCode(27);

/** Visible width, ignoring colour. Scanned rather than regex-stripped. */
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

/** Render the banner at a given terminal width and return its plain lines.
 *
 * D-2170: used to fake the width by overriding process.stdout.columns via
 * Object.defineProperty. That passed 100% locally (Node 25, and Node 22
 * via fnm — both piped/non-TTY, no existing descriptor to fight) and still
 * failed on the actual GitHub Actions runner, most likely because a
 * pty-backed stream there resolves `columns` through a prototype
 * getter/setter this override could shadow inconsistently. renderBanner
 * now takes an explicit `columns` param for exactly this reason — no
 * global mutation, no environment-dependent property resolution, nothing
 * to restore in a `finally`. */
function renderAt(columns: number | undefined): string[] {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    renderBanner({
      genesis: 'http://127.0.0.1:8182',
      genesisOnline: true,
      services: 5,
      llm: 'test-model-a @ vLLM (local)',
      user: 'David',
      columns,
      serviceLines: [
        { name: 'Pulse', up: true }, { name: 'Strata', up: true },
        { name: 'Genesis', up: false }, { name: 'Node', up: false },
        { name: 'Identity', up: false }, { name: 'Secrets', up: false },
      ],
    });
  } finally {
    console.log = origLog;
  }
  return lines;
}

describe('startup header fits the terminal', () => {
  test('no line exceeds 80 columns on an 80-column terminal', () => {
    for (const line of renderAt(80)) {
      assert.ok(visible(line) <= 80,
        `line is ${visible(line)} cols and will WRAP: ${JSON.stringify(line)}`);
    }
  });

  test('at 80 columns it still reports how much of the fleet is up', () => {
    // The regression the first fix introduced: everything after the link state
    // was dropped, leaving a header that said only what you could already see.
    const joined = renderAt(80).join(' ');
    assert.match(joined, /5 services/,
      'the service count was dropped -- the header now says nothing new');
  });

  test('a narrow terminal still gets the link state, which is the decisive bit', () => {
    const joined = renderAt(48).join(' ');
    assert.match(joined, /127\.0\.0\.1:8182/,
      'the endpoint must survive at any width -- it is what changes what you do next');
  });

  test('a wide terminal spends the room rather than truncating to the narrow form', () => {
    const wide = renderAt(200).join(' ');
    assert.match(wide, /test-model-a/,
      'the model name fits at 200 cols and should be shown');
    assert.ok(visible(renderAt(200).find(l => l.includes('127.0.0.1')) || '') <= 200);
  });

  test('an unknown terminal width is treated as 80, never as unlimited', () => {
    // process.stdout.columns is undefined when stdout is a pipe. Treating that
    // as "infinitely wide" is how the 100-column line reached a real terminal.
    for (const line of renderAt(undefined)) {
      assert.ok(visible(line) <= 80,
        `unknown width produced a ${visible(line)}-col line: ${JSON.stringify(line)}`);
    }
  });
});
