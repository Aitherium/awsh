/**
 * think-filter.ts — strip <think>…</think> from a token STREAM.
 *
 * WHY THIS IS ITS OWN FILE. Reasoning models emit chain-of-thought inline in
 * `content`. The buffered path can strip it with one regex; the streaming path
 * cannot, because a tag arrives SPLIT across SSE chunks ("<thi" then "nk>")
 * often enough that a per-chunk regex leaks the opening tag and then the whole
 * body. Both paths must agree, or what the user sees depends on whether the
 * gateway happened to stream — gateway internals leaking into the answer.
 *
 * The first version of this lived inline in client.ts as ad-hoc index maths. It
 * was wrong twice in a row: it discarded a partial CLOSING tag (so the block
 * never closed and the real answer was swallowed — silence instead of a reply),
 * and its partial-OPENING-tag guard held back ordinary text forever, because
 * `'<think>'.startsWith('')` is true and the empty string matched every tail.
 * Both were found by tests, not by reading it. Hence: one small pure unit with
 * an explicit contract.
 *
 * The rule for a partial tag is the same in both directions and is the whole
 * trick: hold back only the LONGEST SUFFIX of the buffer that is a PROPER
 * PREFIX of the tag. Anything shorter leaks a tag; anything longer stalls real
 * text.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Length of the longest suffix of `s` that is a proper prefix of `tag`.
 * Returns 0 when no suffix could begin the tag — the common case, where the
 * whole buffer is safe to emit.
 */
export function partialTagTail(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/** Stateful across chunks. One instance per stream. */
export class ThinkFilter {
  private buf = '';
  private inThink = false;
  private emitted = false;
  /** Reasoning we dropped. Kept ONLY so a reply that was entirely reasoning
   *  can still say something at flush() -- see the note there. */
  private dropped = '';

  /** Feed one chunk; get back the text that is safe to show now. */
  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      if (!this.inThink) {
        const i = this.buf.indexOf(OPEN);
        if (i !== -1) {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + OPEN.length);
          this.inThink = true;
          continue;
        }
        // No opening tag. Emit everything except a tail that might start one.
        const hold = partialTagTail(this.buf, OPEN);
        out += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      }
      const j = this.buf.indexOf(CLOSE);
      if (j !== -1) {
        this.dropped += this.buf.slice(0, j);
        this.buf = this.buf.slice(j + CLOSE.length);
        this.inThink = false;
        continue;
      }
      // Inside a block: drop it, but keep a tail that might close it.
      const hold = partialTagTail(this.buf, CLOSE);
      this.dropped += this.buf.slice(0, this.buf.length - hold);
      this.buf = this.buf.slice(this.buf.length - hold);
      break;
    }
    if (out) this.emitted = true;
    return out;
  }

  /**
   * Anything still owed at end-of-stream.
   *
   * Two cases, and the second is the important one:
   *  - a held-back partial tag that turned out to be ordinary text;
   *  - a reply that was ENTIRELY reasoning. Emitting nothing there reads as
   *    "it didn't answer" rather than "it answered oddly", so the reasoning is
   *    shown instead. Never trade a messy answer for no answer.
   */
  flush(): string {
    if (!this.inThink && this.buf) {
      const rest = this.buf;
      this.buf = '';
      if (rest) this.emitted = true;
      return rest;
    }
    if (!this.emitted) {
      // The whole reply was reasoning. Show it rather than nothing: an empty
      // answer reads as "it didn't answer", which is strictly less useful and
      // impossible to debug. Never trade a messy answer for no answer.
      const rest = (this.buf + this.dropped).trim();
      this.buf = '';
      this.dropped = '';
      if (rest) { this.emitted = true; return rest; }
    }
    return '';
  }
}
