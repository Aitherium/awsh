/**
 * The ONE place awsh learns its own version.
 *
 * It is read from package.json at RUNTIME, never baked into a literal, because
 * the release lane bumps the version in CI -- so any literal committed to the
 * repo is stale by construction at the moment of publish. Measured on the
 * published package 2026-08-23: source 1.18.0, built artifact 1.18.2,
 * package.json 1.18.3. Three answers to one question.
 *
 * renderer.ts used to carry `const version = 'v1.18.3';  // keep in sync with
 * package.json`. That comment was the whole mechanism, and it failed: it sat at
 * 1.18.3 against a package.json of 1.18.4, `sync-version.mjs --check` failed the
 * build, and the verify job took mirror + binaries + npm publish down with it --
 * five consecutive red runs, so 1.18.3 was the newest anyone could install.
 * A comment asking a human to keep two numbers in step is not a mechanism.
 *
 * `../package.json` resolves from BOTH layouts: dist/version.js -> package root
 * (published), and src/version.ts -> cli/ (dev, run through tsx).
 */
import { readFileSync } from 'fs';

export function readVersion(): string {
  try {
    return JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ).version ?? '0.0.0-unknown';
  } catch {
    // A version string is diagnostic, never load-bearing: failing to read it
    // must not stop the shell from starting.
    return '0.0.0-unknown';
  }
}

export const VERSION = readVersion();
