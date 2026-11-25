/**
 * avatar-autodock.ts — the portrait pane is ON by default.
 *
 * Measured 2026-11-16 (owner: "no avatar in awsh??"): the truecolor portrait pane and
 * its 12 emotion clips + talk frames shipped in assets/, but the pane only docked on
 * `/avatar` or Ctrl+P, so every launch showed the glyph placeholder face ("here",
 * "answering"). These pure helpers decide, at boot, whether to dock it and WHICH
 * character: the persona the owner set in awdesk's cast.json (aither -> aither-v2), so
 * the shell and the desk show the same face.
 *
 * Rendering supports native Kitty / iTerm2 / Sixel pixel graphics with automatic
 * area-averaged 24-bit truecolor half-block fallback (terminal-graphics.ts + portrait.ts).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PortraitCropMode } from './portrait.js';
import type { ProtocolPreference } from './terminal-graphics.js';

/** Dock at boot? Off with AWSH_AVATAR=0, on with AWSH_AVATAR=1, else when the terminal
 *  is wide enough (>= 90 cols) and supports truecolor or native terminal graphics. Pure. */
export function shouldAutoDock(env: NodeJS.ProcessEnv, columns: number): boolean {
  const v = (env.AWSH_AVATAR || '').trim().toLowerCase();
  if (v === '0' || v === 'off') return false;
  if (v === '1' || v === 'on') return true;
  if (!Number.isFinite(columns) || columns < 90) return false;
  const truecolor = /truecolor|24bit/i.test(env.COLORTERM || '')
    || !!env.WT_SESSION
    || !!env.KITTY_WINDOW_ID
    || !!env.GHOSTTY_RESOURCES_DIR
    || !!env.WEZTERM_EXECUTABLE
    || !!env.WEZTERM_PANE
    || env.TERM_PROGRAM === 'vscode'
    || env.TERM_PROGRAM === 'WezTerm'
    || env.TERM_PROGRAM === 'iTerm.app'
    || env.TERM_PROGRAM === 'ghostty';
  return truecolor;
}

/** Extract a persisted protocol preference from ~/.aither/config.json (pure). */
export function avatarProtocolFromConfig(cfg: Record<string, unknown> | null | undefined): ProtocolPreference {
  const raw = typeof cfg?.avatar_protocol === 'string' ? cfg.avatar_protocol.trim().toLowerCase() : '';
  if (raw === 'kitty' || raw === 'sixel' || raw === 'iterm2' || raw === 'halfblock' || raw === 'auto') {
    return raw;
  }
  return 'auto';
}

/** Extract a persisted framing crop mode from ~/.aither/config.json (pure). */
export function avatarCropFromConfig(cfg: Record<string, unknown> | null | undefined): PortraitCropMode {
  const raw = typeof cfg?.avatar_crop === 'string' ? cfg.avatar_crop.trim().toLowerCase() : '';
  return raw === 'full' ? 'full' : 'bust';
}

/** The cast.json path awdesk writes (Roaming\Desk on Windows, ~/.config/Desk elsewhere). */
export function castPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.AWSH_CAST_JSON) return env.AWSH_CAST_JSON;
  if (process.platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Desk', 'cast.json');
  return join(home, '.config', 'Desk', 'cast.json');
}

/** The portrait set matching the desk persona for `agent`, or null. Matches the cast
 *  character id ("aither-90044575", "aither-v2") against the available portrait names by
 *  longest prefix, so a VRM id maps onto its 2D portrait set. Pure. */
export function castPersonaAvatar(cast: unknown, agent: string, available: readonly string[]): string | null {
  if (!cast || typeof cast !== 'object' || !available.length) return null;
  const c = cast as { authors?: Record<string, { character?: string }>; defaults?: { character?: string } };
  const ids = [c.authors?.[agent]?.character, c.authors?.awdesk?.character]
    .filter((x): x is string => typeof x === 'string' && !!x)
    .map((x) => x.toLowerCase());
  for (const id of ids) {
    const hit = available.filter((n) => id === n || id.startsWith(`${n}-`)).sort((a, b) => b.length - a.length)[0];
    if (hit) return hit;
  }
  if (available.includes(agent)) return agent;
  return null;
}

/** Read cast.json and resolve; null on any failure. */
export function personaAvatarFromCast(agent: string, available: readonly string[], file: string = castPath()): string | null {
  try {
    if (!existsSync(file)) return null;
    return castPersonaAvatar(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), agent, available);
  } catch { return null; }
}

/** Which clip plays for a turn phase: thinking (no tokens yet / tool running) plays the
 *  curious clip, so the pane says "working" without a word; otherwise the affect emotion. Pure. */
export function phaseEmotion(phase: 'idle' | 'thinking' | 'talking', affectEmotion: string): string {
  if (phase === 'thinking') return 'curious';
  return affectEmotion || 'neutral';
}
