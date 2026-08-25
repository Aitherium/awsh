/**
 * The Windows Terminal installer.
 *
 * This is the install of last resort and on some machines the ONLY one: with
 * Controlled Folder Access enabled, every $PROFILE path is unwritable AND the
 * refusal is silent (a CREATE fails as "Could not find file"; Add-Content on an
 * existing file reports success and changes nothing).
 *
 * The file it edits is the one that must never be corrupted -- a malformed
 * settings.json breaks every terminal tab -- so the interesting assertions are
 * the REFUSALS, not the happy path.
 */

import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installIntoWindowsTerminal, findTerminalSettings, parseJsonc } from '../src/terminal-install.js';

function fakeLocalAppData(settings: string): string {
  const root = mkdtempSync(join(tmpdir(), 'awsh-wt-'));
  const dir = join(root, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), settings, 'utf-8');
  return root;
}

const GOOD = JSON.stringify({
  defaultProfile: '{abc}',
  profiles: { list: [
    { guid: '{abc}', name: 'PowerShell', commandline: 'pwsh -NoExit -Command [Console]::Write(1)' },
    { guid: '{def}', name: 'Other', commandline: 'cmd.exe' },
  ] },
}, null, 4);

describe('Windows Terminal installer', () => {
  test('installs into the DEFAULT profile only', () => {
    const lad = fakeLocalAppData(GOOD);
    const r = installIntoWindowsTerminal(lad);
    assert.equal(r.ok, true, r.message);
    const after: any = parseJsonc(readFileSync(r.path as string, 'utf-8'));
    const def = after.profiles.list.find((p: any) => p.guid === '{abc}');
    const other = after.profiles.list.find((p: any) => p.guid === '{def}');
    assert.match(def.commandline, /awsh-omnibox/, 'the default profile was not installed into');
    assert.doesNotMatch(other.commandline, /awsh-omnibox/,
      'only the default profile may be touched - the rest belong to the user');
  });

  test('keeps a backup, because this file breaks every tab when wrong', () => {
    const lad = fakeLocalAppData(GOOD);
    const r = installIntoWindowsTerminal(lad);
    assert.ok(existsSync((r.path as string) + '.awsh-backup'));
  });

  test('is idempotent - running twice does not append twice', () => {
    const lad = fakeLocalAppData(GOOD);
    installIntoWindowsTerminal(lad);
    const p = findTerminalSettings(lad) as string;
    const once = readFileSync(p, 'utf-8');
    const second = installIntoWindowsTerminal(lad);
    assert.equal(second.message, 'already installed');
    assert.equal(readFileSync(p, 'utf-8'), once, 'the second run modified the file');
  });

  test('the result still parses as JSON', () => {
    // The whole point of writing textually rather than re-serialising.
    const lad = fakeLocalAppData(GOOD);
    const r = installIntoWindowsTerminal(lad);
    assert.doesNotThrow(() => parseJsonc(readFileSync(r.path as string, 'utf-8')));
  });

  test('REFUSES a profile with no explicit commandline rather than inventing one', () => {
    const lad = fakeLocalAppData(JSON.stringify({
      defaultProfile: '{abc}',
      profiles: { list: [{ guid: '{abc}', name: 'PowerShell', source: 'dynamic' }] },
    }, null, 4));
    const r = installIntoWindowsTerminal(lad);
    assert.equal(r.ok, false);
    assert.match(r.message, /no explicit commandline/);
  });

  test('REFUSES when settings.json is absent - never creates one', () => {
    const root = mkdtempSync(join(tmpdir(), 'awsh-wt-none-'));
    const r = installIntoWindowsTerminal(root);
    assert.equal(r.ok, false);
    assert.equal(r.path, null);
  });

  test('parseJsonc keeps a // inside a string, and drops only full-line comments', () => {
    // A naive comment strip eats the // in a URL and corrupts the file.
    const NL = String.fromCharCode(10);
    const src = '{' + NL + '  // a comment' + NL
      + '  "u": "https://example.com/x"' + NL + '}';
    const parsed: any = parseJsonc(src);
    assert.equal(parsed.u, 'https://example.com/x');
  });
});
