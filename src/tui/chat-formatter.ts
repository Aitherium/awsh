/**
 * Chat pane formatter: markdown-aware answer rendering with reflow to pane width.
 * Turn frames: user line, answer body, footer with metrics.
 * Follow-up chips: rendered on separate lines with accent indexing.
 */
import chalk from 'chalk';
import type { SSEEvent } from '../client.js';

// Simple markdown rendering without external deps — marked-terminal has
// async issues in this context. Hand-roll basic markdown support instead.

export interface ChatFormatterOpts {
  paneWidth?: number;  // for reflow
}

export interface FormattedTurn {
  header: string;        // "╭─ aither · 02:41" — opens the ASSISTANT's frame
  body: string[];        // answer lines
  footer: string;        // metrics footer
  followups: string[];   // follow-up chips
}

/** Opening fence: ``` plus an optional info string, nothing else. */
const FENCE_OPEN = /^\s*```[^`]*$/;
/** A bare closing fence. */
const FENCE_CLOSE = /^\s*```\s*$/;

/**
 * If `text` is exactly one markdown fence wrapping the whole reply, return its
 * inner lines byte-for-byte; otherwise return `text` unchanged.
 *
 * Measured 2026-09-12. A model reply that IS one fenced block is usually a
 * COMMAND the user is meant to copy, so it must survive verbatim — never
 * reflowed, never summarised, never re-indented. Callers that only render (the
 * omnibox stdout write, job previews) use this to drop the delimiters without
 * touching the body.
 */
export function stripWrappingFence(text: string): string {
  const lines = text.split('\n');
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first++;
  let last = lines.length - 1;
  while (last > first && lines[last].trim() === '') last--;
  if (first >= last) return text;
  if (!FENCE_OPEN.test(lines[first])) return text;
  if (!FENCE_CLOSE.test(lines[last])) return text;
  return lines.slice(first + 1, last).join('\n');
}

/**
 * Drop every fence DELIMITER line, keeping the bodies and every other line.
 *
 * For raw printers that show text verbatim and never render markdown -- job
 * output, an inline preview -- where a delimiter is pure noise the model wrote
 * for a renderer that is not present.
 *
 * Deliberately NOT `stripWrappingFence`: that one only fires when the WHOLE
 * text is a single fence, and job output routinely carries trace lines above
 * the block, so it stripped nothing at all there. Measured on the built dist --
 * the delimiters were still emitted, which is exactly the inert-fix shape.
 */
export function stripFenceDelimiters(text: string): string {
  return text
    .split('\n')
    .filter(line => !FENCE_OPEN.test(line) && !FENCE_CLOSE.test(line))
    .join('\n');
}

/**
 * Split `text` into alternating prose / fenced runs. A fenced run's `text` is
 * the block's INNER lines — the delimiters are dropped, never emitted.
 *
 * This exists because the two markdown passes in this file actively mangle a
 * fence, and neither could be fixed by tightening the other:
 *   - the inline code-span rule is `` `([^`]+)` `` , which happily matches
 *     "`powershell\n…\n`" — one delimiter from each end — and dims the block;
 *   - `reflowText` splits paragraphs on blank lines, and a fence has none
 *     inside it, so the whole command fell to `split(/\s+/)` and printed as ONE
 *     run-on line with its newlines replaced by spaces.
 * Keeping fences out of both passes is what makes them independent.
 */
function splitFences(text: string): Array<{ fence: boolean; text: string }> {
  const out: Array<{ fence: boolean; text: string }> = [];
  let buf: string[] = [];
  let fence = false;
  const flush = (): void => {
    if (buf.length) out.push({ fence, text: buf.join('\n') });
    buf = [];
  };
  for (const line of text.split('\n')) {
    if (!fence && FENCE_OPEN.test(line)) {
      flush();
      fence = true;   // opening delimiter consumed, not emitted
      continue;
    }
    if (fence && FENCE_CLOSE.test(line)) {
      flush();
      fence = false;  // closing delimiter consumed, not emitted
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

export class ChatFormatter {
  private paneWidth: number;

  constructor(opts?: ChatFormatterOpts) {
    this.paneWidth = opts?.paneWidth || 80;
  }

  /**
   * Track the live OUTPUT pane inner width. MUST be kept in sync with the pane
   * (initial + on resize) — a stale width wider than the pane makes blessed's
   * own wrap:true re-wrap every line into ragged orphan lines.
   */
  public setPaneWidth(width: number): void {
    if (Number.isFinite(width) && width >= 20) this.paneWidth = Math.floor(width);
  }

  /**
   * Format an answer with markdown rendering and line reflow.
   *
   * Fenced runs are rendered on their own path and never enter the inline
   * markdown passes or the word-wrapper — see `splitFences`.
   */
  public formatAnswer(content: string): string[] {
    if (!content) return [];

    const out: string[] = [];
    for (const seg of splitFences(content)) {
      if (seg.fence) out.push(...this.emitPreformatted(seg.text));
      else out.push(...this.reflowText(this.inlineMarkdown(seg.text)));
    }
    return out;
  }

  /** Bold / inline-code / heading passes. NEVER applied inside a fence. */
  private inlineMarkdown(text: string): string {
    return text
      // Bold: **text** -> text (could colorize with chalk.bold)
      .replace(/\*\*([^*]+)\*\*/g, chalk.bold('$1'))
      // Code spans: `text` -> text (could colorize with chalk.inverse)
      .replace(/`([^`]+)`/g, chalk.dim('$1'))
      // Headers: # text -> text
      .replace(/^#+\s+(.+)$/gm, chalk.bold('$1'));
  }

  /**
   * Emit preformatted text verbatim: margin added, content untouched.
   *
   * Deliberately NOT width-wrapped. A fenced block is a command the user
   * copies, so reflowing it would change what they run — the one thing worse
   * than a long line. The pane's own wrap handles the display.
   */
  private emitPreformatted(text: string): string[] {
    return text.split('\n').map(line => (line.trim() === '' ? '' : '  ' + line));
  }

  /** Visible column count — strip ANSI SGR escapes so invisible color codes
   *  don't inflate the measured width and wrap lines early. */
  private visibleLen(s: string): number {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '').length;
  }

  /**
   * Reflow text to pane width, respecting word boundaries.
   * Leaves 2-column margin on left for visual breathing room.
   */
  private reflowText(text: string): string[] {
    const lines: string[] = [];
    const paragraphs = text.split('\n\n');
    const margin = '  ';  // 2-column left margin for indentation
    const availWidth = Math.max(20, this.paneWidth - 2);  // account for the margin

    for (const para of paragraphs) {
      if (para.trim() === '') {
        lines.push('');
        continue;
      }

      // If it's a code block or list, preserve formatting + add margin
      if (para.startsWith('  ') || para.startsWith('- ') || para.startsWith('* ')) {
        for (const line of para.split('\n')) {
          lines.push(margin + line);
        }
        continue;
      }

      // Word-wrap prose with margin. Measure VISIBLE width (strip ANSI SGR): the markdown
      // pass above wraps bold/dim/code spans in escape codes that add ~8-18
      // invisible chars per span, so counting raw .length wrapped lines far too
      // early into a ragged column.
      const words = para.split(/\s+/);
      let currentLine = '';

      for (const word of words) {
        const candidate = currentLine ? currentLine + ' ' + word : word;
        if (this.visibleLen(candidate) > availWidth && currentLine) {
          lines.push(margin + currentLine);
          currentLine = word;
        } else {
          currentLine = candidate;
        }
      }

      if (currentLine) lines.push(margin + currentLine);
      lines.push('');  // paragraph break
    }

    return lines.filter((l, i) => i === lines.length - 1 || l !== '');  // trim trailing blank
  }

  /**
   * Format a turn frame: header, answer body, footer, follow-ups.
   * Ensures proper spacing to prevent collision with metadata.
   */
  public formatTurn(userInput: string, answer: string, metadata: {
    agent?: string;
    model?: string;
    tokensUsed?: number;
    durationMs?: number;
  }): FormattedTurn {
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Opens the ASSISTANT frame — `answer` is the model's text. This said 'you',
    // so every answer rendered under a "you" header (the user's own prompt is
    // echoed separately by the REPL as "› <prompt>").
    const header = `${chalk.dim('╭─')} ${chalk.bold('aither')} ${chalk.dim('·')} ${chalk.dim(timeStr)}`;

    const body = this.formatAnswer(answer);

    // Build footer with metadata — ONLY if we have metrics to show
    let footer = '';
    const footerParts: string[] = [];
    if (metadata.agent) footerParts.push(metadata.agent);
    if (metadata.model) footerParts.push(metadata.model);
    if (metadata.tokensUsed) footerParts.push(`${metadata.tokensUsed} tok`);
    if (metadata.durationMs) footerParts.push(`${(metadata.durationMs / 1000).toFixed(1)}s`);

    if (footerParts.length > 0) {
      // Add blank line before footer for separation if body has content
      if (body.length > 0 && body[body.length - 1] !== '') {
        body.push('');  // spacing before footer
      }
      footer = `${chalk.dim('╰─')} ${chalk.dim(footerParts.join(' · '))}`;
    }

    return { header, body, footer, followups: [] };
  }

  /**
   * Format follow-up chips.
   */
  public formatFollowups(followups: string[]): string[] {
    if (!followups.length) return [];
    const lines: string[] = [chalk.dim('  Next →')];
    followups.forEach((text, i) => {
      lines.push(`  ${chalk.cyan(`[${i + 1}]`)} ${chalk.dim(text)}`);
    });
    return lines;
  }
}

/**
 * Factory function.
 */
export function createChatFormatter(opts?: ChatFormatterOpts): ChatFormatter {
  return new ChatFormatter(opts);
}
