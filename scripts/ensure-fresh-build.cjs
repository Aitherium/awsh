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
 */
const { execSync } = require('node:child_process');
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const cliDir = join(__dirname, '..');
const srcDir = join(cliDir, 'src');
const mainOut = join(cliDir, 'dist', 'main.js');

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

function needsBuild() {
  if (!existsSync(mainOut)) return true;
  if (!existsSync(srcDir)) return true;
  return newestMtime(srcDir) > statSync(mainOut).mtimeMs;
}

/**
 * Names from package.json (dependencies + devDependencies) with no installed
 * copy under node_modules/. Measured 2026-09-25: node_modules/ existed but was
 * EMPTY, so the rebuild died on "'tsc' is not recognized" and dist/main.js on
 * "Cannot find package 'chalk'" -- every omnibox line in the terminal printed
 * both stack traces and answered nothing. A missing dep is repairable here.
 */
function missingDeps() {
  const pkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  return names.filter((n) => !existsSync(join(cliDir, 'node_modules', n, 'package.json')));
}

// execSync (a shell) resolves npm.cmd via cmd.exe on win32. execFileSync
// with a bare 'npm' throws ENOENT (no PATHEXT resolution) and with
// 'npm.cmd' throws EINVAL (no shell) on Node 25 — both measured 2026-08-28.
// The commands are constants; nothing interpolates into them.
function run(cmd) {
  execSync(cmd, { cwd: cliDir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

/** Last lines of a failed child's output, so the terminal shows the cause, not a wall. */
function tail(err, n = 6) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split(/\r?\n/);
  return out.slice(-n).map((l) => `  ${l}`).join('\n');
}

const missing = missingDeps();
if (missing.length) {
  console.log(`[awsh] ${missing.length} dependencies missing (${missing.slice(0, 3).join(', ')}…) — npm install…`);
  try {
    run('npm install --no-audit --no-fund');
  } catch (err) {
    console.error(`[awsh] npm install failed in ${cliDir}:\n${tail(err)}`);
    process.exit(err.status ?? 1);
  }
}

if (needsBuild()) {
  console.log('[awsh] dist/main.js is stale or missing — rebuilding…');
  try {
    run('npm run build');
  } catch (err) {
    // A shared worktree can carry a peer's half-finished edit that does not
    // compile (2026-09-25: stale Persona* imports in commands.ts). That must
    // not take the shell down while a runnable dist/main.js exists -- run the
    // last build and say so, once, in a few lines.
    if (existsSync(mainOut)) {
      console.error(`[awsh] rebuild failed — running the previous build. Cause:\n${tail(err)}`);
    } else {
      console.error(`[awsh] rebuild failed and there is no previous build in ${cliDir}:\n${tail(err)}`);
      process.exit(err.status ?? 1);
    }
  }
}
