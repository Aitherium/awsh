#!/usr/bin/env node
/**
 * ensure-fresh-build.cjs — make `awsh` run the code that is actually in src/.
 *
 * The awsh shims (C:\Users\wzns\bin\awsh.cmd and the npm-global one) run this
 * script BEFORE dist/main.js because "a source edit is live with no reinstall"
 * was FALSE for this tsc-compiled CLI: dist/main.js is a build artifact, not a
 * live source mount, and a stale one shipped silently for an unknown span of
 * time. This script rebuilds when src/ is newer than dist/main.js (or when
 * dist/main.js is missing entirely) and otherwise does nothing — a no-op
 * invocation costs ~10ms.
 *
 * It exists because the 2026-08-27 working-tree destruction (rm -rf ./* in the
 * repo root) deleted the untracked local-only copy of this file AND the
 * gitignored dist/main.js, and the shims' errors — "Cannot find module
 * ensure-fresh-build.cjs" then "Cannot find module dist/main.js" — were the
 * entire symptom. A file the shims depend on must be committed, not local.
 *
 * A FAILED BUILD NEVER TOUCHES dist/ (2026-09-30). The fallback below used to
 * say "running the previous build" after a failed `npm run build`, but tsc
 * emits on error by default, so dist/ had ALREADY been overwritten with the
 * broken output: a stale src/jobs.ts in the shared worktree produced a
 * dist/repl.js importing an export dist/jobs.js no longer had, and every awsh
 * verb died `SyntaxError: ... does not provide an export named
 * 'adoptStreamJob'` before it ran. Now tsc compiles into dist.next/, and only
 * a zero exit swaps it over dist/. A failure is remembered (by the src mtime
 * it failed on) so the next call does not re-run a doomed tsc every time.
 */
const { execSync } = require('node:child_process');
const {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} = require('node:fs');
const { join } = require('node:path');

const DEFAULT_CLI_DIR = join(__dirname, '..');

function paths(cliDir) {
  return {
    cliDir,
    srcDir: join(cliDir, 'src'),
    dist: join(cliDir, 'dist'),
    next: join(cliDir, 'dist.next'),
    old: join(cliDir, 'dist.old'),
    mainOut: join(cliDir, 'dist', 'main.js'),
    // node_modules is ignored everywhere this tree is copied; a marker there
    // can never be committed or published.
    failMarker: join(cliDir, 'node_modules', '.cache', 'awsh-build-failed.json'),
  };
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mts')) {
      newest = Math.max(newest, statSync(p).mtimeMs);
    }
  }
  return newest;
}

/** The failure recorded for exactly this src state, or null. */
function knownFailure(p, srcMtime) {
  try {
    const m = JSON.parse(readFileSync(p.failMarker, 'utf8'));
    return m.srcMtime === srcMtime ? m : null;
  } catch {
    return null;
  }
}

function needsBuild(p) {
  if (!existsSync(p.mainOut)) return true;
  if (!existsSync(p.srcDir)) return true;
  return newestMtime(p.srcDir) > statSync(p.mainOut).mtimeMs;
}

/**
 * Names from package.json (dependencies + devDependencies) with no installed
 * copy under node_modules/. Measured 2026-09-25: node_modules/ existed but was
 * EMPTY, so the rebuild died on "'tsc' is not recognized" and dist/main.js on
 * "Cannot find package 'chalk'" -- every omnibox line in the terminal printed
 * both stack traces and answered nothing. A missing dep is repairable here.
 */
function missingDeps(cliDir) {
  const pkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  return names.filter((n) => !existsSync(join(cliDir, 'node_modules', n, 'package.json')));
}

// execSync (a shell) resolves npm.cmd via cmd.exe on win32. execFileSync
// with a bare 'npm' throws ENOENT (no PATHEXT resolution) and with
// 'npm.cmd' throws EINVAL (no shell) on Node 25 — both measured 2026-08-28.
// The commands are constants; nothing interpolates into them.
function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

/** Last lines of a failed child's output, so the terminal shows the cause, not a wall. */
function tail(err, n = 6) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}${err.stdout || err.stderr ? '' : err.message ?? ''}`
    .trim().split(/\r?\n/);
  return out.slice(-n).map((l) => `  ${l}`).join('\n');
}

/**
 * The same three steps as `npm run build`, with tsc pointed at dist.next/.
 * Kept in step with package.json "build" by test/ensure-fresh-build.test.ts.
 */
function defaultCompile(cliDir, outDir) {
  run('node scripts/sync-version.mjs --check', cliDir);
  run('node scripts/check-spinner-import.mjs', cliDir);
  run(`node node_modules/typescript/bin/tsc -p . --outDir "${outDir}"`, cliDir);
}

/**
 * Compile into dist.next/ and swap it over dist/ only on success.
 * Returns {ok: true} or {ok: false, err}; dist/ is untouched on any failure.
 */
function rebuild(cliDir = DEFAULT_CLI_DIR, compile = defaultCompile) {
  const p = paths(cliDir);
  rmSync(p.next, { recursive: true, force: true });
  try {
    compile(cliDir, p.next);
    if (!existsSync(join(p.next, 'main.js'))) {
      throw new Error('compile exited 0 but produced no dist.next/main.js');
    }
  } catch (err) {
    rmSync(p.next, { recursive: true, force: true });
    const srcMtime = existsSync(p.srcDir) ? newestMtime(p.srcDir) : 0;
    try {
      mkdirSync(join(p.failMarker, '..'), { recursive: true });
      writeFileSync(p.failMarker, JSON.stringify({
        srcMtime, at: new Date().toISOString(), cause: tail(err),
      }));
    } catch { /* a marker we cannot write only costs a retry next call */ }
    return { ok: false, err };
  }
  rmSync(p.old, { recursive: true, force: true });
  const hadDist = existsSync(p.dist);
  if (hadDist) renameSync(p.dist, p.old);
  try {
    renameSync(p.next, p.dist);
  } catch (err) {
    if (hadDist) renameSync(p.old, p.dist);
    rmSync(p.next, { recursive: true, force: true });
    return { ok: false, err };
  }
  rmSync(p.old, { recursive: true, force: true });
  rmSync(p.failMarker, { force: true });
  return { ok: true };
}

function main(cliDir = DEFAULT_CLI_DIR) {
  const p = paths(cliDir);
  const missing = missingDeps(cliDir);
  if (missing.length) {
    console.log(`[awsh] ${missing.length} dependencies missing (${missing.slice(0, 3).join(', ')}…) — npm install…`);
    try {
      run('npm install --no-audit --no-fund', cliDir);
    } catch (err) {
      console.error(`[awsh] npm install failed in ${cliDir}:\n${tail(err)}`);
      process.exit(err.status ?? 1);
    }
  }

  if (!needsBuild(p)) return;
  const srcMtime = existsSync(p.srcDir) ? newestMtime(p.srcDir) : 0;
  const known = existsSync(p.mainOut) ? knownFailure(p, srcMtime) : null;
  if (known) {
    // Same src that failed last time: do not pay for a doomed tsc on every call.
    console.error(`[awsh] src/ does not compile (since ${known.at}) — running the previous build.`);
    return;
  }
  console.log('[awsh] dist/main.js is stale or missing — rebuilding…');
  const res = rebuild(cliDir);
  if (res.ok) return;
  // A shared worktree can carry a peer's half-finished edit that does not
  // compile (2026-09-25: stale Persona* imports in commands.ts). That must
  // not take the shell down while a runnable dist/main.js exists -- and now
  // that dist/ is only replaced on success, "the previous build" is true.
  if (existsSync(p.mainOut)) {
    console.error(`[awsh] rebuild failed — running the previous build. Cause:\n${tail(res.err)}`);
  } else {
    console.error(`[awsh] rebuild failed and there is no previous build in ${cliDir}:\n${tail(res.err)}`);
    process.exit(res.err.status ?? 1);
  }
}

module.exports = { rebuild, needsBuild, knownFailure, paths, defaultCompile };

if (require.main === module) main();
