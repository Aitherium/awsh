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
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const version = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')).version;

/** Each target: file, regex to find the version literal, and the replacement string. */
// NOTHING is mirrored any more: both main.ts and renderer.ts import VERSION
// from src/version.ts, which reads package.json at RUNTIME. There is no literal
// left to keep in step, which is the fix -- see src/version.ts.
//
// An empty target list would make this script pass having checked nothing, so
// the rule is INVERTED below: no source file may reintroduce a baked literal.
const targets = [];

/** Source files that must NOT hard-code a version. Reintroducing one is the bug. */
const FORBIDDEN = [
  { re: /const\s+version\s*=\s*'v?\d+\.\d+\.\d+'/, what: "const version = '<literal>'" },
  { re: /const\s+VERSION\s*=\s*'v?\d+\.\d+\.\d+'/, what: "const VERSION = '<literal>'" },
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

// No source may bake a version literal. This replaces the mirroring the
// targets list used to do -- and unlike an empty target list, it can fail.
// A zero-file scan is a HARD FAIL: "no sources found" and "no literals found"
// are the same exit code to everything downstream.
{
  const srcDir = join(cliDir, 'src');
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
  if (files.length === 0) {
    console.error('  ✗ src/ has no .ts files -- refusing to treat an empty scan as a pass');
    process.exit(2);
  }
  let baked = 0;
  for (const f of files) {
    // Strip comments first: version.ts DOCUMENTS the old literal at length,
    // and flagging the write-up of a defect as the defect is how a rule gets
    // deleted rather than satisfied. (It flagged itself on its first run.)
    const text = readFileSync(join(srcDir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const rule of FORBIDDEN) {
      if (rule.re.test(text)) {
        console.error(
          `  ✗ src/${f}: bakes a version literal (${rule.what}). ` +
          `Import VERSION from './version.js' instead -- a literal is stale the moment CI bumps.`,
        );
        baked++;
        drift = true;
      }
    }
  }
  if (baked === 0) console.log(`  ✓ no baked version literal in ${files.length} source file(s)`);
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
      // EXPECTED since main.ts began reading package.json at runtime: a built
      // artifact carries no version literal, and that is the fix, not a fault.
      // A literal here now means an OLD dist built before that change.
      console.log('  · dist/main.js: no baked literal (reads package.json at runtime)');
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
