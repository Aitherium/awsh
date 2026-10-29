/**
 * The TUI is awsh's default surface (owner, 2026-10-29).
 *
 * The history this pins, because it flipped twice: line mode became the default
 * on 2026-08-21 after three TUI-created defects, and it flipped back when the
 * attention beam gave the TUI a reason to be full-screen — row 0 names the ask
 * waiting on the owner. A default nobody sees is not a default, so the escape
 * hatch is AITHER_TUI=0, not AITHER_TUI=1.
 *
 * Asserted on the SOURCE, like the Veil frame-target tests: repl.ts reaches the
 * whole startup path (clients, config, network) and cannot be imported inertly.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function replSource(): string {
  return readFileSync(join(HERE, '..', 'src', 'repl.ts'), 'utf8')
    .replace(/\/\*(?:[^*]|\*(?!\/))*\*\//g, '')   // block comments document the old decision
    .replace(/^\s*\/\/.*$/gm, '');                // so does the line-comment history
}

test('the TUI opens by default: the env var is an OFF switch, not an ON switch', () => {
  const src = replSource();
  // The ON list (['1','true','on','yes']) is the pre-2026-10-29 shape; it must be gone
  // from the TUI switch specifically. (AITHER_STEER legitimately keeps its own ON list.)
  assert.ok(!/_tuiOn\s*=\s*\['1'/.test(src),
    'repl.ts still treats AITHER_TUI as opt-IN');
  assert.ok(/\['0',\s*'false',\s*'off',\s*'no'\]\.includes/.test(src),
    'repl.ts has no AITHER_TUI=0 escape hatch');
  assert.match(src, /const _tuiOn = !\[/, 'the default is not ON when the env var is unset');
});

test('a pipe is never a TUI', () => {
  // `awsh "do the thing" | tee` must still write plain output.
  assert.match(replSource(), /process\.stdout\.isTTY && process\.stdin\.isTTY/);
});
