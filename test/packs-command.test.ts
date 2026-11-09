/**
 * `/packs`, `/skills <verb>` and the `/explore` fallback — thin delegates to `adk`.
 *
 * What must hold: the argv handed to python is exactly `-m adk.cli pack|skills <verb> …`
 * (the same resolver every other surface uses); Hermes's verb words (uninstall) read the
 * same; an unknown verb is refused, not forwarded; without awdk the answer is the install
 * line; and /explore with no catalog exits NON-ZERO with its reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPacksArgv, runPacksCommand, exploreViaAdk, splitArgs, AWDK_INSTALL_HINT, EXPLORE_CAP,
} from '../src/packs-command.js';

test('argv: pack verbs map 1:1 onto adk pack; uninstall reads as remove', () => {
  assert.deepEqual(buildPacksArgv('pack', ['search', 'pdf']), ['-m', 'adk.cli', 'pack', 'search', 'pdf']);
  assert.deepEqual(buildPacksArgv('pack', ['install', 'persona', '--allow-community']),
    ['-m', 'adk.cli', 'pack', 'install', 'persona', '--allow-community']);
  assert.deepEqual(buildPacksArgv('pack', ['uninstall', 'persona']), ['-m', 'adk.cli', 'pack', 'remove', 'persona']);
  assert.deepEqual(buildPacksArgv('pack', ['update']), ['-m', 'adk.cli', 'pack', 'update']);
  assert.deepEqual(buildPacksArgv('pack', []), ['-m', 'adk.cli', 'pack', 'list']);
  assert.deepEqual(buildPacksArgv('skills', ['install', 'acp-drive', '--target', 'project']),
    ['-m', 'adk.cli', 'skills', 'install', 'acp-drive', '--target', 'project']);
});

test('refused: unknown verb, and a verb that needs an id without one', () => {
  assert.equal(buildPacksArgv('pack', ['frobnicate', 'x']), null);
  assert.equal(buildPacksArgv('pack', ['install']), null);
  assert.equal(buildPacksArgv('skills', ['update']), null);
  assert.equal(buildPacksArgv('skills', []), null);
});

test('delegates and returns adk exit status', () => {
  const seen: string[][] = [];
  const code = runPacksCommand('pack', ['install', 'persona'], {
    log: () => {}, adkReady: () => true, runPython: (argv) => { seen.push(argv); return 1; },
  });
  assert.equal(code, 1);
  assert.deepEqual(seen, [['-m', 'adk.cli', 'pack', 'install', 'persona']]);
});

test('unknown verb: usage, exit 2, python never runs', () => {
  let ran = false;
  const code = runPacksCommand('pack', ['frobnicate'], {
    log: () => {}, adkReady: () => true, runPython: () => { ran = true; return 0; },
  });
  assert.equal(code, 2);
  assert.equal(ran, false);
});

test('without awdk: the install line, exit 3', () => {
  const lines: string[] = [];
  const code = runPacksCommand('skills', ['install', 'x'], {
    log: (l) => lines.push(l), adkReady: () => false, runPython: () => 0,
  });
  assert.equal(code, 3);
  assert.ok(lines.join('\n').includes(AWDK_INSTALL_HINT));
});

test('/explore with no catalog and no awdk exits 1 with the reason', () => {
  const lines: string[] = [];
  const code = exploreViaAdk('', { log: (l) => lines.push(l), adkReady: () => false });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /No catalog: .*awdk is not installed/);
});

test('/explore with no catalog falls back to adk pack search --json', () => {
  const seen: string[][] = [];
  const lines: string[] = [];
  const packs = Array.from({ length: 7 }, (_, i) => ({
    kind: 'awpack', id: `p${i}`, trust: 'official', installed: false,
  }));
  const code = exploreViaAdk('agent', {
    log: (l) => lines.push(l), adkReady: () => true,
    capturePython: (argv) => { seen.push(argv); return { status: 0, stdout: JSON.stringify({ packs, unavailable: {} }), stderr: '' }; },
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, [['-m', 'adk.cli', 'pack', 'search', 'agent', '--json']]);
  const out = lines.join('\n');
  assert.ok(out.includes('p0') && !out.includes('p6'), 'list must cap at five');
  assert.ok(out.includes(`+${7 - EXPLORE_CAP} more`));
});

test('/explore: adk answers but finds nothing -> exit 1, never a silent 0', () => {
  const code = exploreViaAdk('', {
    log: () => {}, adkReady: () => true,
    capturePython: () => ({ status: 0, stdout: JSON.stringify({ packs: [] }), stderr: '' }),
  });
  assert.equal(code, 1);
});

test('splitArgs keeps quoted words whole', () => {
  assert.deepEqual(splitArgs('search "pdf reader" --json'), ['search', 'pdf reader', '--json']);
  assert.deepEqual(splitArgs('   '), []);
});

test('the /packs and /skills slash commands are registered', async () => {
  const { getCommand } = await import('../src/commands.js');
  assert.ok(getCommand('packs'), '/packs must exist');
  assert.ok(getCommand('skills'), '/skills must exist');
});
