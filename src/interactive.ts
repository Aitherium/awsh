/**
 * interactive.ts — Generic interactive argument collection for slash commands.
 *
 * The shell's command handlers historically printed a static "Usage: ..." block
 * when invoked with missing arguments (e.g. bare `/safety`), forcing the user to
 * retype the whole line. This module turns the EXISTING `SUBCOMMAND_DEFS` arg
 * hints (completions.ts) into real @inquirer prompts so every command with a
 * subcommand table becomes fully interactive — pick a subcommand, then get
 * select/input/confirm prompts for each declared argument and flag.
 *
 * Nothing here is command-specific: it reads the arg-hint grammar already used
 * for tab completion and the `/` picker, so new commands become interactive for
 * free just by having a SUBCOMMAND_DEFS entry.
 *
 * MUST be called only while the shell has released stdin (the TUI's runDetached,
 * or the readline REPL's detach block) so @inquirer owns the keystrokes.
 *
 * Arg-hint grammar (from SUBCOMMAND_DEFS, e.g. `'<a|b|c> [--context <ctx>] [--flag]'`):
 *   <name>            required positional (text input)
 *   <a|b|c>           required positional, enum  → select menu
 *   "<name>"          required positional, wrap value in quotes on assembly
 *   [name]            optional positional
 *   --flag <val>      optional flag with a value
 *   [--flag quick|x]  optional flag, enum value → select menu
 *   [--flag]          optional boolean flag      → confirm
 *   approve|reject    bare enum positional
 *   — description     everything after an em-dash is help text, stripped
 */

import chalk from 'chalk';
import { select, input, confirm } from '@inquirer/prompts';

export interface ArgSpec {
  name: string;
  required: boolean;
  isFlag: boolean;
  flagName?: string; // e.g. '--context'
  boolean?: boolean; // flag with no value
  options?: string[];
  quoted?: boolean;
}

/** Split a spec string into top-level tokens, keeping [..], "..", <..> groups intact. */
function tokenizeSpec(spec: string): string[] {
  const tokens: string[] = [];
  const s = spec.trim();
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') { i++; continue; }
    let depth = 0;
    let inQuote = false;
    let buf = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '"') inQuote = !inQuote;
      else if (c === '[') depth++;
      else if (c === ']') depth = Math.max(0, depth - 1);
      if (c === ' ' && depth === 0 && !inQuote) break;
      buf += c;
      i++;
    }
    if (buf) tokens.push(buf);
  }
  return tokens;
}

function cleanName(raw: string): string {
  return raw.replace(/^[["'<]+/, '').replace(/[\]"'>]+$/, '').replace(/^--/, '').trim();
}

function extractOptions(raw: string): string[] | undefined {
  const inner = raw.replace(/^[["'<]+/, '').replace(/[\]"'>]+$/, '');
  if (inner.includes('|')) {
    const opts = inner.split('|').map(s => s.trim()).filter(Boolean);
    return opts.length > 1 ? opts : undefined;
  }
  return undefined;
}

/** Strip the trailing ` — help text` from an arg hint. */
function stripDescription(hint: string): string {
  const idx = hint.indexOf('—');
  return (idx >= 0 ? hint.slice(0, idx) : hint).trim();
}

function descriptionOf(hint: string): string {
  const idx = hint.indexOf('—');
  return idx >= 0 ? hint.slice(idx + 1).trim() : '';
}

/** Parse an arg-hint spec string into an ordered list of ArgSpecs. */
export function parseSpec(hint: string): ArgSpec[] {
  const main = stripDescription(hint);
  if (!main) return [];
  const tokens = tokenizeSpec(main);
  const specs: ArgSpec[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const optionalOuter = tok.startsWith('[') && tok.endsWith(']');
    const inner = (optionalOuter ? tok.slice(1, -1) : tok).trim();
    if (!inner) continue;

    if (inner.startsWith('--')) {
      const parts = inner.split(/\s+/);
      const flagName = parts[0];
      let valuePart = parts.slice(1).join(' ');
      // `--start <ISO>` (value as a separate, non-bracketed token) — merge it.
      if (!valuePart && !optionalOuter && i + 1 < tokens.length && /^["<]/.test(tokens[i + 1])) {
        valuePart = tokens[++i];
      }
      if (!valuePart) {
        specs.push({ name: cleanName(flagName), required: false, isFlag: true, flagName, boolean: true });
      } else {
        specs.push({
          name: cleanName(flagName),
          required: false,
          isFlag: true,
          flagName,
          options: extractOptions(valuePart),
          quoted: valuePart.includes('"'),
        });
      }
      continue;
    }

    specs.push({
      name: cleanName(inner) || 'arg',
      required: !optionalOuter,
      isFlag: false,
      options: extractOptions(inner),
      quoted: tok.includes('"'),
    });
  }
  return specs;
}

function maybeQuote(value: string, spec: ArgSpec): string {
  if (spec.quoted || /\s/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

/** Thrown by @inquirer on Ctrl+C / Escape — treat as "cancelled". */
function isCancel(e: any): boolean {
  const n = e?.name || '';
  return n === 'ExitPromptError' || n === 'AbortPromptError' || /force closed|cancel/i.test(e?.message || '');
}

/** Prompt for each ArgSpec in order. Returns the assembled arg string, or null if cancelled. */
async function promptSpecs(specs: ArgSpec[]): Promise<string | null> {
  const out: string[] = [];
  for (const sp of specs) {
    try {
      if (sp.isFlag) {
        if (sp.boolean) {
          const yes = await confirm({ message: `Include ${chalk.cyan(sp.flagName!)}?`, default: false });
          if (yes) out.push(sp.flagName!);
          continue;
        }
        if (sp.options) {
          const val = await select<string>({
            message: `${chalk.cyan(sp.flagName!)} ${chalk.dim('(optional)')}`,
            choices: [{ name: chalk.dim('(skip)'), value: '' }, ...sp.options.map(o => ({ name: o, value: o }))],
          });
          if (val) out.push(`${sp.flagName} ${maybeQuote(val, sp)}`);
        } else {
          const val = (await input({ message: `${chalk.cyan(sp.flagName!)} ${chalk.dim('(optional, blank to skip)')}` })).trim();
          if (val) out.push(`${sp.flagName} ${maybeQuote(val, sp)}`);
        }
        continue;
      }

      // Positional.
      if (sp.options) {
        const choices = sp.options.map(o => ({ name: o, value: o }));
        if (!sp.required) choices.unshift({ name: chalk.dim('(skip)'), value: '' });
        // When the positional's "name" is just the enum list (e.g. `a|b|c`), the
        // choices already convey it — ask generically instead of echoing the list.
        const label = sp.name.includes('|') ? 'Select one:' : `Select ${chalk.bold(sp.name)}:`;
        const val = await select<string>({ message: label, choices });
        if (val) out.push(maybeQuote(val, sp));
      } else {
        const label = sp.required
          ? `${chalk.bold(sp.name)}:`
          : `${chalk.bold(sp.name)} ${chalk.dim('(optional, blank to skip)')}:`;
        const val = (await input({ message: label })).trim();
        if (val) out.push(maybeQuote(val, sp));
      }
    } catch (e) {
      if (isCancel(e)) return null;
      throw e;
    }
  }
  return out.join(' ');
}

/**
 * Run the full interactive flow for a command given its SUBCOMMAND_DEFS entries.
 * Returns the argument string to hand the command handler (e.g. `set unrestricted
 * --context coding`), an empty string for a no-arg subcommand, or null if cancelled.
 */
export async function collectArgs(
  cmdName: string,
  subDefs: ReadonlyArray<readonly [string, string]>,
): Promise<string | null> {
  if (!subDefs.length) return '';

  // Single entry whose "name" is actually a positional placeholder (e.g. /research
  // → `"<topic>"`) — there's no subcommand to pick; prompt the whole spec directly.
  if (subDefs.length === 1 && /^["<[]/.test(subDefs[0][0])) {
    const specs = parseSpec(`${subDefs[0][0]} ${subDefs[0][1] || ''}`);
    return promptSpecs(specs);
  }

  let sub: string;
  try {
    sub = await select<string>({
      message: `/${cmdName} ${chalk.dim('—')}`,
      choices: subDefs.map(([name, hint]) => ({
        name: chalk.cyan(name),
        value: name,
        description: descriptionOf(hint) || stripDescription(hint) || undefined,
      })),
    });
  } catch (e) {
    if (isCancel(e)) return null;
    throw e;
  }

  const def = subDefs.find(d => d[0] === sub);
  const specs = def ? parseSpec(def[1] || '') : [];
  if (!specs.length) return sub;

  const argStr = await promptSpecs(specs);
  if (argStr === null) return null;
  return argStr ? `${sub} ${argStr}` : sub;
}
