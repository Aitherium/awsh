/**
 * neo-blessed 3-pane surface for AitherShell.
 *
 *   ┌─ output (100% until there IS trace) ────┐
 *   │ answer streams here                     │
 *   ├─────────────────────────────────────────┤
 *   │ status line                             │
 *   ├─────────────────────────────────────────┤
 *   │ message > ▌                             │
 *   └─────────────────────────────────────────┘
 *
 * …then the split appears on the first trace line:
 *
 *   ┌─ output (≈60%) ───────┬─ trace (≈40%) ─┐
 *   │ answer streams here    │ live pipeline  │
 *   │ (independently scroll) │ telemetry      │
 *   └────────────────────────┴────────────────┘
 *
 * The trace pane starts HIDDEN: reserving 40% of a wide terminal for an EMPTY
 * pane left a huge dead zone at boot. It auto-reveals when there is real trace
 * content (revealTrace), and an explicit Ctrl+T always wins after that.
 *
 * OUTPUT and TRACE each own a real scroll buffer (mouse wheel + PageUp/Down),
 * so long output is never "eaten" — the bug the old DECSTBM SteeringBar caused.
 */
import { createRequire } from 'node:module';
import chalk from 'chalk';
// Side-effecting: corrects neo-blessed's emoji cell widths BEFORE any screen is
// built. Without it, one emoji in an answer scrambles the rest of that line
// See wide-chars.ts for the measurement and why a headless repro
// cannot see it.
import './wide-chars.js';

const nodeRequire = createRequire(import.meta.url);
const blessed: any = nodeRequire('neo-blessed');

/** The trace pane is declared `left: '60%'`; the layout maths must agree with that. */
export const TRACE_LEFT_FRACTION = 0.6;
/** Minimum columns the trace pane keeps when an avatar is docked beside it. */
export const MIN_TRACE_COLS = 28;

export interface AvatarLayout {
  /** Columns the avatar may occupy (clamped). */
  avatarCols: number;
  /** Value for the trace box's `right` offset, so it stops before the avatar. */
  traceRight: number;
  /** 1-based terminal column the avatar starts painting at (matches paintAvatar). */
  avatarStartCol: number;
  /** Columns the trace pane is left with. */
  traceCols: number;
}

/**
 * Where the docked avatar goes, and how much the trace pane must give up for it.
 *
 * Pure so the non-overlap invariant is testable — it is not otherwise, because the avatar is
 * painted RAW at absolute terminal coordinates (blessed downsamples 24-bit truecolor, which
 * is why this pane bypasses it) and blessed therefore cannot lay out around it. Before this
 * existed, the avatar was painted at `cols - w - 1` down the full pane height with no
 * reservation at all, i.e. directly on top of the trace pane: half-blocks and trace text
 * ended up interleaved in the same rows, which read as a corrupted terminal.
 */
export function avatarLayout(
  screenCols: number,
  requestedAvatarCols: number,
  minTraceCols: number = MIN_TRACE_COLS,
): AvatarLayout {
  const cols = Math.max(1, Math.floor(screenCols) || 1);
  const traceLeft = Math.floor(cols * TRACE_LEFT_FRACTION);
  const region = Math.max(0, cols - traceLeft);
  // Leave the trace its minimum, plus 1 column of gutter between the two.
  const room = region - minTraceCols - 1;
  const avatarCols = Math.max(0, Math.min(Math.floor(requestedAvatarCols), room));
  if (avatarCols <= 0) {
    // Too narrow to show both — no avatar, trace keeps everything.
    return { avatarCols: 0, traceRight: 0, avatarStartCol: cols, traceCols: region };
  }
  const traceRight = avatarCols + 1;
  return {
    avatarCols,
    traceRight,
    avatarStartCol: Math.max(1, cols - avatarCols),
    traceCols: region - traceRight,
  };
}

export interface PickerItem { label: string; value: string; description?: string; separator?: boolean }

export interface TuiSurface {
  screen: any;
  input: any;
  /** Append raw streamed text (may contain partial lines / ANSI) to OUTPUT. */
  appendOutput(text: string): void;
  /** Append a finished line to OUTPUT (adds its own newline). */
  outputLine(line: string): void;
  /** Current OUTPUT length — a checkpoint for replaceOutputFrom (markdown render). */
  markCheckpoint(): number;
  /** Replace OUTPUT content from a checkpoint onward (used to swap streamed text for rendered markdown). */
  replaceOutputFrom(offset: number, text: string): void;
  /** Prepend text to the TOP of OUTPUT, keeping the viewport anchored (relay scrollback). */
  prependOutput(text: string): void;
  /** Append one line to the TRACE pane (into the current turn thread). */
  traceLine(line: string): void;
  /** Start a new collapsible trace thread for a user turn (collapses prior ones). */
  startTraceTurn(label: string): void;
  /** Mark the current trace thread done/error and stamp its duration in the header. */
  finishTraceTurn(status: 'done' | 'error'): void;
  /** Set the one-line STATUS strip (transient messages: working…, aborted, toggles). */
  setStatus(text: string): void;
  /** Set the PERSISTENT top status bar from pre-styled clickable segments. Each
   *  segment's `key` is handed back to onStatusAction when the user clicks it. */
  setStatusBar(segments: { key: string; text: string; plain: string }[]): void;
  /** Relay mode: set the trace pane's label + raw content (the participant roster). */
  setTracePanel(label: string, lines: string[]): void;
  /** Current trace pane inner width (for live timeline renders); optional. */
  getTraceWidth?(): number;
  /** Current OUTPUT pane inner text width — the width the answer must reflow to
   *  so blessed's own wrap:true never RE-wraps it into ragged orphan lines. */
  getOutputWidth?(): number;
  /** Sync the row→node map from a live timeline render (click handling); optional. */
  setTraceRowToNodeMap?(map: Map<number, any>): void;
  /** Set the output pane's label (e.g. the active relay channel). */
  setOutputLabel(label: string): void;
  /** Clear both content panes. */
  clearPanes(): void;
  /** Show/hide the TRACE pane (OUTPUT widens to fill). */
  toggleTrace(): void;
  /** Stash the suggested follow-ups from the last turn so a bare digit in the
   *  input box can expand to "send the Nth follow-up". Cleared when consumed. */
  setPendingFollowups(items: string[]): void;
  /** The currently-stashed follow-ups (empty if none / already consumed). */
  getPendingFollowups(): string[];
  /** Coalesced repaint. */
  render(): void;
  /** Focus the input box for typing. */
  focusInput(): void;
  /** Tear down the screen and restore the terminal. */
  destroy(): void;
  /** Whether the command picker overlay is open (suppresses chat input). */
  pickerOpen(): boolean;
  /** Show a filterable command picker; resolves with the chosen value or null. */
  showPicker(title: string, items: PickerItem[], initialFilter?: string): Promise<string | null>;
  /** Show a full-screen scrollable document viewer over pre-rendered lines
   *  (markdown/code/text). Resolves when the user closes it (q/Esc). */
  showViewer(title: string, lines: string[]): Promise<void>;
  /** Update the content of an open viewer (live polling). No-op if viewer not open. */
  updateViewer?(lines: string[]): void;
  /** Show a full-screen multi-line text editor seeded with `initialText`.
   *  `onSave(text)` persists and returns an error string (or null on success).
   *  Resolves when the user closes the editor (Esc/Ctrl+Q). */
  showEditor(title: string, initialText: string,
             onSave: (text: string) => Promise<string | null>): Promise<void>;
  /**
   * Suspend the blessed screen, run `fn` on the REAL terminal (so command
   * handlers' console.log / ora spinners / @inquirer prompts all work and don't
   * corrupt the TUI), wait for a keypress, then restore the TUI. This is how
   * `/commands` (including interactive ones like /login) run inside the TUI.
   */
  runDetached(label: string, fn: () => Promise<void> | void): Promise<void>;
  /** Set the timeline instance (new-trace only). Called after renderer is created. */
  setTimeline(timeline: any): void;
  /** Animate portrait frames on the RAW terminal (bypasses blessed, which
   *  downsamples 24-bit truecolor to its 16/256 palette). Any key closes. */
  showPortraitFrames(frames: string[][], intervalMs?: number): Promise<void>;
  /** Toggle a PERSISTENT truecolor avatar pane painted raw in the top-right corner
   *  (opt-in; repaints after each blessed render + on a frame timer). Pass frames to
   *  enable, null/[] to disable. Returns the new on/off state. Never throws. */
  setAvatarPane(frames: string[][] | null, opts?: { isSpeaking?: () => boolean; talkFrames?: string[][] }): boolean;
  /** Widest avatar (in columns) that can be docked without squeezing the trace pane
   *  below a readable width. Render frames at MOST this wide — the avatar is painted raw
   *  over the terminal, so anything wider silently overwrites trace content. */
  maxAvatarCols(): number;
}

export interface TuiScreenOpts {
  title?: string;
  onSubmit: (line: string) => void;
  onInterrupt: () => void;
  onHistory?: (dir: 'up' | 'down') => string | null;
  /** Tab pressed: given the current input, return a replacement value or null. */
  onTab?: (value: string) => string | null;
  /** Slash pressed on an empty input line → open the command picker. */
  onSlash?: () => void;
  /** Fired on each printable keystroke (debounce + use for relay typing). */
  onType?: () => void;
  /** Fired when the OUTPUT pane is scrolled to the top (relay scrollback). */
  onScrollTop?: () => void;
  /** Open a live overlay (Ctrl+F flame · Ctrl+N neurons · Ctrl+R reasoning · Ctrl+A affect · Ctrl+P portrait · Ctrl+K graph · Ctrl+S sessions · Ctrl+O storage). */
  onOverlay?: (kind: 'flame' | 'neurons' | 'reasoning' | 'affect' | 'portrait' | 'graph' | 'sessions' | 'room' | 'storage') => void;
  /** A segment of the persistent status bar was clicked (its `key`). */
  onStatusAction?: (key: string) => void;
  /** Timeline instance for new trace rendering (when AITHER_NEW_TRACE=1). */
  timeline?: any;
}

export function createTuiScreen(opts: TuiScreenOpts): TuiSurface {
  // Load new-trace dependencies (flag-gated)
  let COLORS_imported: any = null;
  let showToolResultViewerFn: any = null;
  const useNewTrace = process.env.AITHER_NEW_TRACE !== '0';

  if (useNewTrace) {
    try {
      const themeModule = nodeRequire('./theme.js');
      COLORS_imported = themeModule.COLORS;
      const toolViewerModule = nodeRequire('./tool-result-viewer.js');
      showToolResultViewerFn = toolViewerModule.showToolResultViewer;
    } catch (e) {
      // Silently fall back if imports fail
      process.env.AITHER_TRACE_VERBOSE && console.error('Failed to load new-trace modules:', e);
    }
  }

  // Force SGR (1006) mouse reporting BEFORE the screen (and its lazy
  // program.enableMouse()) initialises. neo-blessed picks the mouse mode purely
  // from $TERM: for xterm-256color it enables vt200Mouse + utfMouse (1005) but
  // NOT SGR. Windows Terminal doesn't implement UTF-8 mouse (1005), so the raw
  // high bytes get UTF-8-decoded and the X10 coordinate parse corrupts/drops the
  // event — which is why mouse-wheel scroll and click-to-toggle-thread did
  // nothing. SGR is pure ASCII (no encoding ambiguity), universally supported,
  // and the input parser already decodes it. BLESSED_FORCE_MODES is blessed's
  // own escape hatch and is read at enableMouse() time. vt200Mouse(1000) reports
  // button press/release + wheel — all we need; we skip cell/all-motion to avoid
  // a mousemove event storm.
  if (!process.env.BLESSED_FORCE_MODES) {
    process.env.BLESSED_FORCE_MODES = 'SGRMOUSE=1,VT200MOUSE=1';
  }

  const screen = blessed.screen({
    smartCSR: true, fullUnicode: true, mouse: true,
    title: opts.title || 'AitherShell', autoPadding: true, warnings: false,
  });
  // Belt-and-suspenders: guarantee mouse reporting is on even if no element's
  // newListener happened to trigger it first. Idempotent; re-reads the env modes.
  try { screen.program.enableMouse(); } catch { /* terminal may not support it */ }

  const paneBottom = 4;

  // Determine pane border colors based on new-trace flag
  const outputBorderColor = useNewTrace && COLORS_imported ? 'cyan' : 'cyan';
  const traceBorderColor = useNewTrace && COLORS_imported ? 'gray' : 'gray';
  const inputBorderColor = useNewTrace && COLORS_imported ? 'grey' : 'yellow';  // Default: muted, on focus: accent

  // Persistent, compact, CLICKABLE fleet HUD across the very top row. The status
  // picture lives here — not dumped into the scrolling output pane where it bleeds
  // into the conversation. Click a segment → onStatusAction(key).
  const statusBar = blessed.box({
    parent: screen, top: 0, left: 0, right: 0, height: 1, tags: false, mouse: true,
    style: { bg: '#1e2a44', fg: '#c8dcf0' },  // dark slate-blue HUD strip with light text for contrast
  });

  const output = blessed.box({
    parent: screen, top: 1, left: 0, width: '100%', bottom: paneBottom,
    label: ' output ', border: 'line', tags: false,
    scrollable: true, alwaysScroll: true, keys: true, mouse: true,
    scrollbar: { ch: ' ', inverse: true }, wrap: false,  // don't re-wrap already-formatted lines
    style: { border: { fg: outputBorderColor }, label: { fg: outputBorderColor } },
  });

  // TRACE pane: per-turn collapsible threads. Each user turn is its own group;
  // starting a new turn auto-collapses older ones into a one-line header so the
  // pane reads as a running history you can expand. Managed as a manual buffer
  // (not blessed.log) so we control the collapse rendering + click toggling.
  interface TraceTurn {
    label: string; lines: string[]; collapsed: boolean;
    status: 'running' | 'done' | 'error'; startedAt: number; durationMs?: number;
  }
  const traceTurns: TraceTurn[] = [];
  // Rendered-line-index → turn-index, for click-to-toggle on header rows.
  let traceHeaderRows: Map<number, number> = new Map();
  let userPinnedTrace = false;
  // New-trace: store rowToNodeMap from timeline renders
  let traceRowToNodeMap: Map<number, any> = new Map();
  let lastToolDetail: any = null;  // Cache for 'e' key binding

  const trace = blessed.box({
    parent: screen, top: 1, left: '60%', right: 0, bottom: paneBottom,
    label: ' trace ', border: 'line', tags: false,
    scrollable: true, alwaysScroll: true, wrap: false,  // trace lines are pre-formatted
    keys: true, mouse: true, scrollbar: { ch: ' ', inverse: true },
    style: { border: { fg: traceBorderColor }, label: { fg: traceBorderColor } },
  });

  const status = blessed.box({
    parent: screen, bottom: 3, left: 0, right: 0, height: 1, tags: false,
    // Readable WITHOUT shouting. This was `bg: 'cyan'` + black text — a neon slab
    // across the full width that dominated the whole screen (owner: "it's ugly").
    // That was an over-correction from the previous dim-gray-on-black, which was
    // nearly invisible. A dark slate strip with light text is legible and matches
    // the top HUD bar (#1e2a44), so the two chrome rows read as ONE frame.
    style: { fg: '#c8dcf0', bg: '#1e2a44' },
  });

  // Display-only box — input is driven manually (see onKey below), NOT via
  // blessed's readInput, which double-delivers keys to the element on this terminal.
  const input = blessed.box({
    parent: screen, bottom: 0, left: 0, right: 0, height: 3,
    label: ' message ', border: 'line', tags: false, padding: 0,
    style: {
      border: { fg: 'grey' },
      label: { fg: 'grey' },
      focus: { border: { fg: 'cyan' }, label: { fg: 'cyan' } },  // cyan on focus
    },
  });

  // ── OUTPUT streaming buffer + scroll pinning ───────────────────
  let outputBuf = '';
  let userPinnedOutput = false;
  let dirty = false;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;

  function atBottom(el: any): boolean {
    try { return el.getScrollPerc() >= 99; } catch { return true; }
  }
  function atTop(el: any): boolean {
    try { return el.getScrollPerc() <= 1; } catch { return false; }
  }
  function flush(): void {
    renderTimer = null;
    // NOTE: flush() runs in a setTimeout (timer) context — it is NOT inside the
    // stream for-await try/catch. A throw from any blessed call here would escape
    // as an uncaughtException → the global crash reporter calls process.exit(1) →
    // the whole TUI dies mid-turn (observed: long grounded follow-up renders
    // intermittently throw under fullUnicode). Swallow render faults so a single
    // bad repaint never tears the session down; the next scheduleRender recovers.
    try {
      if (dirty) {
        // Preserve the user's scroll position across streamed appends: setContent
        // resets the view, so when the user has scrolled up (pinned) we restore
        // their top line instead of yanking them to the bottom on every token.
        const base = output.childBase || 0;
        output.setContent(outputBuf);
        if (!userPinnedOutput) output.setScrollPerc(100);
        else { try { output.scrollTo(base); } catch { /* */ } }
        dirty = false;
      }
      screen.render();
    } catch { /* transient blessed repaint fault — recovered on next render */ }
  }
  function scheduleRender(): void { if (!renderTimer) renderTimer = setTimeout(flush, 1000 / 30); }

  function appendOutput(text: string): void {
    if (!text) return;
    outputBuf += text; dirty = true; scheduleRender();
  }
  function outputLine(line: string): void {
    appendOutput((outputBuf && !outputBuf.endsWith('\n') ? '\n' : '') + line + '\n');
  }
  /** Prepend text to the TOP of the output (relay scrollback). Keeps the viewport
   *  anchored by shifting scroll down by the number of added lines, so older
   *  history loading-in doesn't make the visible content jump. */
  function prependOutput(text: string): void {
    if (!text) return;
    const t = text.endsWith('\n') ? text : text + '\n';
    const addedLines = (t.match(/\n/g) || []).length;
    outputBuf = t + outputBuf;
    dirty = true;
    try {
      output.setContent(outputBuf);
      output.scrollTo((output.childBase || 0) + addedLines);
      userPinnedOutput = !atBottom(output);
    } catch { /* */ }
    scheduleRender();
  }
  function markCheckpoint(): number { return outputBuf.length; }
  let pendingFollowups: string[] = [];
  function setPendingFollowups(items: string[]): void { pendingFollowups = Array.isArray(items) ? items.slice(0, 9) : []; }
  function getPendingFollowups(): string[] { return pendingFollowups; }
  function replaceOutputFrom(offset: number, text: string): void {
    if (offset < 0 || offset > outputBuf.length) return;
    outputBuf = outputBuf.slice(0, offset) + text; dirty = true;
    clearRegion(output);  // markdown render may be shorter than the streamed text — blank stale tail
    scheduleRender();
  }
  function _turnHeader(t: TraceTurn): string {
    const arrow = t.collapsed ? '▸' : '▾';
    const icon = t.status === 'done' ? chalk.green('✓')
      : t.status === 'error' ? chalk.red('✗') : chalk.yellow('⚡');
    const dur = t.durationMs != null ? chalk.dim(`  ${(t.durationMs / 1000).toFixed(1)}s`)
      : t.collapsed && t.lines.length ? chalk.dim(`  (${t.lines.length})`) : '';
    return `${chalk.cyan(arrow)} ${icon} ${chalk.cyan(t.label)}${dur}`;
  }
  // Blank a pane's inner content rectangle in the screen buffer before a repaint.
  // Under fullUnicode, blessed's box render miscounts wide chars (emoji) in
  // wrapped lines and skips some cells, so when content SHRINKS (a turn collapses,
  // markdown replaces a longer stream) the old glyphs are left behind as
  // "character bleed". clearRegion writes spaces + marks those cells dirty so the
  // next render redraws them clean. Cheap (buffer-only, no terminal clear → no
  // flicker); the box border is preserved by insetting 1 cell. lpos exists only
  // after the first render — the very first paint can't ghost, so skipping is safe.
  function clearRegion(el: any): void {
    const p = el.lpos;
    if (!p) return;
    try { screen.clearRegion(p.xi + 1, p.xl - 1, p.yi + 1, p.yl - 1); } catch { /* */ }
  }

  function renderTrace(): void {
    // Under new-trace, the 120ms timeline ticker (setTracePanel) is the SOLE
    // owner of the trace box. The legacy per-turn `traceTurns` view must not
    // paint here or it stomps the timeline every time something calls traceLine/
    // startTraceTurn (job updates, pre-flight warnings, retries) — that collision
    // is what produced the garbled "⚡ … → 0 tok" legacy rows over the timeline.
    if (useNewTrace) return;
    clearRegion(trace);
    const out: string[] = [];
    traceHeaderRows = new Map();
    traceTurns.forEach((t, ti) => {
      traceHeaderRows.set(out.length, ti);
      out.push(_turnHeader(t));
      if (!t.collapsed) for (const l of t.lines) out.push(l);
    });
    // Belt-and-suspenders against blessed "character bleed": when the trace
    // SHRINKS (a long turn collapses into a short new one) blessed's wide-char
    // (emoji) miscount in wrapped lines leaves stale glyphs in the now-uncovered
    // rows. clearRegion alone proved unreliable for this, so when the content is
    // shorter than the pane, pad with blank lines so setContent paints over every
    // visible row. Skip when the user has scrolled up (don't perturb their view)
    // or when content already fills/overflows the pane (no uncovered rows).
    if (!userPinnedTrace) {
      const innerH = (typeof trace.height === 'number' ? trace.height : 0) - 2;
      while (innerH > out.length) out.push('');
    }
    const base = trace.childBase || 0;
    try {
      trace.setContent(out.join('\n'));
      if (!userPinnedTrace) trace.setScrollPerc(100);
      else { try { trace.scrollTo(base); } catch { /* */ } }
    } catch { /* transient blessed fault — recovered on next render */ }
    scheduleRender();
  }
  /** Begin a new trace thread; collapse prior threads into the running history. */
  function startTraceTurn(label: string): void {
    revealTrace();   // there is now trace content worth the split
    for (const t of traceTurns) t.collapsed = true;
    traceTurns.push({ label, lines: [], collapsed: false, status: 'running', startedAt: Date.now() });
    renderTrace();
  }
  /** Mark the current thread done/error + stamp its duration (shown in header). */
  function finishTraceTurn(status: 'done' | 'error'): void {
    const t = traceTurns[traceTurns.length - 1];
    if (!t || t.status !== 'running') return;
    t.status = status;
    t.durationMs = Date.now() - t.startedAt;
    renderTrace();
  }
  function traceLine(line: string): void {
    revealTrace();   // there is now trace content worth the split
    if (!traceTurns.length) traceTurns.push({ label: 'session', lines: [], collapsed: false, status: 'running', startedAt: Date.now() });
    traceTurns[traceTurns.length - 1].lines.push(line);
    renderTrace();
  }
  /** Toggle collapse on the turn whose header is at rendered content row `row`. */
  function toggleTurnAtRow(row: number): void {
    const ti = traceHeaderRows.get(row);
    if (ti == null) return;
    traceTurns[ti].collapsed = !traceTurns[ti].collapsed;
    renderTrace();
  }
  /** Collapse-all ⇄ expand-all (Ctrl+E). */
  function toggleAllTurns(): void {
    const anyOpen = traceTurns.some(t => !t.collapsed);
    for (const t of traceTurns) t.collapsed = anyOpen;
    renderTrace();
  }
  // Click a turn header to expand/collapse it.
  // With new-trace: also check for tool clicks and open viewer.
  trace.on('click', (data: any) => {
    try {
      const row = (data.y - trace.atop - trace.itop) + (trace.childBase || 0);
      if (useNewTrace && traceRowToNodeMap.has(row)) {
        const node = traceRowToNodeMap.get(row);
        if (node?.type === 'tool' && node?.data && showToolResultViewerFn) {
          lastToolDetail = node.data;
          void showToolResultViewerFn(screen, node.data);
          return;
        }
      }
      toggleTurnAtRow(row);
    } catch { /* */ }
  });
  function setStatus(text: string): void { status.setContent('  ' + (text || '')); scheduleRender(); }

  // ── Persistent clickable status bar ───────────────────────────
  // Segments are laid out left→right separated by " │ "; we record each segment's
  // [start,end) column range so a click maps back to its action key.
  let barRanges: { start: number; end: number; key: string }[] = [];
  const BAR_SEP = chalk.dim(' │ ');
  const BAR_SEP_W = 3;
  function setStatusBar(segments: { key: string; text: string; plain: string }[]): void {
    try {
      barRanges = [];
      let content = ' ';
      let col = 1;  // leading space
      segments.forEach((s, i) => {
        if (i) { content += BAR_SEP; col += BAR_SEP_W; }
        const start = col;
        content += s.text;
        col += s.plain.length;
        barRanges.push({ start, end: col, key: s.key });
      });
      statusBar.setContent(content);
      scheduleRender();
    } catch { /* the bar must never break the TUI */ }
  }
  statusBar.on('click', (data: any) => {
    try {
      const x = (data.x ?? 0) - (statusBar.aleft ?? 0);
      const hit = barRanges.find(r => x >= r.start && x < r.end);
      // Hand off to the action and DO NOT refocus here: actions that open a viewer
      // (showViewer) call box.focus() themselves — stealing focus back to the input
      // would break their Esc/q key bindings (the viewer only gets keys while focused).
      if (hit && opts.onStatusAction) opts.onStatusAction(hit.key);
    } catch { /* */ }
  });
  function setTracePanel(label: string, lines: string[]): void {
    revealTrace();   // relay roster etc — real content, show the pane
    clearRegion(trace);
    try { trace.setLabel(` ${label} `); } catch { /* */ }
    const base = trace.childBase || 0;
    trace.setContent(lines.join('\n'));
    if (!userPinnedTrace) trace.setScrollPerc(100); else { try { trace.scrollTo(base); } catch { /* */ } }
    scheduleRender();
  }
  function setOutputLabel(label: string): void {
    try { output.setLabel(` ${label} `); } catch { /* */ } scheduleRender();
  }
  function getTraceWidth(): number {
    try { return Math.max(10, (trace.width as number) - 2); } catch { return 40; }
  }
  function getOutputWidth(): number {
    // Inner text width = box width − border(2) − scrollbar(1) − left margin(2).
    // The answer must reflow to THIS width so blessed never re-wraps pre-formatted lines.
    // ChatFormatter adds a 2-column left margin for visual breathing room.
    try { return Math.max(20, (output.width as number) - 5); } catch { return 66; }
  }
  function setTraceRowToNodeMap(map: Map<number, any>): void {
    traceRowToNodeMap = map;
  }
  function clearPanes(): void {
    outputBuf = ''; dirty = true; output.setContent('');
    traceTurns.length = 0; traceHeaderRows = new Map(); trace.setContent(''); scheduleRender();
  }

  // Start with the trace pane HIDDEN so OUTPUT owns the full width. At boot the
  // trace pane has nothing in it, and reserving 40% of the screen for an empty
  // box left a huge dead zone beside a mostly-empty output pane — the single
  // worst thing about the TUI on a wide terminal (owner screenshot 2026-07-24).
  // The split appears automatically on the first trace line (revealTrace) and the
  // user's own Ctrl+T choice always wins after that (userPinnedTrace).
  let traceVisible = false;
  let splitPct = 60;  // OUTPUT pane width %; the rest is the trace pane.
  trace.hide();
  output.width = '100%';
  function applySplit(): void {
    if (traceVisible) { output.width = `${splitPct}%`; trace.left = `${splitPct}%`; }
  }
  /** Reveal the split the moment there IS trace content worth the screen space —
   *  unless the user explicitly hid it with Ctrl+T. */
  function revealTrace(): void {
    if (traceVisible || userPinnedTrace) return;
    traceVisible = true;
    trace.show();
    applySplit();
    scheduleRender();
  }
  function toggleTrace(): void {
    traceVisible = !traceVisible;
    userPinnedTrace = true;   // an explicit choice — auto-reveal must not fight it
    if (traceVisible) { trace.show(); applySplit(); }
    else { trace.hide(); output.width = '100%'; }
    screen.render();
  }
  // Mouse capture vs terminal text selection. While blessed owns the mouse (the
  // default — needed for wheel scroll + click-to-toggle-thread) the terminal's
  // own click-drag selection is intercepted, so you can't highlight to copy.
  // Ctrl+G releases the mouse back to the terminal (select/copy freely); Ctrl+G
  // again re-grabs it for scroll. (Tip: most terminals also do Shift+drag while
  // captured.)
  let mouseCaptured = true;
  function toggleMouse(): void {
    mouseCaptured = !mouseCaptured;
    try {
      if (mouseCaptured) screen.program.enableMouse();
      else screen.program.disableMouse();
    } catch { /* terminal may not support it */ }
    setStatus(mouseCaptured
      ? 'mouse: captured (wheel scroll on) — Ctrl+G to release for copy/paste'
      : 'mouse: released — drag to select/copy · Ctrl+G to re-enable scroll');
    screen.render();
  }
  /** Adjust the output/trace split (Ctrl+←/→). +delta widens output. */
  function resizeSplit(delta: number): void {
    if (!traceVisible) return;
    splitPct = Math.max(30, Math.min(85, splitPct + delta));
    applySplit(); screen.render();
  }

  function scrollOutput(amount: number): void {
    try { output.scroll(amount); userPinnedOutput = !atBottom(output); screen.render(); } catch { /* */ }
  }
  function scrollTrace(amount: number): void {
    try { trace.scroll(amount); userPinnedTrace = !atBottom(trace); screen.render(); } catch { /* */ }
  }
  output.on('scroll', () => {
    userPinnedOutput = !atBottom(output);
    if (atTop(output)) opts.onScrollTop?.();  // relay scrollback (caller guards re-entrancy)
  });
  trace.on('scroll', () => { userPinnedTrace = !atBottom(trace); });
  // Mouse wheel scrolls whichever pane is under the cursor — independently, and
  // without needing focus. (blessed's built-in wheel scroll doesn't update our
  // pin state, so route through scrollOutput/scrollTrace which do.)
  output.on('wheelup', () => scrollOutput(-3));
  output.on('wheeldown', () => scrollOutput(3));
  trace.on('wheelup', () => scrollTrace(-3));
  trace.on('wheeldown', () => scrollTrace(3));

  // Resize event: re-render timeline with new pane width (new-trace only)
  if (useNewTrace && opts.timeline && opts.timeline.render) {
    screen.on('resize', () => {
      try {
        const traceWidth = (trace.width as number) - 2;
        const result = opts.timeline.render(traceWidth);
        traceRowToNodeMap = result.rowToNodeMap;
        trace.setContent(result.lines.join('\n'));
        screen.render();
      } catch { /* silent */ }
    });
  }

  /** Snap the OUTPUT pane back to the live bottom (un-pin). */
  function outputToBottom(): void {
    userPinnedOutput = false;
    try { output.setScrollPerc(100); screen.render(); } catch { /* */ }
  }

  // ── Manual input handling (do NOT use blessed's textbox readInput) ──
  // Verified on this terminal: stdin emits EXACTLY ONE keypress per physical key,
  // but blessed's textbox element-keypress path delivers each key to the textbox
  // TWICE ("hheeyy"). So we drive the input value ourselves from the PROGRAM-level
  // keypress stream — `program.emit('keypress')` fires once per physical key
  // (Program.instances == 1) — and use the `input` box purely as a display.
  // Input is an array of CODE POINTS (emoji-safe caret math), not a JS string.
  let inputChars: string[] = [];
  let _pickerOpen = false;
  let inputCursor = 0;  // caret index into inputChars
  function inputStr(): string { return inputChars.join(''); }
  function setInput(val: string, cur?: number): void {
    inputChars = Array.from(val ?? '');
    inputCursor = cur == null ? inputChars.length : Math.max(0, Math.min(cur, inputChars.length));
    renderInput();
  }
  function renderInput(): void {
    // Horizontally WINDOW long lines so the caret stays visible inside the
    // single-line box (was overflowing before). '‹' marks a scrolled-off head.
    // Account for 2-column left margin: "  input here"
    const margin = '  ';
    const innerW = Math.max(8, (input.width as number) - 5);  // -2 border, -1 scroll, -2 margin
    let start = 0;
    if (inputCursor > innerW - 2) start = inputCursor - (innerW - 2);
    const win = inputChars.slice(start, start + innerW);
    const rel = inputCursor - start;
    const before = win.slice(0, rel).join('');
    const at = win[rel] ?? ' ';
    const after = win.slice(rel + 1).join('');
    const lead = start > 0 ? chalk.dim('‹') : ' ';
    input.setContent(margin + lead + before + chalk.inverse(at) + after);
    scheduleRender();
  }

  const page = () => Math.max(1, (output.height as number) - 4);

  function onKey(ch: any, key: any): void {
    if (_pickerOpen) return;  // the picker (blessed.list) handles its own keys
    const name: string = (key && key.name) || '';
    const ctrl = !!(key && key.ctrl);
    if (ctrl && name === 'c') { opts.onInterrupt(); return; }
    if (ctrl && name === 't') { toggleTrace(); return; }
    if (ctrl && name === 'g') { toggleMouse(); return; }   // release/grab mouse for copy-paste
    // ── Live overlays (F/N/R/P/S always; A only on an empty line, else line-start) ──
    if (ctrl && name === 'f' && opts.onOverlay) { opts.onOverlay('flame'); return; }
    if (ctrl && name === 'n' && opts.onOverlay) { opts.onOverlay('neurons'); return; }
    if (ctrl && name === 'r' && opts.onOverlay) { opts.onOverlay('reasoning'); return; }
    if (ctrl && name === 'p' && opts.onOverlay) { opts.onOverlay('portrait'); return; }
    if (ctrl && name === 'k' && opts.onOverlay) { opts.onOverlay('graph'); return; }
    if (ctrl && name === 's' && opts.onOverlay) { opts.onOverlay('sessions'); return; }
    if (ctrl && name === 'o' && opts.onOverlay) { opts.onOverlay('storage'); return; }   // awstorage cockpit
    if (ctrl && name === 'a' && !inputChars.length && opts.onOverlay) { opts.onOverlay('affect'); return; }
    // Ctrl+E: toggle all stages (new-trace) or collapse/expand turns (legacy). Empty line only.
    if (ctrl && name === 'e' && !inputChars.length) {
      if (useNewTrace && opts.timeline && opts.timeline.toggleAllStages) {
        opts.timeline.toggleAllStages();
        // Re-render trace with current width
        try {
          const result = opts.timeline.render((trace.width as number) - 2);
          traceRowToNodeMap = result.rowToNodeMap;
          trace.setContent(result.lines.join('\n'));
          screen.render();
        } catch { /* silent */ }
      } else {
        toggleAllTurns();
      }
      return;
    }
    // 'e' key: open tool result viewer when trace is focused + most-recent tool exists
    if (!ctrl && name === 'e' && !inputChars.length && useNewTrace && lastToolDetail && showToolResultViewerFn) {
      void showToolResultViewerFn(screen, lastToolDetail);
      return;
    }
    // ── Pane controls ──
    if (name === 'pageup') { (key && key.shift) ? scrollTrace(-8) : scrollOutput(-page()); return; }
    if (name === 'pagedown') { (key && key.shift) ? scrollTrace(8) : scrollOutput(page()); return; }
    if (ctrl && name === 'up') { scrollOutput(-1); return; }
    if (ctrl && name === 'down') { scrollOutput(1); return; }
    if (ctrl && name === 'left') { resizeSplit(-5); return; }   // give the trace pane more room
    if (ctrl && name === 'right') { resizeSplit(5); return; }   // give the output pane more room
    // Home/End scroll output (Shift = trace) ONLY on an empty line; otherwise
    // they move the input caret (so editing a typed line works as expected).
    if (name === 'home') {
      if (inputChars.length) { inputCursor = 0; renderInput(); }
      else (key && key.shift) ? scrollTrace(-99999) : scrollOutput(-99999);
      return;
    }
    if (name === 'end') {
      if (inputChars.length) { inputCursor = inputChars.length; renderInput(); }
      else (key && key.shift) ? scrollTrace(99999) : outputToBottom();
      return;
    }
    // ── Input line editing (operates on code points) ──
    if (name === 'enter' || name === 'return' || name === 'linefeed') {
      const line = inputStr().trim(); setInput('');
      if (line === '/' && opts.onSlash) { opts.onSlash(); return; }
      if (line) opts.onSubmit(line);
      return;
    }
    if (name === 'left') { if (inputCursor > 0) { inputCursor--; renderInput(); } return; }
    if (name === 'right') { if (inputCursor < inputChars.length) { inputCursor++; renderInput(); } return; }
    if (ctrl && name === 'a') { inputCursor = 0; renderInput(); return; }            // line start (readline)
    if (ctrl && name === 'e') { inputCursor = inputChars.length; renderInput(); return; }  // line end (when input has content)
    if (ctrl && name === 'u') { setInput(inputChars.slice(inputCursor).join(''), 0); return; }       // kill to start
    if (ctrl && name === 'k') { setInput(inputChars.slice(0, inputCursor).join(''), inputCursor); return; } // kill to end
    if (ctrl && name === 'w') {                                                // delete word before caret
      const left = Array.from(inputChars.slice(0, inputCursor).join('').replace(/\s*\S+\s*$/, ''));
      setInput(left.join('') + inputChars.slice(inputCursor).join(''), left.length);
      return;
    }
    if (name === 'backspace') {
      if (inputCursor > 0) setInput(inputChars.slice(0, inputCursor - 1).concat(inputChars.slice(inputCursor)).join(''), inputCursor - 1);
      return;
    }
    if (name === 'delete') {
      if (inputCursor < inputChars.length) setInput(inputChars.slice(0, inputCursor).concat(inputChars.slice(inputCursor + 1)).join(''), inputCursor);
      return;
    }
    if (name === 'up' && opts.onHistory) { const v = opts.onHistory('up'); if (v != null) setInput(v); return; }
    if (name === 'down' && opts.onHistory) { const v = opts.onHistory('down'); if (v != null) setInput(v); return; }
    if (name === 'tab' && opts.onTab) { const v = opts.onTab(inputStr()); if (v != null) setInput(v); return; }
    // Printable character — insert at the caret. Ignore control/meta combos.
    if (ch && typeof ch === 'string' && ch.length >= 1 && ch >= ' ' && !(key && (key.ctrl || key.meta))) {
      const ins = Array.from(ch);  // paste may deliver multiple chars at once
      inputChars = inputChars.slice(0, inputCursor).concat(ins, inputChars.slice(inputCursor));
      inputCursor += ins.length;
      renderInput();
      opts.onType?.();
    }
  }
  (screen as any).program.on('keypress', onKey);

  function render(): void { scheduleRender(); }
  function focusInput(): void { renderInput(); }
  function destroy(): void {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    try { screen.destroy(); } catch { /* */ }
  }

  // Suspend blessed → run on the real terminal → restore. Mirrors the readline
  // REPL's stdin-listener save/restore so handler ora/inquirer/console all work.
  async function runDetached(label: string, fn: () => Promise<void> | void): Promise<void> {
    const program = screen.program;
    const stdin: any = process.stdin;
    const dataL = stdin.rawListeners('data').slice();
    const keyL = stdin.rawListeners('keypress').slice();
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    try { program.disableMouse(); } catch { /* */ }
    program.normalBuffer();   // leave the alt screen → normal terminal (output visible)
    program.showCursor();
    if (stdin.setRawMode) try { stdin.setRawMode(false); } catch { /* */ }
    stdin.resume();
    process.stdout.write('\n' + chalk.cyan(`── /${label} ──`) + '\n\n');
    try {
      await fn();
    } catch (e: any) {
      process.stdout.write('\n' + chalk.red(`  Error: ${e?.message || e}`) + '\n');
    }
    process.stdout.write(chalk.dim('\n  ── press Enter to return to AitherShell ──'));
    // fn() may have been an @inquirer prompt flow (interactive commands), which on
    // completion can leave stdin in raw mode AND paused with its own listeners
    // detached — so a plain Enter never produces a 'data' event and the wait hangs
    // (and Ctrl+C, being a raw byte rather than a signal, can't break out either).
    // Re-establish flowing, non-raw, listener-free stdin before waiting so Enter
    // delivers a newline and Ctrl+C raises SIGINT normally.
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    if (stdin.setRawMode) try { stdin.setRawMode(false); } catch { /* */ }
    stdin.resume();
    await new Promise<void>((resolve) => {
      const done = () => {
        stdin.removeListener('data', onData);
        process.removeListener('SIGINT', onSig);
        resolve();
      };
      const onData = () => done();
      const onSig = () => done();   // Ctrl+C returns to the shell instead of killing it
      stdin.on('data', onData);
      process.once('SIGINT', onSig);
    });
    // Restore blessed ownership of the terminal.
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    for (const l of dataL) stdin.on('data', l);
    for (const l of keyL) stdin.on('keypress', l);
    if (stdin.setRawMode) try { stdin.setRawMode(true); } catch { /* */ }
    program.alternateBuffer();
    try { program.enableMouse(); } catch { /* */ }
    try { screen.alloc(); } catch { /* */ }
    screen.render();
    focusInput();
  }

  // Animate portrait frames on the RAW terminal. blessed re-renders SGR through
  // its own attr system and downsamples 24-bit (38;2;r;g;b) to 16/256 colours —
  // which turned the portrait into a flat 4-colour mess. Writing raw ANSI to the
  // real terminal (like runDetached) lets Windows Terminal render true 24-bit,
  // and a frame loop makes it alive. Any keystroke closes + restores blessed.
  async function showPortraitFrames(frames: string[][], intervalMs = 600): Promise<void> {
    if (!frames.length) return;
    const program = screen.program;
    const stdin: any = process.stdin;
    const dataL = stdin.rawListeners('data').slice();
    const keyL = stdin.rawListeners('keypress').slice();
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    try { program.disableMouse(); } catch { /* */ }
    program.normalBuffer();
    process.stdout.write('\x1b[2J\x1b[?25l');  // clear + hide cursor
    let i = 0;
    const draw = () => {
      const frame = frames[i % frames.length];
      i++;
      // Clamp to the screen height: header takes 2 rows, keep 1 margin. A frame taller than the
      // terminal would overflow past \x1b[H and SCROLL on every redraw (the "spam down the screen"
      // bug) — truncating guarantees the animation redraws in place.
      const maxRows = Math.max(2, (process.stdout.rows || 40) - 3);
      const shown = frame.length > maxRows ? frame.slice(0, maxRows) : frame;
      // Home, header, frame, then clear-to-end (erases a taller previous frame).
      process.stdout.write('\x1b[H' + chalk.dim(' Aither  ·  any key to close') + '\r\n\r\n'
        + shown.join('\r\n') + '\x1b[J');
    };
    draw();
    const timer = frames.length > 1 ? setInterval(draw, intervalMs) : null;
    if (stdin.setRawMode) try { stdin.setRawMode(true); } catch { /* */ }
    stdin.resume();
    await new Promise<void>((resolve) => {
      const onData = () => { stdin.removeListener('data', onData); resolve(); };
      stdin.on('data', onData);
    });
    if (timer) clearInterval(timer);
    process.stdout.write('\x1b[?25h');  // show cursor
    // Restore blessed ownership (mirror runDetached).
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    for (const l of dataL) stdin.on('data', l);
    for (const l of keyL) stdin.on('keypress', l);
    if (stdin.setRawMode) try { stdin.setRawMode(true); } catch { /* */ }
    program.alternateBuffer();
    try { program.enableMouse(); } catch { /* */ }
    try { screen.alloc(); } catch { /* */ }
    screen.render();
    focusInput();
  }

  // ── Persistent truecolor avatar pane (opt-in) ─────────────────
  // blessed downsamples 24-bit colour, so to keep Aither TRUECOLOR while chatting we paint her
  // as a raw region in the top-right corner and repaint after every blessed render (blessed's
  // repaint would otherwise overwrite the region). Opt-in + fully guarded so it can never tear
  // the session down; when off it's a no-op and the normal TUI is untouched.
  let avatarFrames: string[][] = [];
  let avatarIdx = 0;
  let avatarOn = false;
  let avatarTimer: ReturnType<typeof setInterval> | null = null;
  let avatarPainting = false;
  // Speech-sync: when the voice is speaking we advance frames every tick so the
  // mouth (already animated across the i2v idle frames) flaps in time with the
  // audio; when quiet we advance every 3rd tick for a gentle idle/breathing loop.
  let avatarSpeaking: (() => boolean) | null = null;
  // Separate mouth-open/close sequence played WHILE talking (voice audio OR streaming tokens).
  // When empty, talking just speeds the base loop (old behaviour); when present, the pane swaps to
  // these frames so the mouth actually moves in sync with the answer — real lip-sync, not a fast idle.
  let avatarTalkFrames: string[][] = [];
  let avatarTick = 0;
  // The exact physical rectangle last painted (1-based col, row count). Recorded so
  // hiding the pane can ERASE those cells — they live outside blessed's buffer, so a
  // plain screen.render() never clears them (blessed sees no damage there).
  let avatarRect: { startCol: number; w: number; lines: number } | null = null;

  /** The frame set to paint right now: the talk sequence while talking (if provided), else the
   *  base idle/emotion loop. Re-evaluated every paint so it reverts the instant talking stops. */
  function activeAvatarFrames(): string[][] {
    const talking = (() => { try { return !!avatarSpeaking?.(); } catch { return false; } })();
    return (talking && avatarTalkFrames.length) ? avatarTalkFrames : avatarFrames;
  }

  /** Screen columns the trace pane currently spans (it starts at 60%). */
  function traceRegionCols(): number {
    const cols = Number((screen as any).width) || process.stdout.columns || 100;
    return Math.max(0, cols - Math.floor(cols * TRACE_LEFT_FRACTION));
  }

  /**
   * Widest dockable avatar. The avatar is painted RAW at absolute terminal coordinates
   * down the right edge — the same region the trace pane occupies — so without a cap it
   * silently overwrites trace content. That was visible as interleaved half-blocks and
   * trace text in the same rows.
   */
  function maxAvatarCols(): number {
    const cols = Number((screen as any).width) || process.stdout.columns || 100;
    return avatarLayout(cols, Number.MAX_SAFE_INTEGER).avatarCols;
  }

  /**
   * Give the avatar its own columns instead of letting it overpaint the trace pane.
   *
   * The avatar cannot be a blessed element (blessed downsamples 24-bit truecolor to its
   * 16/256 palette, which is the whole reason this pane is raw-painted), so blessed cannot
   * lay out around it. Shrinking the trace box by the avatar's width is what keeps the two
   * from occupying the same cells.
   */
  function reserveAvatarColumns(cols: number | null): void {
    try {
      const screenCols = Number((screen as any).width) || process.stdout.columns || 100;
      const want = cols == null ? 0 : avatarLayout(screenCols, cols).traceRight;
      const current = Number((trace as any).position?.right ?? 0);
      if (current === want) return;
      (trace as any).position.right = want;
      screen.render();
    } catch { /* layout is best-effort — never break the TUI over the avatar */ }
  }

  function paintAvatar(): void {
    if (!avatarOn || !avatarFrames.length || avatarPainting) return;
    avatarPainting = true;
    try {
      const set = activeAvatarFrames();
      const frame = set[avatarIdx % set.length] || [];
      const cols = Number((screen as any).width) || process.stdout.columns || 100;
      const rows = Number((screen as any).height) || process.stdout.rows || 40;
      // visible width = chars remaining after stripping SGR escapes from the first line
      const first = frame.find(l => l.length) || '';
      const w = first.replace(/\x1b\[[0-9;]*m/g, '').length || 24;
      // Same geometry the trace reservation used — computing it twice, two ways, is how the
      // paint and the layout come to disagree and overlap again.
      const startCol = avatarLayout(cols, w).avatarStartCol;
      const maxLines = Math.min(frame.length, Math.max(1, rows - 4));  // don't cover the input box
      avatarRect = { startCol, w, lines: maxLines };  // remember what to erase on hide
      let out = '\x1b7\x1b[?25l';                     // save cursor + hide
      for (let r = 0; r < maxLines; r++) {
        out += '\x1b[' + (r + 1) + ';' + startCol + 'H' + frame[r] + '\x1b[0m';
      }
      out += '\x1b8';                                 // restore cursor
      process.stdout.write(out);
    } catch { /* never let the avatar break the TUI */ }
    finally { avatarPainting = false; }
  }

  // Repaint after blessed renders (blessed clobbers the corner otherwise).
  try { screen.on('render', () => { if (avatarOn) setImmediate(paintAvatar); }); } catch { /* */ }

  function setAvatarPane(frames: string[][] | null,
                         opts?: { isSpeaking?: () => boolean; talkFrames?: string[][] }): boolean {
    try {
      if (frames && frames.length) {
        avatarFrames = frames; avatarIdx = 0; avatarOn = true;
        avatarSpeaking = opts?.isSpeaking ?? avatarSpeaking;
        if (opts && 'talkFrames' in opts) avatarTalkFrames = opts.talkFrames ?? [];
        // Run the ticker if EITHER the base loop or the talk loop has multiple frames.
        // Reserve columns BEFORE painting, so the first paint lands beside the trace pane
        // rather than on top of it.
        const first = frames.find(l => l.length)?.[0] ?? '';
        reserveAvatarColumns(first.replace(/\x1b\[[0-9;]*m/g, '').length || 24);
        if (!avatarTimer && (frames.length > 1 || avatarTalkFrames.length > 1)) {
          // Base tick 120ms. Talking → advance every tick (mouth in sync with audio/tokens) and the
          // active set is the talk sequence; idle → advance every 3rd tick (~360ms gentle loop).
          avatarTimer = setInterval(() => {
            avatarTick++;
            const speaking = (() => { try { return !!avatarSpeaking?.(); } catch { return false; } })();
            if (speaking || avatarTick % 3 === 0) { avatarIdx++; paintAvatar(); }
          }, 120);
        }
        paintAvatar();
      } else {
        avatarOn = false; avatarFrames = []; avatarTalkFrames = [];
        if (avatarTimer) { clearInterval(avatarTimer); avatarTimer = null; }
        // Erase the raw-painted cells: (1) blank them on the PHYSICAL terminal (blessed
        // never tracked them, so render() alone won't), then (2) mark the region damaged
        // in blessed's buffer so the next render redraws whatever belongs underneath
        // (trace pane border, background). Without step 1 the portrait stays on screen.
        if (avatarRect) {
          const { startCol, w, lines } = avatarRect;
          try {
            let out = '\x1b7\x1b[?25l';
            for (let r = 0; r < lines; r++) {
              out += '\x1b[' + (r + 1) + ';' + startCol + 'H' + ' '.repeat(w);
            }
            out += '\x1b8\x1b[?25h';
            process.stdout.write(out);
          } catch { /* */ }
          try { screen.clearRegion(startCol - 1, startCol - 1 + w, 0, lines); } catch { /* */ }
          avatarRect = null;
        }
        // Hand the columns back so the trace pane returns to full width.
        reserveAvatarColumns(null);
        try { screen.render(); } catch { /* */ }
      }
    } catch { avatarOn = false; }
    return avatarOn;
  }

  // ── Command picker overlay (native blessed.list — no inquirer) ──
  function pickerOpen(): boolean { return _pickerOpen; }

  function showPicker(title: string, items: PickerItem[], initialFilter = ''): Promise<string | null> {
    return new Promise((resolve) => {
      _pickerOpen = true;
      let filter = initialFilter;

      const box = blessed.list({
        parent: screen, label: ` ${title} `, border: 'line',
        top: 'center', left: 'center', width: '70%', height: '80%',
        keys: true, mouse: true, tags: false,  // no vi: letters are for type-to-filter
        scrollbar: { ch: ' ', inverse: true },
        style: { selected: { bg: 'cyan', fg: 'black' }, border: { fg: 'cyan' }, label: { fg: 'cyan' }, item: { fg: 'white' } },
      });

      let view: PickerItem[] = [];
      function refresh(): void {
        const term = filter.trim().toLowerCase();
        view = items.filter(it => {
          if (it.separator) return !term;  // hide separators while filtering
          if (!term) return true;
          return it.value.toLowerCase().includes(term)
            || it.label.toLowerCase().includes(term)
            || (it.description || '').toLowerCase().includes(term);
        });
        box.setItems(view.map(it => it.separator
          ? `  ${it.label}`
          : `  ${it.label}${it.description ? '  —  ' + it.description : ''}`));
        box.setLabel(` ${title}${filter ? '  /' + filter : ''} `);
        // Select the first non-separator row.
        const firstReal = view.findIndex(it => !it.separator);
        if (firstReal >= 0) box.select(firstReal);
        screen.render();
      }

      function close(result: string | null): void {
        _pickerOpen = false;
        try { box.destroy(); } catch { /* */ }
        screen.render();
        focusInput();
        resolve(result);
      }

      box.on('select', (_item: any, idx: number) => {
        const it = view[idx];
        if (it && !it.separator) close(it.value);
      });
      box.key(['escape', 'C-c'], () => close(null));
      box.key(['backspace'], () => { filter = filter.slice(0, -1); refresh(); });
      box.on('keypress', (ch: string, key: any) => {
        if (!key) return;
        if (key.name === 'enter' || key.name === 'return' || key.name === 'up' || key.name === 'down'
          || key.name === 'pageup' || key.name === 'pagedown' || key.name === 'escape'
          || key.name === 'backspace' || key.name === 'tab') return;
        if (ch && ch.length === 1 && ch >= ' ') { filter += ch; refresh(); }
      });

      refresh();
      box.focus();
      screen.render();
    });
  }

  // ── Document viewer overlay (full-screen scrollable box) ──────
  // Reuses the _pickerOpen guard so the main keypress handler stands down while
  // the viewer owns the keyboard. Content is pre-rendered (markdown/code/text +
  // chalk ANSI); blessed parses the SGR colour codes itself. Images do NOT come
  // through here — they render via runDetached so 24-bit colour isn't downsampled.
  let viewerBox: any = null;  // Store reference for live updates
  function showViewer(title: string, lines: string[]): Promise<void> {
    return new Promise((resolve) => {
      _pickerOpen = true;
      const box = blessed.box({
        parent: screen, label: ` ${title}  —  ↑↓/PgUp/PgDn scroll · g/G top/bottom · q/Esc close `,
        border: 'line', top: 0, left: 0, width: '100%', height: '100%',
        tags: false, scrollable: true, alwaysScroll: true, keys: true, mouse: true,
        scrollbar: { ch: ' ', inverse: true }, wrap: true,
        style: { border: { fg: 'cyan' }, label: { fg: 'cyan' } },
      });
      viewerBox = box;  // Store for updateViewer
      box.setContent(lines.join('\n'));

      function close(): void {
        _pickerOpen = false;
        viewerBox = null;  // Clear reference
        try { box.destroy(); } catch { /* */ }
        screen.render();
        focusInput();
        resolve();
      }
      const vpage = () => Math.max(1, (box.height as number) - 3);
      box.key(['q', 'escape', 'C-c'], () => close());
      box.key(['up', 'k'], () => { box.scroll(-1); screen.render(); });
      box.key(['down', 'j'], () => { box.scroll(1); screen.render(); });
      box.key(['pageup'], () => { box.scroll(-vpage()); screen.render(); });
      box.key(['pagedown', 'space'], () => { box.scroll(vpage()); screen.render(); });
      box.key(['g', 'home'], () => { box.scrollTo(0); screen.render(); });
      box.key(['G', 'end'], () => { box.setScrollPerc(100); screen.render(); });
      box.on('wheelup', () => { box.scroll(-3); screen.render(); });
      box.on('wheeldown', () => { box.scroll(3); screen.render(); });

      box.focus();
      screen.render();
    });
  }

  /** Update the content of a live viewer (called from polling, no-op if closed). */
  function updateViewer(lines: string[]): void {
    if (viewerBox) {
      try { viewerBox.setContent(lines.join('\n')); screen.render(); } catch { /* */ }
    }
  }

  // ── Document editor overlay (notepad/vim-lite, manual keypresses) ─────
  // A real multi-line editor. We drive it from the PROGRAM keypress stream (same
  // reason as the main input box: blessed's textarea double-delivers keys on this
  // terminal). Lines are stored as code-point arrays so emoji/CJK caret maths is
  // correct. While open, _pickerOpen suppresses the main onKey handler and a
  // dedicated keypress listener owns the keyboard until the user quits.
  function showEditor(title: string, initialText: string,
                      onSave: (text: string) => Promise<string | null>): Promise<void> {
    return new Promise((resolve) => {
      _pickerOpen = true;
      const lines: string[][] = (initialText.length ? initialText.replace(/\r\n/g, '\n').split('\n') : [''])
        .map((l) => Array.from(l));
      let cr = 0;          // cursor row
      let cc = 0;          // cursor col (code-point index)
      let top = 0;         // first visible row (vertical scroll)
      let dirty = false;
      let msg = '';        // transient status message
      let confirmingQuit = false;

      const box = blessed.box({
        parent: screen, border: 'line', top: 0, left: 0, width: '100%', height: '100%',
        tags: false, style: { border: { fg: 'yellow' }, label: { fg: 'yellow' } },
      });

      const innerH = () => Math.max(1, (box.height as number) - 2);
      const innerW = () => Math.max(20, (box.width as number) - 2);
      const gutterW = () => String(lines.length).length;

      function setLabel(): void {
        const flag = dirty ? chalk.red(' ●') : '';
        const pos = `${cr + 1}:${cc + 1}`;
        const hint = confirmingQuit
          ? chalk.red('unsaved — ^Q again to discard, ^S to save')
          : chalk.dim('^S save · ^Q/Esc quit · arrows move · Enter newline');
        const note = msg ? '  ' + chalk.green(msg) : '';
        try { box.setLabel(` ${title}${flag}  ${chalk.dim(pos)}  ${hint}${note} `); } catch { /* */ }
      }

      function clampView(): void {
        if (cr < top) top = cr;
        if (cr >= top + innerH()) top = cr - innerH() + 1;
        if (top < 0) top = 0;
      }

      function render(): void {
        clampView();
        const g = gutterW();
        const avail = innerW() - (g + 3);          // gutter "NNN │ "
        const out: string[] = [];
        for (let r = top; r < Math.min(lines.length, top + innerH()); r++) {
          const isCur = r === cr;
          const cps = lines[r];
          // Horizontal window so the caret stays visible on long lines.
          let start = 0;
          if (isCur && cc > avail - 1) start = cc - (avail - 1);
          const slice = cps.slice(start, start + avail);
          const gutter = chalk.dim(String(r + 1).padStart(g, ' ') + ' │ ');
          if (isCur) {
            const rel = cc - start;
            const before = slice.slice(0, rel).join('');
            const atCh = slice[rel] ?? ' ';
            const after = slice.slice(rel + 1).join('');
            const lead = start > 0 ? chalk.dim('‹') : '';
            out.push(gutter + lead + before + chalk.inverse(atCh) + after);
          } else {
            out.push(gutter + slice.join(''));
          }
        }
        try { box.setContent(out.join('\n')); } catch { /* */ }
        setLabel();
        scheduleRender();
      }

      function curLine(): string[] { return lines[cr]; }

      async function doSave(): Promise<void> {
        const text = lines.map((l) => l.join('')).join('\n');
        const err = await onSave(text);
        if (err) { msg = ''; setLabel(); try { box.setLabel(` ${title}  ${chalk.red('save failed: ' + err)} `); } catch { /* */ } scheduleRender(); }
        else { dirty = false; confirmingQuit = false; msg = 'saved'; render(); setTimeout(() => { msg = ''; setLabel(); scheduleRender(); }, 1500); }
      }

      function close(): void {
        (screen as any).program.removeListener('keypress', editorKey);
        _pickerOpen = false;
        try { box.destroy(); } catch { /* */ }
        screen.render();
        focusInput();
        resolve();
      }

      function editorKey(ch: any, key: any): void {
        const name: string = (key && key.name) || '';
        const ctrl = !!(key && key.ctrl);
        // Save / quit.
        if (ctrl && name === 's') { void doSave(); return; }
        if ((ctrl && name === 'q') || name === 'escape') {
          if (dirty && !confirmingQuit) { confirmingQuit = true; setLabel(); scheduleRender(); return; }
          close(); return;
        }
        confirmingQuit = false;
        // Navigation.
        if (name === 'up') { if (cr > 0) { cr--; cc = Math.min(cc, curLine().length); } render(); return; }
        if (name === 'down') { if (cr < lines.length - 1) { cr++; cc = Math.min(cc, curLine().length); } render(); return; }
        if (name === 'left') {
          if (cc > 0) cc--;
          else if (cr > 0) { cr--; cc = curLine().length; }
          render(); return;
        }
        if (name === 'right') {
          if (cc < curLine().length) cc++;
          else if (cr < lines.length - 1) { cr++; cc = 0; }
          render(); return;
        }
        if (name === 'home') { cc = 0; render(); return; }
        if (name === 'end') { cc = curLine().length; render(); return; }
        if (name === 'pageup') { cr = Math.max(0, cr - innerH()); cc = Math.min(cc, curLine().length); render(); return; }
        if (name === 'pagedown') { cr = Math.min(lines.length - 1, cr + innerH()); cc = Math.min(cc, curLine().length); render(); return; }
        // Editing.
        if (name === 'enter' || name === 'return' || name === 'linefeed') {
          const cur = curLine();
          const tail = cur.slice(cc);
          lines[cr] = cur.slice(0, cc);
          lines.splice(cr + 1, 0, tail);
          cr++; cc = 0; dirty = true; render(); return;
        }
        if (name === 'backspace') {
          if (cc > 0) { curLine().splice(cc - 1, 1); cc--; dirty = true; }
          else if (cr > 0) { const cur = lines.splice(cr, 1)[0]; cc = lines[cr - 1].length; lines[cr - 1] = lines[cr - 1].concat(cur); cr--; dirty = true; }
          render(); return;
        }
        if (name === 'delete') {
          if (cc < curLine().length) { curLine().splice(cc, 1); dirty = true; }
          else if (cr < lines.length - 1) { const next = lines.splice(cr + 1, 1)[0]; lines[cr] = curLine().concat(next); dirty = true; }
          render(); return;
        }
        if (name === 'tab') { curLine().splice(cc, 0, ' ', ' '); cc += 2; dirty = true; render(); return; }
        // Printable insert (paste may deliver several chars; respects newlines).
        if (ch && typeof ch === 'string' && ch.length >= 1 && ch >= ' ' && !(key && (key.ctrl || key.meta))) {
          for (const c of Array.from(ch)) { curLine().splice(cc, 0, c); cc++; }
          dirty = true; render(); return;
        }
        // Multi-line paste arriving as a chunk with embedded newlines.
        if (ch && typeof ch === 'string' && ch.includes('\n')) {
          for (const c of Array.from(ch)) {
            if (c === '\n') { const tail = curLine().slice(cc); lines[cr] = curLine().slice(0, cc); lines.splice(cr + 1, 0, tail); cr++; cc = 0; }
            else if (c >= ' ') { curLine().splice(cc, 0, c); cc++; }
          }
          dirty = true; render(); return;
        }
      }

      (screen as any).program.on('keypress', editorKey);
      render();
    });
  }

  renderInput();
  screen.render();

  /** Set the timeline instance for new-trace rendering (called after renderer creation). */
  function setTimeline(timeline: any): void {
    if (useNewTrace && timeline) {
      opts.timeline = timeline;
    }
  }

  return {
    screen, input, appendOutput, outputLine, markCheckpoint, replaceOutputFrom, prependOutput,
    traceLine, startTraceTurn, finishTraceTurn, setStatus, setStatusBar, setTracePanel, getTraceWidth, getOutputWidth, setTraceRowToNodeMap, setOutputLabel, clearPanes, toggleTrace, render, focusInput, destroy,
    setPendingFollowups, getPendingFollowups,
    pickerOpen, showPicker, showViewer, updateViewer, showEditor, runDetached, setTimeline, showPortraitFrames,
    setAvatarPane, maxAvatarCols,
  };
}
