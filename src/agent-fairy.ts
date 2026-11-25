/**
 * agent-fairy.ts — the agent's fairy in the terminal: its name in its own colour.
 *
 * Owner, 2026-11-09: agent fairies follow the owner from the desktop to the terminal to
 * the browser. The desk fairy (Aitherium/awdesk agent-fairy.cjs), the aitherium.com web
 * fairy (AitherVeil agent-fairy.ts) and the Discord bots wear one palette,
 * AitherOS/config/agent-fairies.json; awsh carries it verbatim in
 * agent-fairies.generated.ts (check_agent_fairy_palette.py AFP001 fails on drift).
 *
 * Colour is plain 24-bit ANSI (ESC[38;2;r;g;bm), and only when it can land: NO_COLOR set
 * (https://no-color.org), TERM=dumb, or a stream that is not a TTY gets the bare text.
 *
 * PURE apart from reading the env/stream it is handed: no IO, no chalk (chalk's own
 * level detection would ignore the palette's exact hex on a 256-colour guess).
 */

import { AGENT_FAIRIES } from './agent-fairies.generated.js';

export interface TerminalFairy {
  /** Palette key ("lyra"), or the default agent's key for an unknown name. */
  agent: string;
  /** Display name ("Lyra"). An unknown agent keeps its own name, in the default colour. */
  label: string;
  /** #rrggbb from the palette. */
  color: string;
  /** True when the name resolved to a palette agent. */
  known: boolean;
}

interface PaletteEntry { label?: string; color?: string }

const HEX_RE = /^#[0-9a-f]{6}$/i;
const AGENTS = AGENT_FAIRIES.agents as Record<string, PaletteEntry>;
const ALIASES = AGENT_FAIRIES.aliases as Record<string, string>;
const DEFAULT_KEY: string = AGENT_FAIRIES.default;

/** The fairy glyph. One column wide in every terminal font that has it. */
export const FAIRY_GLYPH = '✦';

/** "Lyra", "@demi", "aither-demiurge" -> a palette key, or '' when none matches. */
export function normalizeAgent(name: unknown): string {
  const raw = String(name ?? '').trim().toLowerCase().replace(/^@/, '');
  if (!raw) return '';
  const direct = ALIASES[raw] || raw;
  if (AGENTS[direct]) return direct;
  for (const word of raw.split(/[^a-z0-9]+/).filter(Boolean)) {
    const key = ALIASES[word] || word;
    if (AGENTS[key]) return key;
  }
  return '';
}

/** The fairy for an agent name. Unknown/empty -> the default agent's colour. */
export function fairyFor(name: unknown): TerminalFairy {
  const key = normalizeAgent(name);
  const entry = AGENTS[key || DEFAULT_KEY] || {};
  const color = HEX_RE.test(String(entry.color || '')) ? String(entry.color).toLowerCase() : '#38bdf8';
  const own = String(name ?? '').trim().replace(/^@/, '').slice(0, 40);
  return {
    agent: key || DEFAULT_KEY,
    label: key ? String(entry.label || key) : (own || String(entry.label || DEFAULT_KEY)),
    color,
    known: Boolean(key),
  };
}

/** Whether colour can be written to this stream (NO_COLOR, TERM=dumb, non-TTY -> no). */
export function colorEnabled(
  stream: { isTTY?: boolean } | undefined = process.stdout,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if ((env.TERM || '').toLowerCase() === 'dumb') return false;
  return Boolean(stream && stream.isTTY);
}

/** "#8b5cf6" -> "\x1b[38;2;139;92;246m". */
export function truecolor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/**
 * "✦ Lyra" in Lyra's violet (reset to the default foreground after), or the bare
 * "✦ Lyra" when colour is off.
 */
export function fairyTag(name: unknown, opts: { color?: boolean } = {}): string {
  const f = fairyFor(name);
  const text = `${FAIRY_GLYPH} ${f.label}`;
  const useColor = opts.color ?? colorEnabled();
  return useColor ? `${truecolor(f.color)}${text}\x1b[39m` : text;
}
