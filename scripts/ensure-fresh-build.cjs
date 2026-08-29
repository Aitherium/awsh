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
const { existsSync, readdirSync, statSync } = require('node:fs');
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

if (needsBuild()) {
  console.log('[awsh] dist/main.js is stale or missing — rebuilding…');
  try {
    // execSync (a shell) resolves npm.cmd via cmd.exe on win32. execFileSync
    // with a bare 'npm' throws ENOENT (no PATHEXT resolution) and with
    // 'npm.cmd' throws EINVAL (no shell) on Node 25 — both measured 2026-08-28.
    // The command is a constant; nothing interpolates into it.
    execSync('npm run build', { cwd: cliDir, stdio: 'inherit' });
  } catch (err) {
    console.error(
      `[awsh] rebuild failed — run \`npm install\` then \`npm run build\` in ${cliDir} and retry.`,
    );
    process.exit(err.status ?? 1);
  }
}
