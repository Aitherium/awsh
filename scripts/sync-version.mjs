#!/usr/bin/env node
/**
 * sync-version.mjs — keep the AitherShell version in ONE place.
 *
 * package.json `version` is CANONICAL. It is mirrored into the two source files
 * that hard-code it (they drift otherwise — main.ts was 1.12.0 while package.json
 * was 1.13.0, and renderer.ts drifted a whole minor version):
 *   - src/main.ts      const VERSION = '<x.y.z>';
 *   - src/renderer.ts  const version = 'v<x.y.z>';
 *
 * Usage:
 *   node scripts/sync-version.mjs          # rewrite the two files to match package.json
 *   node scripts/sync-version.mjs --check   # exit 1 if they drift (wire into CI/prebuild)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const version = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')).version;

/** Each target: file, regex to find the version literal, and the replacement string. */
const targets = [
  {
    file: 'src/main.ts',
    re: /(const VERSION = ')([^']+)(';)/,
    next: `$1${version}$3`,
    current: (m) => m[2],
  },
  {
    file: 'src/renderer.ts',
    re: /(const version = 'v)([^']+)(';)/,
    next: `$1${version}$3`,
    current: (m) => m[2],
  },
];

let drift = false;
for (const t of targets) {
  const path = join(cliDir, t.file);
  const text = readFileSync(path, 'utf8');
  const m = text.match(t.re);
  if (!m) {
    console.error(`  ✗ ${t.file}: version literal not found (pattern changed?)`);
    drift = true;
    continue;
  }
  if (t.current(m) === version) {
    console.log(`  ✓ ${t.file}: already ${version}`);
    continue;
  }
  if (check) {
    console.error(`  ✗ ${t.file}: ${t.current(m)} != ${version} (run: npm run sync-version)`);
    drift = true;
    continue;
  }
  writeFileSync(path, text.replace(t.re, t.next), 'utf8');
  console.log(`  ↺ ${t.file}: ${t.current(m)} → ${version}`);
}

// The BUILT ARTIFACT is what a developer actually runs (`node dist/main.js`,
// the bin/ entry, the bun-compiled binary). Checking only sources is how a
// dist/main.js reporting 1.14.0 sat next to 1.15.0 sources and an npm-published
// 1.15.0 for days: every source check passed and `--version` still lied.
// Advisory, not fatal: a missing/stale dist is a "rebuild" signal, and a clean
// checkout has no dist at all — failing there would block the build that
// creates it (this script runs as `build`'s FIRST step).
if (check) {
  const distPath = join(cliDir, 'dist/main.js');
  let distText = null;
  try {
    distText = readFileSync(distPath, 'utf8');
  } catch {
    console.log('  · dist/main.js: not built yet (skipped)');
  }
  if (distText !== null) {
    const dm = distText.match(/(?:const VERSION = ')([^']+)(?:';)/);
    if (!dm) {
      console.warn('  ! dist/main.js: version literal not found — stale or reshaped build');
    } else if (dm[1] !== version) {
      console.warn(
        `  ! dist/main.js: ${dm[1]} != ${version} — STALE BUILD, \`--version\` will lie (run: npm run build)`,
      );
    } else {
      console.log(`  ✓ dist/main.js: already ${version}`);
    }
  }
}

if (check && drift) {
  console.error('\nVersion drift detected. Run `npm run sync-version` and commit.');
  process.exit(1);
}
console.log(check ? '\nVersions in sync.' : `\nSynced to ${version}.`);
