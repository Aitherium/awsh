/**
 * status-bar-fit.ts — the status row's WIDTH contract.
 *
 * Measured 2026-11-01 from the owner's awsh screenshot: the top row crammed
 * `AI | d-kbjd 30m Enter X402_RECEIVE_ADDRESS_SOLANA | d-ec8a 33m E: is still below
 * its required free space after the reclaim playbook | (+25, 130 open) | adk-daemon up |
 * 1/11 | $0.00/24h | portrait` into one red line and ran off the right edge. What the
 * eye saw was red noise; the one thing that mattered (a waiting ask) was clipped away.
 *
 * So the bar keeps a PREFIX that fits and COUNTS what it could not show — the doctrine's
 * law 4 (cap presentation, never data): nothing is silently truncated, the brand never
 * scrolls away, and `+3` is a promise that three more exist.
 *
 * Width is counted by scanning for ESC, never by a regex: this file is edited through
 * shells as often as an editor, and a literal ESC or a backslash class survives one and
 * not the other (renderer.ts carries the same rule for the same reason).
 */

/** The columns one ` · ` separator costs — the bar's only separator. */
export const VISIBLE_WIDTH = 3;

const ESC = String.fromCharCode(27);

/** Printable width of a string, ignoring colour escapes. */
export function visibleWidth(s: string): number {
  let n = 0;
  let inEscape = false;
  for (const ch of s) {
    if (ch === ESC) { inEscape = true; continue; }
    if (inEscape) { if (ch === 'm') inEscape = false; continue; }
    n++;
  }
  return n;
}

const widthOf = (seg: { plain: string; text?: string }): number =>
  visibleWidth(seg.text ?? seg.plain);

/**
 * Keep the segments that FIT, drop the rest from the tail, and say how many went.
 *
 * The first segment is the brand and is always kept: its position is how the row is
 * recognised at a glance, so a bar whose left edge moves is a bar nobody can skim.
 * Everything after it is added only while the running width stays inside `columns`.
 */
export function fitSegments<T extends { key: string; plain: string; text?: string }>(
  segs: readonly T[],
  columns: number,
  sep = ' · ',
): { kept: T[]; hidden: number } {
  if (!segs.length) return { kept: [], hidden: 0 };
  const budget = Math.max(0, Math.floor(Number(columns) || 0));
  const sepW = visibleWidth(sep);
  const kept: T[] = [segs[0]];
  let width = widthOf(segs[0]);
  for (let i = 1; i < segs.length; i++) {
    const add = sepW + widthOf(segs[i]);
    if (width + add > budget) break;
    kept.push(segs[i]);
    width += add;
  }
  return { kept, hidden: segs.length - kept.length };
}

/**
 * One line of text, ellipsized to `columns` printable cells.
 *
 * Colour is preserved: the ESC runs are copied through and the visible count only
 * advances on real glyphs, so a fitted string keeps its styling instead of turning
 * into a grey smear (which is what slicing a coloured string in JS does).
 *
 * A CLIPPED coloured string is closed with a reset before returning: the loop breaks
 * before the original's trailing `\x1b[0m`, so without this the terminal stays painted
 * in the last colour and bleeds it into the prompt / next row. Zero visible width.
 */
const RESET = `${ESC}[0m`;

export function fitText(text: string, columns: number): string {
  const budget = Math.max(1, Math.floor(Number(columns) || 1));
  const shown = String(text ?? '');
  if (visibleWidth(shown) <= budget) return shown;
  let out = '';
  let n = 0;
  let inEscape = false;
  let sawEscape = false;
  for (const ch of shown) {
    if (ch === ESC) { inEscape = true; sawEscape = true; out += ch; continue; }
    if (inEscape) { out += ch; if (ch === 'm') inEscape = false; continue; }
    if (n >= budget - 1) { out += '…'; break; }
    out += ch;
    n++;
  }
  return sawEscape ? out + RESET : out;
}
