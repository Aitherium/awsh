/**
 * `aither solve …` / `/solve …` — the awsh door onto adk.reasoning.solve.
 *
 * Pins: the argv handed to `python -m adk.cli solve` (env/game positional or flagged,
 * every other flag forwarded verbatim), validation before anything spawns, exit 2 with
 * the install line when adk is not importable, the child's exit code passed through,
 * and — end to end through main.ts — that the verb is intercepted BEFORE backend
 * resolution (a dead Genesis must not matter).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseSolveArgs, buildSolveArgv, validateSolveArgs, runSolveCommand, SOLVE_MISSING_EXIT,
} from '../src/solve-command.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

test('parseSolveArgs: defaults to the toy env with nothing forwarded', () => {
  const p = parseSolveArgs([]);
  assert.equal(p.env, 'toy');
  assert.equal(p.game, '');
  assert.deepEqual(p.flags, []);
  assert.deepEqual(buildSolveArgv(p), ['-m', 'adk.cli', 'solve', '--env', 'toy']);
});

test('parseSolveArgs: positional env + game, flags forwarded in order', () => {
  const p = parseSolveArgs(['arc', 'ls20', '--max-calls', '10', '--json', '--tier=reasoning']);
  assert.deepEqual(buildSolveArgv(p), [
    '-m', 'adk.cli', 'solve', '--env', 'arc', '--game', 'ls20',
    '--max-calls', '10', '--json', '--tier', 'reasoning',
  ]);
});

test('parseSolveArgs: --env / --game flags and boolean --steer-stdin', () => {
  const p = parseSolveArgs(['--steer-stdin', '--env', 'arc', '--game', 'ft09', '--wall-s', '60']);
  assert.equal(p.env, 'arc');
  assert.equal(p.game, 'ft09');
  assert.deepEqual(p.flags, ['--steer-stdin', '--wall-s', '60']);
});

test('validateSolveArgs: unknown env and non-positive numbers are refused', () => {
  assert.match(validateSolveArgs(parseSolveArgs(['chess'])), /env must be one of toy, arc/);
  assert.match(validateSolveArgs(parseSolveArgs(['--max-calls', '0'])), /--max-calls must be a positive/);
  assert.match(validateSolveArgs(parseSolveArgs(['--wall-s', 'x'])), /--wall-s must be a positive/);
  assert.equal(validateSolveArgs(parseSolveArgs(['arc', 'ls20', '--max-actions', '50'])), '');
});

function fakeSpawn(code: number | null, calls: Array<{ cmd: string; argv: string[] }>) {
  return ((cmd: string, argv: string[]) => {
    calls.push({ cmd, argv });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', code, null));
    return child;
  }) as never;
}

test('runSolveCommand: spawns AITHER_PYTHON with the built argv and returns the child code', async () => {
  const calls: Array<{ cmd: string; argv: string[] }> = [];
  const rc = await runSolveCommand(['toy', '--max-calls', '3'], {
    spawn: fakeSpawn(1, calls), probeAdk: () => true, env: { AITHER_PYTHON: 'py-x' }, log: () => {},
  });
  assert.equal(rc, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'py-x');
  assert.deepEqual(calls[0].argv, ['-m', 'adk.cli', 'solve', '--env', 'toy', '--max-calls', '3']);
});

test('runSolveCommand: adk not importable -> exit 2 with the install line, nothing spawned', async () => {
  const calls: Array<{ cmd: string; argv: string[] }> = [];
  const lines: string[] = [];
  const rc = await runSolveCommand([], {
    spawn: fakeSpawn(0, calls), probeAdk: () => false, env: {}, log: (l) => lines.push(l),
  });
  assert.equal(rc, SOLVE_MISSING_EXIT);
  assert.equal(calls.length, 0);
  assert.ok(lines.join('\n').includes("pip install 'aither-adk[reason]'"), lines.join('\n'));
});

test('runSolveCommand: bad args -> exit 2 before the probe or a spawn', async () => {
  let probed = false;
  const rc = await runSolveCommand(['chess'], { probeAdk: () => { probed = true; return true; }, log: () => {} });
  assert.equal(rc, 2);
  assert.equal(probed, false);
});

test('main.ts intercepts `solve` before resolveBackend; commands.ts registers /solve', () => {
  const main = readFileSync(join(SRC, 'main.ts'), 'utf-8');
  const at = main.indexOf("args[0].toLowerCase() === 'solve'");
  assert.ok(at > 0, 'no `solve` interception in main.ts');
  assert.ok(at < main.indexOf('await resolveBackend(config)'), '`solve` must be intercepted before resolveBackend');
  const cmds = readFileSync(join(SRC, 'commands.ts'), 'utf-8');
  assert.match(cmds, /COMMANDS\['solve'\] = \{[\s\S]*?runSolveCommand/);
});

test('end to end: `aither solve chess` exits 2 on validation with a dead backend configured', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(SRC, 'main.ts'), 'solve', 'chess'], {
    encoding: 'utf-8', timeout: 60_000,
    env: { ...process.env, AITHER_GENESIS_URL: 'http://127.0.0.1:9', NO_COLOR: '1' },
  });
  assert.equal(r.status, 2, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(r.stderr, /env must be one of toy, arc/);
});
