#!/usr/bin/env node
/**
 * check-spinner-import.mjs — no REPL module may import ora directly.
 *
 * ora's default `discardStdin: true` grabs stdin while a spinner runs; after it
 * stops, readline misses the next keypresses — measured 2026-08-24 as "press
 * Enter ~3 times after any slash command before awsh> reacts". renderer.ts had
 * quietly carried `discardStdin: false` for itself while commands.ts held 212
 * bare `ora(...)` calls with the default — the fix existed and never reached
 * the other copy. src/spinner.ts is now the one home of the default; this
 * check is what keeps a new module from re-importing 'ora' bare and silently
 * reintroducing the class. Runs as a build step next to sync-version.mjs.
 *
 * Allowlist: spinner.ts (the wrapper itself) and install-wizard.ts (runs
 * BEFORE the REPL exists, so ora's stdin grab cannot hurt readline there).
 *
 * `--self-test` proves the rule can fail: it runs the matcher on a fixture.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ALLOWED = new Set(['spinner.ts', 'install-wizard.ts']);
const BARE_ORA = /^\s*import\s+[^;]*\bfrom\s+['"]ora['"]/m;

if (process.argv.includes('--self-test')) {
  const bad = "import ora from 'ora';\n";
  const good = "import ora from './spinner.js';\n";
  const typeOnly = "import ora, { type Ora } from 'ora';\n";
  if (!BARE_ORA.test(bad)) { console.error('self-test FAIL: bare import not matched'); process.exit(1); }
  if (BARE_ORA.test(good)) { console.error('self-test FAIL: wrapper import matched'); process.exit(1); }
  if (!BARE_ORA.test(typeOnly)) { console.error('self-test FAIL: mixed import not matched'); process.exit(1); }
  console.log('  check-spinner-import self-test OK');
  process.exit(0);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(SRC)) {
  const base = file.split(/[\\/]/).pop();
  if (ALLOWED.has(base)) continue;
  if (BARE_ORA.test(readFileSync(file, 'utf8'))) offenders.push(file);
}

if (offenders.length > 0) {
  console.error('  ✗ bare `ora` import in REPL modules (use ./spinner.js — see src/spinner.ts):');
  for (const f of offenders) console.error(`    ${f}`);
  process.exit(1);
}
console.log(`  ✓ no bare ora imports outside the allowlist`);
