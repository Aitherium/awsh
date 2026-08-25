#!/usr/bin/env node
/**
 * postinstall -- DETECT, never mutate.
 *
 * A package that rewrites a user's shell profile or terminal settings during
 * `npm i -g` is hostile, and on a locked-down machine it would fail silently
 * anyway (Controlled Folder Access makes a profile write report success and
 * change nothing). So this only looks, and points at `awsh setup`, which asks
 * for nothing and verifies every step it takes.
 *
 * It also never fails the install: a postinstall that exits non-zero turns a
 * working `npm i -g` into a red one over a cosmetic notice.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try {
  const hook = join(homedir(), '.aither', 'awsh-omnibox.ps1');
  const installed = existsSync(hook);
  const line = (s) => process.stdout.write('  ' + s + String.fromCharCode(10));
  process.stdout.write(String.fromCharCode(10));
  line('awsh installed.');
  if (!installed) {
    line('');
    line('Run  awsh setup  to finish: it puts the command on the PATH a NEW');
    line('terminal actually reads, installs the shell integration wherever it');
    line('can be written, picks an endpoint that really serves /v1, and then');
    line('re-checks each one and tells you what it could not do.');
  } else {
    line('Shell integration already present. `awsh setup` re-verifies it.');
  }
  process.stdout.write(String.fromCharCode(10));
} catch {
  // Never fail an install over a notice.
}
