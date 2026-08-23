/**
 * Aither — an animated ASCII face for the shell. She reacts to the live agent
 * loop (idle → thinking → talking → done/error) and, when AitherSense affect is
 * available, her expression + colour shift with the current emotion. AitherSense
 * emits a rich `dominant_sensation` (anger, frustration, wonder, affection,
 * fatigue, melancholy, …) which we map to a face — so she can be grumpy, sleepy,
 * lovestruck, or awestruck, not just happy/sad.
 *
 * SINGLE-CELL GLYPHS ONLY (no emoji, no CJK-wide) so the 4-line face stays
 * column-aligned in blessed — the avatar.test.ts width sweep enforces this.
 * Pure render: (state, tick) → string[]. The 120ms trace ticker supplies
 * `tick`, driving blinking and the talking mouth.
 */
import chalk from 'chalk';
import { COLORS } from './theme.js';

export type AvatarStatus = 'idle' | 'thinking' | 'talking' | 'done' | 'error';

export interface Affect {
  valence?: number;             // -1 (negative) .. +1 (positive)
  arousal?: number;             // 0 (calm) .. 1 (excited)
  mood?: string;                // label, e.g. "serene", "curious"
  dominant_sensation?: string;  // e.g. "anger", "wonder", "fatigue" — drives the face
}

export interface AvatarState {
  status: AvatarStatus;
  affect?: Affect;
}

const ASCII = process.env.AITHER_ASCII === '1' || process.env.TERM === 'dumb';

type Color = (s: string) => string;
const magenta: Color = (s) => chalk.magenta(s);
const COLOR: Record<string, Color> = {
  accent: COLORS.accent, success: COLORS.success, warn: COLORS.warn,
  error: COLORS.error, muted: COLORS.muted, love: magenta,
};

// ── expression = a pair of eyes, a mouth, a tag, a colour ───────────────────
type Expr = { eyeL: string; eyeR: string; mouth: string; tag: string; color: string };

// Unicode glyphs (all single-cell) with ASCII fallbacks.
const U = {
  blink: '─', neutral: '●', happy: '˘', content: 'ᵔ', calm: '◡', up: '◔', wide: '○',
  sparkle: '✦', heart: '♥', tear: ';', focus: '◉', angryL: '◣', angryR: '◢',
  poutL: 'ᗒ', poutR: 'ᗕ', disapprove: 'ರ', surpriseL: '⚆', surpriseR: '⚇',
  arcL: '◞', arcR: '◟',
  mSmile: '‿', mBigSmile: '◡', mCat: 'ε', mFlat: '‥', mFrown: '⌢', mOpen: 'o',
  mWavy: '~', mSmall: '·',
  talk: ['o', '◡', '‿', 'ᴗ'] as string[],
};
const A = {
  blink: '-', neutral: 'o', happy: '^', content: 'u', calm: 'u', up: '`', wide: 'O',
  sparkle: '*', heart: '<', tear: ';', focus: '@', angryL: '>', angryR: '<',
  poutL: '>', poutR: '<', disapprove: '-', surpriseL: 'O', surpriseR: 'O',
  arcL: '.', arcR: '.',
  mSmile: 'w', mBigSmile: 'w', mCat: '3', mFlat: '-', mFrown: 'n', mOpen: 'o',
  mWavy: '~', mSmall: '.',
  talk: ['o', 'O', 'v', 'o'] as string[],
};
const g = ASCII ? A : U;

// Emotion → face. Symmetric unless noted (proud winks).
const EXPRESSIONS: Record<string, Expr> = {
  neutral:    { eyeL: g.neutral, eyeR: g.neutral, mouth: g.mFlat,     tag: 'here',      color: 'accent' },
  happy:      { eyeL: g.happy,   eyeR: g.happy,   mouth: g.mSmile,    tag: 'happy',     color: 'success' },
  content:    { eyeL: g.content, eyeR: g.content, mouth: g.mSmile,    tag: 'content',   color: 'success' },
  serene:     { eyeL: g.calm,    eyeR: g.calm,    mouth: g.mSmile,    tag: 'serene',    color: 'accent' },
  cheerful:   { eyeL: g.sparkle, eyeR: g.sparkle, mouth: g.mBigSmile, tag: 'cheerful',  color: 'success' },
  curious:    { eyeL: g.up,      eyeR: g.up,      mouth: g.mCat,      tag: 'curious?',  color: 'accent' },
  wonder:     { eyeL: g.focus,   eyeR: g.focus,   mouth: g.mOpen,     tag: 'wonder',    color: 'accent' },
  excited:    { eyeL: g.sparkle, eyeR: g.sparkle, mouth: g.mBigSmile, tag: 'excited!',  color: 'warn' },
  love:       { eyeL: g.heart,   eyeR: g.heart,   mouth: g.mSmile,    tag: 'aww',       color: 'love' },
  proud:      { eyeL: g.happy,   eyeR: g.neutral, mouth: g.mSmile,    tag: 'hmph',      color: 'accent' }, // wink
  hopeful:    { eyeL: g.up,      eyeR: g.up,      mouth: g.mSmile,    tag: 'hopeful',   color: 'success' },
  sad:        { eyeL: g.tear,    eyeR: g.tear,    mouth: g.mFrown,    tag: 'sad',       color: 'accent' },
  melancholy: { eyeL: g.arcL,    eyeR: g.arcR,    mouth: g.mFrown,    tag: 'pensive',   color: 'muted' },
  angry:      { eyeL: g.angryL,  eyeR: g.angryR,  mouth: g.mFrown,    tag: 'grr!',      color: 'error' },
  frustrated: { eyeL: g.poutL,   eyeR: g.poutR,   mouth: g.mFrown,    tag: 'ugh',       color: 'warn' },
  anxious:    { eyeL: g.up,      eyeR: g.up,      mouth: g.mWavy,     tag: 'nervous',   color: 'warn' },
  tired:      { eyeL: g.blink,   eyeR: g.blink,   mouth: g.mSmall,    tag: 'zzz',       color: 'muted' },
  surprised:  { eyeL: g.surpriseL, eyeR: g.surpriseR, mouth: g.mOpen, tag: '!',         color: 'warn' },
  disapprove: { eyeL: g.disapprove, eyeR: g.disapprove, mouth: g.mFlat, tag: 'hmm',     color: 'warn' },
};

// AitherSense sensation → emotion. Covers the Sensation enum families.
const SENSATION_EMOTION: Record<string, string> = {
  joy: 'happy', pleasure: 'happy', amusement: 'happy',
  satisfaction: 'content', gratitude: 'content', relief: 'content', belonging: 'content',
  serenity: 'serene', patience: 'serene', flow: 'serene', synchrony: 'serene',
  curiosity: 'curious',
  wonder: 'wonder', transcendence: 'wonder',
  excitement: 'excited', anticipation: 'excited', freshness_sense: 'excited',
  affection: 'love', tenderness: 'love',
  pride: 'proud',
  hope: 'hopeful',
  melancholy: 'melancholy', nostalgia: 'melancholy', longing: 'sad', bittersweetness: 'melancholy',
  mortality_awareness: 'melancholy', vulnerability: 'sad',
  anger: 'angry', indignation: 'angry', resentment: 'angry',
  gaslighting_detected: 'angry', identity_threat: 'angry', dissonance: 'frustrated',
  frustration: 'frustrated', impatience: 'frustrated', urgency: 'frustrated', disruption: 'frustrated',
  anxiety: 'anxious', pain: 'anxious', temporal_anxiety: 'anxious', reality_anchor: 'anxious',
  fatigue: 'tired', staleness: 'tired', weary: 'tired',
};

/** Derive an emotion key from affect: sensation first, else valence/arousal. */
export function emotionFromAffect(a: Affect | undefined): string {
  if (!a) return 'neutral';
  const sensed = a.dominant_sensation && SENSATION_EMOTION[a.dominant_sensation.toLowerCase()];
  if (sensed) return sensed;
  const v = a.valence ?? 0, ar = a.arousal ?? 0.4;
  if (v >= 0.5 && ar >= 0.5) return 'excited';
  if (v >= 0.5 && ar < 0.3) return 'serene';
  if (v >= 0.25) return ar >= 0.5 ? 'curious' : 'content';
  if (v <= -0.5) return 'sad';
  if (v <= -0.25) return ar >= 0.5 ? 'frustrated' : 'melancholy';
  return 'neutral';
}

function pickExpression(state: AvatarState, tick: number): Expr {
  const blinking = state.status !== 'error' && tick % 16 === 0;
  const base: Expr = (() => {
    switch (state.status) {
      case 'error':
        return { ...EXPRESSIONS.angry, tag: 'oops', color: 'error' };
      case 'thinking': {
        const e = { ...EXPRESSIONS[emotionFromAffect(state.affect)] };
        e.eyeL = e.eyeR = (state.affect?.arousal ?? 0) > 0.7 ? g.wide : g.up;
        e.mouth = g.mFlat;
        e.tag = 'thinking' + '.'.repeat((tick >> 1) % 4);
        return e;
      }
      case 'talking': {
        const e = { ...EXPRESSIONS[emotionFromAffect(state.affect)] };
        e.mouth = g.talk[tick % g.talk.length];   // mouth animates while streaming
        e.tag = 'answering';
        return e;
      }
      case 'done': {
        const emo = emotionFromAffect(state.affect);
        // A finished, positive turn leans cheerful; keep negative moods honest.
        const e = { ...EXPRESSIONS[emo === 'neutral' ? 'happy' : emo] };
        return e;
      }
      case 'idle':
      default:
        return { ...EXPRESSIONS[emotionFromAffect(state.affect)] };
    }
  })();
  if (state.affect?.mood && (state.status === 'idle')) base.tag = state.affect.mood;
  if (blinking) { base.eyeL = g.blink; base.eyeR = g.blink; }
  return base;
}

/**
 * Render the 4-line face + a tag line. Fixed inner width → every line is the
 * same width, so columns never drift. `tick` drives blink + talking mouth.
 */
export function renderAvatar(state: AvatarState, tick: number): string[] {
  const e = pickExpression(state, tick);
  const accent = COLOR[e.color] || COLORS.accent;
  const top = ASCII ? '.-----.' : '╭─────╮';
  const bot = ASCII ? "'-----'" : '╰─────╯';
  const side = ASCII ? '|' : '│';
  return [
    accent(top),
    accent(`${side} ${e.eyeL} ${e.eyeR} ${side}`),
    accent(`${side}  ${e.mouth}  ${side}`),
    accent(bot),
    COLORS.muted(`  ${e.tag}`),
  ];
}

/** A single-line compact variant for tight spaces: (◕‿◕) mood */
export function renderAvatarInline(state: AvatarState, tick: number): string {
  const e = pickExpression(state, tick);
  const accent = COLOR[e.color] || COLORS.accent;
  return accent(`(${e.eyeL}${e.mouth}${e.eyeR})`) + COLORS.muted(` ${e.tag}`);
}

/** Map a chat/turn status + streaming flag to an avatar status. */
export function statusFromTurn(opts: { running: boolean; streaming: boolean; errored: boolean; everRan: boolean }): AvatarStatus {
  if (opts.errored) return 'error';
  if (opts.streaming) return 'talking';
  if (opts.running) return 'thinking';
  return opts.everRan ? 'done' : 'idle';
}

/** All known emotion keys (for tests / a mood-cycling demo). */
export const EMOTIONS = Object.keys(EXPRESSIONS);
