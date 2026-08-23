/**
 * Install the omnibox into Windows Terminal, because the PowerShell profile is
 * not always writable.
 *
 * On a machine with Controlled Folder Access enabled, ~/Documents is unwritable
 * and EVERY $PROFILE path is either under it or under Program Files (admin).
 * Worse, the refusal is not an error: a CREATE fails as "Could not find file"
 * and Add-Content on an existing file reports SUCCESS and changes nothing. Two
 * installs were confirmed done that way before anyone read the file back.
 *
 * So this writes the terminal profile commandline instead, and it VERIFIES BY
 * READING BACK rather than by trusting the write.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { withTerminalOmnibox, terminalCommandlineHasOmnibox } from './omnibox.js';

export interface InstallResult {
  ok: boolean;
  path: string | null;
  message: string;
}

/** settings.json lives under a versioned package dir, so it is discovered. */
export function findTerminalSettings(localAppData: string): string | null {
  const pkgs = join(localAppData, 'Packages');
  if (!existsSync(pkgs)) return null;
  let names: string[] = [];
  try { names = readdirSync(pkgs); } catch { return null; }
  for (const n of names) {
    if (!n.startsWith('Microsoft.WindowsTerminal')) continue;
    const p = join(pkgs, n, 'LocalState', 'settings.json');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * settings.json is JSONC. Strip only FULL-LINE // comments: a naive strip would
 * also eat the // inside a URL, and this file is the one thing that must never
 * be corrupted -- a malformed settings.json breaks every tab.
 */
export function parseJsonc(text: string): unknown {
  const kept = text
    .split(String.fromCharCode(10))
    .filter((l) => !l.trim().startsWith('//'))
    .join(String.fromCharCode(10));
  return JSON.parse(kept);
}

export function installIntoWindowsTerminal(localAppData: string): InstallResult {
  const path = findTerminalSettings(localAppData);
  if (!path) return { ok: false, path: null, message: 'Windows Terminal settings.json not found' };

  const raw = readFileSync(path, 'utf-8');
  if (terminalCommandlineHasOmnibox(raw)) {
    return { ok: true, path, message: 'already installed' };
  }

  let cfg: any;
  try { cfg = parseJsonc(raw); } catch (e: any) {
    return { ok: false, path, message: 'settings.json did not parse: ' + e.message };
  }
  const list: any[] = cfg?.profiles?.list || [];
  const target = list.find((p) => p && p.guid === cfg.defaultProfile);
  if (!target) return { ok: false, path, message: 'default profile not found in settings.json' };
  const current: string = target.commandline || '';
  if (!current) {
    return { ok: false, path,
      message: 'the default profile has no explicit commandline to extend' };
  }

  const updated = withTerminalOmnibox(current);
  // Textual replacement, not a re-serialise: ConvertTo-JSON style rewriting
  // would drop the file comments and reformat settings the user chose.
  const jsonCur = JSON.stringify(current);
  const jsonNew = JSON.stringify(updated);
  if (!raw.includes(jsonCur)) {
    return { ok: false, path, message: 'could not locate the commandline verbatim - refusing to guess' };
  }
  const next = raw.replace(jsonCur, jsonNew);

  // Validate BEFORE writing. A broken settings.json breaks every terminal tab.
  try { parseJsonc(next); } catch (e: any) {
    return { ok: false, path, message: 'refused: the edit would not parse (' + e.message + ')' };
  }

  copyFileSync(path, path + '.awsh-backup');
  writeFileSync(path, next, 'utf-8');

  // Read back. The write above can silently do nothing under Controlled Folder
  // Access, and that is exactly the failure this whole module exists for.
  const check = readFileSync(path, 'utf-8');
  if (!terminalCommandlineHasOmnibox(check)) {
    return { ok: false, path,
      message: 'the write reported success and the file is unchanged - '
             + 'Controlled Folder Access is blocking it' };
  }
  return { ok: true, path, message: 'installed (backup: ' + path + '.awsh-backup)' };
}
