/**
 * Regression: a FAILED rebuild must leave dist/ exactly as it was.
 *
 * The bug (2026-09-30): ensure-fresh-build.cjs ran `npm run build`, caught the
 * failure and printed "running the previous build" -- but tsc emits on error by
 * default, so dist/ had already been overwritten. A stale src/jobs.ts in the
 * shared worktree produced a dist/repl.js importing `adoptStreamJob` from a
 * dist/jobs.js that no longer exported it, and every awsh verb died with a
 * SyntaxError before it ran.
 *
 * Mutation guard: against the old in-place build, the "broken src" case below
 * rewrites dist/main.js and dist/repl.js, so the byte and mtime asserts fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const efb = require(join(cliDir, 'scripts', 'ensure-fresh-build.cjs'));
const tscPath = join(cliDir, 'node_modules', 'typescript', 'bin', 'tsc');

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'awsh-efb-'));
  mkdirSync(join(dir, 'src'));
  // The package's real compiler options, so noEmitOnError is exercised too.
  writeFileSync(join(dir, 'tsconfig.json'), readFileSync(join(cliDir, 'tsconfig.json')));
  writeFileSync(join(dir, 'src', 'jobs.ts'), 'export function adoptStreamJob(): number { return 1; }\n');
  writeFileSync(join(dir, 'src', 'repl.ts'), "import { adoptStreamJob } from './jobs.js';\nexport const n = adoptStreamJob();\n");
  writeFileSync(join(dir, 'src', 'main.ts'), "import { n } from './repl.js';\nexport const main = n;\n");
  return dir;
}

function tsc(dir: string, outDir: string): void {
  execFileSync(process.execPath, [tscPath, '-p', dir, '--outDir', outDir], { stdio: 'pipe' });
}

function snap(dir: string, name: string) {
  const f = join(dir, 'dist', name);
  return { bytes: readFileSync(f, 'utf8'), mtime: statSync(f).mtimeMs };
}

test('package tsconfig refuses to emit on a type error', () => {
  const cfg = JSON.parse(readFileSync(join(cliDir, 'tsconfig.json'), 'utf8'));
  assert.equal(cfg.compilerOptions.noEmitOnError, true);
});

test('defaultCompile mirrors the package build script', () => {
  const pkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts.build,
    'node scripts/sync-version.mjs --check && node scripts/check-spinner-import.mjs && tsc',
    'package.json "build" changed: update defaultCompile in scripts/ensure-fresh-build.cjs to match',
  );
});

test('a good build lands in dist/ and leaves no dist.next/', () => {
  const dir = fixture();
  try {
    const res = efb.rebuild(dir, (_c: string, out: string) => tsc(dir, out));
    assert.equal(res.ok, true);
    assert.ok(existsSync(join(dir, 'dist', 'main.js')));
    assert.ok(!existsSync(join(dir, 'dist.next')));
    assert.ok(!existsSync(join(dir, 'dist.old')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken src leaves dist/main.js and dist/repl.js byte- and mtime-identical', () => {
  const dir = fixture();
  try {
    assert.equal(efb.rebuild(dir, (_c: string, out: string) => tsc(dir, out)).ok, true);
    const main0 = snap(dir, 'main.js');
    const repl0 = snap(dir, 'repl.js');

    // The 2026-09-30 shape: jobs.ts loses the export repl.ts imports.
    writeFileSync(join(dir, 'src', 'jobs.ts'), 'export function other(): number { return 2; }\n');
    const res = efb.rebuild(dir, (_c: string, out: string) => tsc(dir, out));
    assert.equal(res.ok, false);

    assert.deepEqual(snap(dir, 'main.js'), main0);
    assert.deepEqual(snap(dir, 'repl.js'), repl0);
    assert.match(readFileSync(join(dir, 'dist', 'jobs.js'), 'utf8'), /adoptStreamJob/);
    assert.ok(!existsSync(join(dir, 'dist.next')));

    // The failure is remembered for exactly this src state, so the next call skips tsc.
    const p = efb.paths(dir);
    const srcMtime = statSync(join(dir, 'src', 'jobs.ts')).mtimeMs;
    const newest = Math.max(srcMtime, statSync(join(dir, 'src', 'repl.ts')).mtimeMs,
      statSync(join(dir, 'src', 'main.ts')).mtimeMs);
    assert.ok(efb.knownFailure(p, newest), 'failure marker not recorded for the failing src');
    assert.equal(efb.knownFailure(p, newest + 1), null, 'a new src edit must retry the build');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a compile that exits 0 with no main.js is a failure, not an empty dist/', () => {
  const dir = fixture();
  try {
    assert.equal(efb.rebuild(dir, (_c: string, out: string) => tsc(dir, out)).ok, true);
    const main0 = snap(dir, 'main.js');
    const res = efb.rebuild(dir, (_c: string, out: string) => { mkdirSync(out, { recursive: true }); });
    assert.equal(res.ok, false);
    assert.deepEqual(snap(dir, 'main.js'), main0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
