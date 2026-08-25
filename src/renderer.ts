/**
 * Terminal renderer — banners, streaming tokens, markdown, tables.
 */

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { VERSION } from './version.js';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import type { SSEEvent } from './client.js';
import { getActiveConfig } from './config.js';
// The ONE design system (palette, gradient wordmark, hairline rules, status
// dots, glyphs). Namespaced so every styled surface here is obviously themed.
import * as T from './theme.js';

// Configure marked for terminal rendering
marked.use(markedTerminal({ reflowText: true, width: 80 }) as any);

/* ── Trace verbosity ─────────────────────────────────────────────
 * FULL trace is ON by default: every pipeline stage (planning/MCTS,
 * neurons, middleware, per-turn timings) prints a permanent line so the
 * user can SEE what the system is doing on every turn without asking.
 * Set AITHER_TRACE=quiet (or off/0/false) to collapse stages back into a
 * single transient status line.
 */
export const TRACE_FULL: boolean = (() => {
  const v = (process.env.AITHER_TRACE || '').toLowerCase().trim();
  if (v === 'quiet' || v === 'off' || v === '0' || v === 'false' || v === 'none') return false;
  return true;  // default: full trace
})();

/* ── OSC 8 terminal hyperlink ────────────────────────────────── */

/** Wrap text in an OSC 8 clickable hyperlink for terminals that support it. */
export function osc8Link(url: string, label?: string): string {
  const text = label || url;
  return `\x1b]8;;${url}\x1b\\${chalk.cyan.underline(text)}\x1b]8;;\x1b\\`;
}

/**
 * Make the links in a terminal answer CLICKABLE, and never lose the URL.
 *
 * The omnibox prints raw model text. A model asked for 'plain terminal text,
 * no markdown' still emits markdown links about half the time, so the reader
 * saw a literal `[CNN](https://www.cnn.com/)` -- and on the other half it
 * dropped the URL entirely and listed bare source NAMES, which is a citation
 * you cannot follow. Both were reported the same way: 'weak as hell and
 * doesn't even give clickable links'.
 *
 * So: markdown links become OSC 8 hyperlinks on their label, and any bare URL
 * left in the prose becomes one on itself. A terminal without OSC 8 support
 * ignores the escape and still shows the label -- which is why the markdown
 * form is REWRITTEN rather than merely detected: the fallback has to remain
 * readable, and `[CNN](url)` is not.
 *
 * Deliberately conservative: no styling, no reflow, no bullet rewriting. This
 * runs over the answer of every omnibox line, and a transform that guesses at
 * structure would mangle the shell one-liners the same feature exists to print.
 */
export function linkifyTerminal(text: string): string {
  if (!text) return text;
  // ONE pass with an alternation, deliberately: a markdown pass followed by a
  // bare-URL pass re-reads what the first pass emitted, and a link whose LABEL
  // is itself a URL then gets an OSC 8 sequence nested inside another and the
  // terminal prints the raw bytes. A single non-overlapping scan cannot do that.
  return text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>`'")\]]+)/g,
    (_m: string, label: string, mdUrl: string, bareUrl: string) => {
      if (bareUrl) {
        // Trailing sentence punctuation is prose, not part of the URL. Kept
        // OUTSIDE the link so the visible text still reads as a sentence.
        const trimmed = bareUrl.replace(/[.,;:!?]+"*$/, '');
        const tail = bareUrl.slice(trimmed.length);
        return osc8Link(trimmed) + tail;
      }
      return osc8Link(mdUrl, label);
    },
  );
}

/** One row of a web-search tool result. */
export interface SearchHit { title: string; url: string; snippet: string }

/**
 * Recover the SOURCES out of a search tool's text output.
 *
 * WHY THE SHELL PARSES THIS INSTEAD OF TRUSTING THE ANSWER. Measured
 * 2026-08-23 against the live AitherSearch lane: the tool returned five dated
 * stories with full URLs and real snippets, and the 4B orchestrator answered
 * with a numbered list of OUTLET NAMES and generic blurbs -- 'CNN - Breaking
 * news, latest updates' -- naming outlets that were not in the tool result at
 * all. The retrieval was good and the synthesis threw it away, which is
 * indistinguishable to the reader from a bad search.
 *
 * So the sources are printed from the TOOL OUTPUT, not from the prose. Same
 * reasoning as answerFromSituation(): a fact the shell already holds must not
 * depend on a small model's mood.
 *
 * Format-agnostic on purpose -- awfind emits title/url/snippet triples and the
 * DuckDuckGo fallback emits its own shape, and pinning either spelling makes
 * this silently return nothing the day the other one is in use. A URL line is
 * the anchor; the nearest non-URL line above it is the title, below it the
 * snippet.
 */
export function parseSearchHits(output: string, limit = 5): SearchHit[] {
  if (!output) return [];
  // TWO shapes, because two different tools answer this question and the model
  // picks either one. Measured 2026-08-23: the omnibox called `dr_web_search`,
  // which returns JSON, while `web_search` returns title/url/snippet triples as
  // TEXT -- and a parser written for one silently returns [] for the other,
  // which prints no sources and is indistinguishable from a search that found
  // nothing. Handle the JSON shape first; fall through to the line scan.
  try {
    const parsed = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : (parsed?.results || parsed?.hits);
    if (Array.isArray(rows)) {
      const out: SearchHit[] = [];
      for (const r of rows) {
        const url = String(r?.url || r?.link || r?.href || '');
        const title = String(r?.title || r?.name || '');
        if (!url || !title) continue;
        out.push({ title, url, snippet: String(r?.snippet || r?.description || r?.text || '') });
        if (out.length >= limit) break;
      }
      if (out.length) return out;
    }
  } catch { /* not JSON -- the salvage and line scan below are the other shapes */ }
  // TRUNCATED JSON is the common case, not an edge case: the daemon caps tool
    // output (measured at 500 chars), which cuts the array mid-object so
  // JSON.parse throws and a strict parser reports NO SOURCES for a search that
  // worked perfectly. Salvage the complete title/url pairs that did survive.
  if (/["']url["']\s*:/.test(output)) {
    const salvaged: SearchHit[] = [];
    const seenU = new Set<string>();
    const re = /["']title["']\s*:\s*"((?:[^"\\]|\\\\.)*)"[^{}]*?["']url["']\s*:\s*"((?:[^"\\]|\\\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      const url = m[2];
      if (!url || seenU.has(url)) continue;
      seenU.add(url);
      salvaged.push({ title: m[1], url, snippet: '' });
      if (salvaged.length >= limit) break;
    }
    if (salvaged.length) return salvaged;
  }
  const lines = output.split(/\r?\n/).map((l) => l.trim());
  const isUrl = (l: string) => /^https?:\/\//.test(l);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!isUrl(lines[i])) continue;
    const url = lines[i];
    if (seen.has(url)) continue;
    seen.add(url);
    let title = '';
    for (let j = i - 1; j >= 0 && j > i - 4; j--) {
      if (lines[j] && !isUrl(lines[j])) { title = lines[j]; break; }
    }
    let snippet = '';
    for (let j = i + 1; j < lines.length && j < i + 4; j++) {
      if (lines[j] && !isUrl(lines[j])) { snippet = lines[j]; break; }
    }
    // A hit with no title is a bare link in prose, not a search result. Keeping
    // it would put an unlabelled URL in a list headed 'Sources'.
    if (!title) continue;
    hits.push({ title, url, snippet });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Render recovered sources as a compact, clickable block. */
export function renderSources(hits: SearchHit[]): string {
  if (!hits.length) return '';
  const out = [chalk.dim('  sources')];
  hits.forEach((h, n) => {
    out.push('  ' + chalk.dim(String(n + 1) + '.') + ' ' + osc8Link(h.url, h.title));
    if (h.snippet) out.push('     ' + chalk.dim(h.snippet.slice(0, 140)));
  });
  return out.join('\n');
}

/* ── Banner ─────────────────────────────────────────────────── */

/** Turn an internal SSE event/stage id into something a human should read.
 *  `enrichment_detached` → `grounding`, `classify_start` → `classifying`, and any
 *  unmapped `snake_case` → `snake case`. Keeps trace output informative without
 *  leaking the codebase's private vocabulary into the shell. */
const _TRACE_LABELS: Record<string, string> = {
  enrichment_detached: 'grounding',
  enrichment_start: 'grounding',
  classify_start: 'classifying',
  context_start: 'gathering context',
  planning_start: 'planning',
  research_start: 'researching',
  tool_executing: 'running tools',
  reasoning_start: 'reasoning',
  memory_start: 'recalling',
};
export function humanizeTraceLabel(label: string): string {
  const key = label.trim().toLowerCase();
  if (_TRACE_LABELS[key]) return _TRACE_LABELS[key];
  return key.replace(/_/g, ' ');
}

export function renderBanner(info: {
  genesis: string;
  genesisOnline?: boolean;
  services?: number;
  agents?: number;
  llm?: string;
  user?: string;
  serviceLines?: { name: string; up: boolean }[];
  backendType?: string;
  backendName?: string;
  // D-2170: explicit override for terminal width, so a test can control it
  // directly instead of mutating process.stdout.columns via
  // Object.defineProperty. That mutation is provably environment-dependent
  // — reproduced clean under Node 22 locally, still failed on the actual
  // GitHub Actions runner (banner-width.test.ts, 2026-08-24) — most likely
  // because a real pty-backed WriteStream there exposes `columns` via a
  // prototype getter/setter pair that an own-property override can shadow
  // inconsistently depending on how the runtime resolves it, where a piped
  // non-TTY stream (this dev box, most CI test harnesses) has no such
  // descriptor to fight at all. An explicit param has no such ambiguity.
  columns?: number;
}) {
  // Read at runtime from package.json via version.ts, never baked. The literal
  // that was here carried the comment "keep in sync with package.json", and
  // that is precisely the thing a comment cannot do: the release lane bumps the
  // version in CI, so any literal committed to the repo is stale at the moment
  // of publish. It said v1.18.0 while the registry had 1.18.3.
  const version = `v${VERSION}`;
  const title = `AitherShell ${version}`;

  let connected: string;
  if (info.genesisOnline === true) {
    const label = info.backendName || (info.backendType === 'adk' ? 'agent' : 'Genesis');
    connected = `Connected to ${label} (${info.genesis})`;
  } else {
    connected = `Offline (${info.genesis})`;
  }

  // Build service status line from direct probes
  const probed = info.serviceLines || [];
  const upNames = probed.filter(s => s.up).map(s => s.name);
  const downNames = probed.filter(s => !s.up).map(s => s.name);
  const upCount = upNames.length;

  const parts = [
    info.services != null ? `${info.services} services` : (upCount > 0 ? `${upCount} services` : null),
    info.agents != null ? `${info.agents} agents` : null,
    info.llm ? info.llm : null,
  ].filter(Boolean);
  const stats = parts.join(' \u00b7 ') || 'no services detected';
  const userLine = info.user ? `Logged in as ${info.user}` : '';

  // Build the service detail lines: "up: vLLM, ComfyUI, ..."  "down: Watch, ..."
  const detailLines: string[] = [];
  if (upNames.length > 0) detailLines.push(`UP: ${upNames.join(', ')}`);
  if (downNames.length > 0) detailLines.push(`DN: ${downNames.join(', ')}`);

  // MODERN LANGUAGE (2026-07-24): the old flat-cyan ASCII box with `UP:`/`DN:`
  // caps was a SECOND visual language in a shell whose boot header had already
  // moved to the gradient/hairline system \u2014 that inconsistency is what read as
  // dated. This now speaks the one system in theme.ts: a letter-spaced gradient
  // wordmark, a hairline rule, and status DOTS (\u25cf / \u25cb) instead of caps.
  const online = info.genesisOnline === true;

  // FOUR LINES, then the prompt (owner decision, 2026-08-21). This printed
  // TWELVE before you could type: a rule, two full service rosters naming every
  // component up AND down, a warming spinner, "Logged in as David" twice, a
  // keybinding row and an ad for /grid sync. A shell is a place to type, and
  // everything above the cursor is a toll paid on every single launch.
  //
  // What survived is what changes what you would DO next: is the link up, how
  // much of the fleet is up, and who you are. The per-service rosters move to
  // /status -- which is where you look when the answer to "is the link up" was
  // no, and nowhere else was that roster ever acted on.
  // WIDTH-AWARE, because the trimmed header was still 100 columns wide and 80
  // is the default terminal. A status line that WRAPS is worse than the twelve
  // lines it replaced: it costs two rows anyway and the second one is a ragged
  // fragment. Segments are dropped from the LEAST decisive end -- the down
  // count, then the model, then the service count -- so what survives at any
  // width is the one thing that changes what you do next: is the link up, and
  // to what.
  const budget = Math.max(40, (info.columns ?? process.stdout.columns ?? 80) - 4);
  // Counted by scanning, not by a regex: an ANSI-stripping pattern needs a
  // literal ESC and a backslash class, and every edit through a shell has
  // silently mangled one or the other in this file today. This needs neither.
  const ESC = String.fromCharCode(27);
  const visible = (s: string): number => {
    let n = 0;
    let inEscape = false;
    for (const ch of s) {
      if (ch === ESC) { inEscape = true; continue; }
      if (inEscape) { if (ch === 'm') inEscape = false; continue; }
      n++;
    }
    return n;
  };
  const head = T.dot(online) + ' ' + (online ? T.muted(connected) : T.bad(connected));
  // Segments are INDIVIDUAL, not one bundled string: joining them first made it
  // all-or-nothing, so an 80-column terminal lost the service count to make
  // room for a model name it could not fit either. And a segment that does not
  // fit is SKIPPED, not a stop -- otherwise one long middle segment hides every
  // shorter one behind it. Ordered most-decisive first.
  const optional: string[] = [];
  if (info.services != null) optional.push(`${info.services} services`);
  else if (upCount > 0) optional.push(`${upCount} services`);
  if (downNames.length > 0) optional.push(`${downNames.length} down`);
  if (info.agents != null) optional.push(`${info.agents} agents`);
  if (info.llm) optional.push(info.llm);
  let statusLine = head;
  for (const seg of optional) {
    const candidate = statusLine + T.dim('  ·  ') + T.dim(seg);
    if (visible(candidate) <= budget) statusLine = candidate;
  }
  console.log();
  console.log('  ' + T.wordmark() + '  ' + T.dim(version));
  console.log('  ' + statusLine);
  if (userLine) {
    console.log('  ' + T.violet(T.G.agent) + ' ' + T.dim(userLine));
  }
}

/* ── Output cleanup ────────────────────────────────────────── */

/** Decode HTML entities that LLMs dump from scraped web content. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;/g, '\u2018')
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8220;/g, '\u201C')
    .replace(/&#8221;/g, '\u201D')
    .replace(/&#038;/g, '&')
    .replace(/&#039;/g, "'");
}

/**
 * Strip website navigation chrome, cookie banners, menu dumps, and other
 * non-content noise that LLMs paste verbatim from scraped pages.
 */
function stripWebCruft(text: string): string {
  const lines = text.split('\n');
  const cleaned: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip lines that are mostly bullet-separated nav items (5+ bullets)
    if ((trimmed.match(/ • /g) || []).length >= 4) continue;

    // Skip lines that are just "Primary Menu Sections" / nav headers
    if (/^(Primary|Main|Footer|Secondary)\s+Menu/i.test(trimmed)) continue;

    // Skip cookie/consent boilerplate
    if (/^(We use cookies|Accept all|Cookie settings|Privacy Policy$)/i.test(trimmed)) continue;

    // Skip lines that are just a chain of pipe-separated short items (nav)
    if (/^(\s*\|?\s*\w[\w\s]{1,20}\s*\|){4,}/.test(trimmed)) continue;

    cleaned.push(line);
  }

  return cleaned.join('\n');
}

/* ── Markdown ───────────────────────────────────────────────── */

/**
 * Resolve `/api/files?path=...` image references to real file paths
 * and render as clickable OSC 8 terminal hyperlinks.
 */
export function resolveImagePath(relativePath: string): string {
  // ESM module — use the top-level imports, NOT require() (which is undefined
  // here and made renderMarkdown throw → raw ![](...) markdown leaked through).
  const home = homedir();
  const rel = relativePath.replace(/^\/api\/files\?path=/, '');
  // If it's already an existing absolute path, keep it.
  try { if (/^([A-Za-z]:[/\\]|\/)/.test(rel) && existsSync(rel)) return rel; } catch { /* */ }
  // Try known AitherOS roots (the Library is bind-mounted under <root>/AitherOS).
  const roots = [
    process.env.AITHER_ROOT,
    'D:\\AitherOS-Fresh',          // dev box repo root
    resolve(home, 'AitherOS-Fresh'),
    resolve(home, 'AitherOS'),
  ].filter(Boolean) as string[];
  for (const root of roots) {
    for (const sub of ['AitherOS', '']) {
      try { const p = resolve(root, sub, rel); if (existsSync(p)) return p; } catch { /* */ }
    }
  }
  return resolve(rel);  // best-effort (may not exist) — caller can check
}

/** Strip OSC-8 hyperlink escapes (blessed/TUI can't render them → raw `]8;;`). */
export function stripOsc8(text: string): string {
  // ESC ]8;;<url> ESC \  …label…  ESC ]8;; ESC \   →  keep just the label.
  return text.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x1b\\|\x07)/g, '');
}

/** The backend the shell is ACTUALLY connected to (local genesis, a remote
 *  gateway/mcp, etc.) — image URLs must resolve against IT, not a hardcoded host. */
function backendBase(): string {
  const cfg = getActiveConfig();
  const base = cfg?.genesisUrl
    || process.env.AITHER_API_URL || process.env.AITHER_GENESIS_URL
    || 'http://127.0.0.1:8001';
  return String(base).replace(/\/+$/, '');
}

/**
 * Where a HUMAN opens a panel. Deliberately NOT backendBase(): that is the
 * Genesis API (default http://127.0.0.1:8001), which does not serve the portal
 * UI — a deep link built from it 404s. Matches install-wizard.ts's convention.
 * Returns a bare origin with no /portal suffix, because the portal is served at
 * the root and appending one produces the doubled /portal/portal path.
 */
function portalBase(): string {
  const base = process.env.AITHER_PORTAL_URL || 'https://portal.aitherium.com';
  return String(base).replace(/\/+$/, '');
}

function resolveImagePaths(text: string): string {
  // Match ![alt](/api/files?path=...) or ![alt](Library/...)
  return text.replace(
    /!\[([^\]]*)\]\((?:\/api\/files\?path=)?([^)]+)\)/g,
    (_match, alt: string, rawPath: string) => {
      const label = alt || rawPath.split(/[/\\]/).pop() || 'image';
      const base = backendBase();
      const isLocalBackend = /(^|\/\/)(127\.0\.0\.1|localhost)\b/.test(base);
      // If the raw path is already a full URL, keep it.
      const isAbsUrl = /^https?:\/\//i.test(rawPath);
      let url: string;
      let shown: string;
      // Only a LOCAL backend can have the file on THIS disk (bind-mounted
      // Library). For a remote backend (gateway/mcp/…) the file lives there, so
      // always link the backend's HTTP URL — never guess a local path.
      const local = (!isAbsUrl && isLocalBackend) ? (() => {
        try { const c = resolveImagePath(rawPath); return existsSync(c) ? c : null; } catch { return null; }
      })() : null;
      if (local) {
        url = `file:///${local.replace(/\\/g, '/')}`;
        shown = local;
      } else if (isAbsUrl) {
        url = rawPath; shown = rawPath;
      } else {
        const p = rawPath.replace(/^\/api\/files\?path=/, '');
        url = `${base}/api/files?path=${encodeURIComponent(p)}`;
        shown = url;
      }
      const link = `\x1b]8;;${url}\x1b\\${chalk.cyan.underline(label)}\x1b]8;;\x1b\\`;
      return `🖼 ${link}  ${chalk.dim(shown)}`;
    },
  );
}

// Images already auto-opened this process, so we don't reopen on re-render.
const _openedImages = new Set<string>();

/** Open a local image in the OS default viewer (detached). Best-effort. */
export function openLocalImage(p: string): void {
  if (!p || _openedImages.has(p)) return;
  try { if (!existsSync(p)) return; } catch { return; }
  _openedImages.add(p);
  try {
    const plat = process.platform;
    if (plat === 'win32') spawn('cmd', ['/c', 'start', '', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (plat === 'darwin') spawn('open', [p], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* viewer unavailable — the path is still shown */ }
}

/** Scan answer text for generated-image markdown and open any LOCAL ones in the
 *  OS viewer (so the user actually SEES the image — the TUI can't render it
 *  inline). Opt out with AITHER_AUTO_OPEN_IMAGES=0. */
export function autoOpenImagesFromText(text: string): void {
  if (!text) return;
  const off = (process.env.AITHER_AUTO_OPEN_IMAGES || '').toLowerCase();
  if (off === '0' || off === 'false' || off === 'off' || off === 'no') return;
  const re = /!\[[^\]]*\]\((?:\/api\/files\?path=)?([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    if (/^https?:\/\//i.test(raw)) continue;  // remote — nothing local to open
    try { const c = resolveImagePath(raw); if (existsSync(c)) openLocalImage(c); } catch { /* */ }
  }
}

export function renderMarkdown(text: string): string {
  try {
    let clean = text;
    clean = decodeHtmlEntities(clean);
    clean = stripWebCruft(clean);
    clean = resolveImagePaths(clean);
    return marked.parse(clean) as string;
  } catch {
    return text;
  }
}

/* ── Bare Code Wrapping ────────────────────────────────────── */

/**
 * Detect unformatted code in text and wrap it in markdown fences.
 * Safety net for when the LLM ignores the prompt and dumps bare code.
 */
function wrapBareCode(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let codeBlock: string[] = [];
  let inCode = false;
  let inFence = false; // Track existing fenced regions to skip them

  const CODE_PATTERNS = /^(def |class |import |from |async def |export |const |let |var |function |if __name__|@\w+|  {2,}\S)/;

  function flushCode() {
    if (codeBlock.length >= 3) {
      // Guess language from content
      const joined = codeBlock.join('\n');
      const lang = /\b(def |import |from |async def |if __name__)/.test(joined) ? 'python'
        : /\b(const |let |var |function |export |=>)/.test(joined) ? 'javascript'
        : 'text';
      result.push('```' + lang);
      result.push(...codeBlock);
      result.push('```');
    } else {
      result.push(...codeBlock);
    }
    codeBlock = [];
    inCode = false;
  }

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Track fenced code blocks — pass them through untouched
    if (trimmed.startsWith('```')) {
      if (inCode) flushCode();
      inFence = !inFence;
      result.push(line);
      continue;
    }
    if (inFence) {
      result.push(line);
      continue;
    }

    const looksLikeCode = CODE_PATTERNS.test(trimmed) || (inCode && (trimmed === '' || /^\s{2,}\S/.test(trimmed)));

    if (looksLikeCode) {
      inCode = true;
      codeBlock.push(line);
    } else {
      if (inCode) flushCode();
      result.push(line);
    }
  }
  if (inCode) flushCode();

  return result.join('\n');
}

/* ── Stream Renderer ────────────────────────────────────────── */

export interface StreamRenderer {
  onEvent(event: SSEEvent): void;
  getContent(): string;
  /** End-of-turn cleanup. `aborted` = the user interrupted (Ctrl+C) — skip
   *  the "stream ended before completion" warning in that case. */
  finish(aborted?: boolean): void;
  /** Full trace of all events received during this session prompt. */
  getTrace(): SSEEvent[];
  /** Session profile for persistence and future reference. */
  getSessionProfile(): SessionProfile;
  /** Get the timeline instance (new-trace only, null otherwise). */
  getTimeline?(): any;
  /** Buffered rich telemetry for the trace overlays (new-trace only). */
  getThoughts?(): any[];
  getNeuronState?(): any;
  getFlameData?(): any;
  getKnowledgeGraph?(): any;
  /** Re-render the trace pane between turns (idle avatar breathing / speaking mouth). */
  renderIdleFrame?(status?: 'idle' | 'thinking' | 'talking' | 'done' | 'error'): void;
}

export interface SessionProfile {
  session_id: string;
  prompt: string;
  started_at: string;
  duration_ms: number;
  event_count: number;
  model: string;
  agent: string;
  events: SSEEvent[];
  tool_calls: Array<{ name: string; args: any; timestamp: number }>;
  thinking_traces: string[];
  context_sources: Record<string, any>;
  errors: string[];
}

export interface SessionArtifact {
  filename: string;
  path: string;
  size: number;
  language: string;
  retrieve_cmd: string;
  download_url: string;
  timestamp: string;
}

/** Module-level artifact store — accumulates across prompts in one shell session. */
let _sessionArtifacts: SessionArtifact[] = [];

export function getSessionArtifacts(): SessionArtifact[] {
  return [..._sessionArtifacts];
}

export function clearSessionArtifacts(): void {
  _sessionArtifacts = [];
}

/** Register a locally-saved file as a session artifact (so /get + /artifacts find it). */
export function addSessionArtifact(a: { path: string; size?: number; language?: string }): number {
  const filename = a.path.split(/[\\/]/).pop() || a.path;
  _sessionArtifacts.push({
    filename,
    path: a.path,
    size: a.size ?? 0,
    language: a.language || 'image',
    retrieve_cmd: `/get ${_sessionArtifacts.length + 1}`,
    download_url: '',
    timestamp: new Date().toISOString(),
  });
  return _sessionArtifacts.length;
}

export function createStreamRenderer(sessionId?: string, prompt?: string, steeringBar?: SteeringBar): StreamRenderer {
  let spinner: Ora | null = null;
  let content = '';
  let hasOutput = false;
  let isGroupChat = false;  // Set when session_start has multiple agents
  let lastThinkingContent = '';  // Track to dedup with answer event
  let completePrinted = false;   // Prevent duplicate timing lines
  const seenToolResults = new Set<string>();  // Dedup tool_result entries
  let tokenStreamed = false;  // Track if answer was delivered via token events
  let contentDisplayed = false;  // True when actual response text was written to stdout
  let tokensStarted = false;  // Once true, spinner is permanently disabled for this session
  let llmFired = false;       // Set on llm_start — suppresses post-gen middleware even without token events
  let lastStage = '';         // Current pipeline stage — shown in heartbeat spinner
  let eagerActive = false;    // Eager streaming: multiple answer_segments this turn
  let eagerSegments = 0;      // Count of segments rendered
  let segmentTokenStreamed = false;  // Did THIS segment receive token events? If a
                                     // segment header printed but no tokens arrived
                                     // (engine sent the answer as one 'answer' event),
                                     // we must print the answer ourselves or the user
                                     // is left staring at just the preamble line.

  // ── Session trace collection ──
  const traceEvents: SSEEvent[] = [];
  const traceToolCalls: SessionProfile['tool_calls'] = [];
  const traceThinking: string[] = [];
  const traceErrors: string[] = [];
  let traceContextSources: Record<string, any> = {};
  let traceModel = '';
  let traceAgent = '';
  let traceTurns = 0;
  let lastKnownMaxTurns: number | string = '?';  // Populated by turn_progress
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  function stopSpinner() {
    if (steeringBar?.active) {
      steeringBar.clearStatus();
    }
    if (spinner) { spinner.stop(); spinner = null; }
  }

  /**
   * Start or update the spinner with new text.
   *
   * When SteeringBar is active, status is shown INSIDE the bar (no ora).
   * This prevents stderr (ora) from fighting stdout (bar) for cursor control.
   *
   * Once token streaming begins, the spinner is permanently disabled.
   */
  function startSpinner(text: string) {
    if (tokensStarted) return;
    // When SteeringBar is active, show status in the bar — no ora
    if (steeringBar?.active) {
      // Kill any lingering ora instance
      if (spinner) { spinner.stop(); spinner = null; }
      steeringBar.setStatus(text.replace(/\x1b\[[0-9;]*m/g, ''));  // strip ANSI colors
      return;
    }
    if (spinner) {
      spinner.text = text;
      if (!(spinner as any).isSpinning) spinner.start();
    } else {
      spinner = ora({ text, spinner: 'dots', discardStdin: false }).start();
    }
  }

  function printIndentedBlock(text: string, indent = '     ', color: (value: string) => string = chalk.dim) {
    stopSpinner();
    const lines = String(text)
      .replace(/\r\n/g, '\n')
      .split('\n');

    for (const line of lines) {
      console.log(color(`${indent}${line}`));
    }
  }

  /** console.log wrapper that auto-clears the spinner before writing.
   *  Prevents spinner ANSI escape codes from mixing with event output. */
  function log(...args: Parameters<typeof console.log>) {
    stopSpinner();
    console.log(...args);
  }

  return {
    onEvent(event: SSEEvent) {
      // ── Collect every event for session trace ──
      traceEvents.push({ ...event, data: { ...event.data, _ts: Date.now() } });

      switch (event.type) {
        case 'session_start':
          if (event.data.group && Array.isArray(event.data.group) && event.data.group.length > 1) {
            isGroupChat = true;
          }
          if (event.data.agent) traceAgent = event.data.agent;
          // Skip the "auto"/"unknown" placeholder — the real model arrives in
          // llm_start / complete. Capturing it here is why the footer said "auto".
          if (event.data.model && event.data.model !== 'auto' && event.data.model !== 'unknown') {
            traceModel = event.data.model;
          }
          startSpinner(chalk.dim(`${event.data.agent || 'thinking'}...`));
          break;

        case 'thinking': {
          const rawThought = event.data.thought || event.data.content || '';
          const turnNum = event.data.turn;
          const phase = event.data.phase || '';
          // Clean up <think> tags
          const clean = rawThought.replace(/<\/?think(?:ing)?>/g, '').trim();

          if (phase === 'streaming' && clean) {
            // ── LIVE chain-of-thought streaming ──
            // Stream reasoning tokens as they arrive, like AitherChat does
            stopSpinner();
            // Use carriage return to overwrite previous streaming line
            const preview = clean.split('\n').filter((l: string) => l.trim()).slice(-3).join(' ').slice(-200);
            process.stdout.write(`\r${chalk.magenta('  💭 ')}${chalk.dim(preview)}${' '.repeat(20)}`);
          } else if (phase === 'complete' && clean) {
            // ── Full reasoning block complete ──
            // Clear the streaming line, then print the full thought
            process.stdout.write(T.clearLine());
            log(chalk.magenta('  💭 Reasoning complete:'));
            // Show full reasoning, wrapped nicely
            const lines = clean.split('\n').filter((l: string) => l.trim());
            for (const line of lines) {
              log(chalk.dim(`     ${line}`));
            }
            lastThinkingContent = clean;
            traceThinking.push(clean);
          } else if (turnNum != null && clean && clean !== 'thinking...' && clean.length > 5) {
            // ── Agentic turn thought ──
            stopSpinner();
            lastThinkingContent = clean;
            const turnLabel = chalk.cyan(`  [Turn ${turnNum}]`);
            // Show full reasoning trace, not just first line
            const lines = clean.split('\n').filter((l: string) => l.trim());
            for (const line of lines) {
              log(`${turnLabel} ${chalk.dim(line)}`);
            }
          } else if (clean.length > 10) {
            // Post-completion thinking block — show full chain of thought
            stopSpinner();
            lastStage = 'reasoning';
            const thinkLines = clean.split('\n').filter((l: string) => l.trim());
            if (thinkLines.length > 8) {
              log(chalk.magenta('  💭 Chain of thought:'));
              for (const line of thinkLines) {
                log(chalk.dim(`     ${line}`));
              }
            } else {
              for (const line of thinkLines) {
                log(chalk.dim(`  💭 ${line}`));
              }
            }
            traceThinking.push(clean);
          } else if (spinner) {
            spinner.text = chalk.dim(clean || 'thinking...');
          } else if (!hasOutput) {
            startSpinner(chalk.dim(clean || 'thinking...'));
          }
          break;
        }

        case 'thinking_end': {
          // Only clear the streaming thinking line if we haven't started
          // writing answer tokens — otherwise we'd erase the answer.
          if (!tokensStarted && !contentDisplayed) {
            process.stdout.write(T.clearLine());
          }
          break;
        }

        case 'progress':
        case 'status': {
          const msg = event.data.message || event.data.phase || event.data.status || '';
          const phase = event.data.phase || '';
          // Print ALL meaningful pipeline stages as visible lines
          const _printablePhases = new Set([
            'tool_reg_start', 'tool_reg_done', 'discovery_start',
            'notebook_start', 'orchestrator_start', 'runtime_start',
            'affect_start', 'prefire_start', 'facet_plan_start',
            'plan_start', 'planner_start', 'planner_done',
            'research_start',
            // Classification start
            'classify_start',
            // IntentPlanner sub-phases
            'decompose_start', 'tool_match', 'critique_start',
            // Context assembly sub-phases
            'context_neurons', 'context_memory', 'context_graph',
            'context_affect', 'context_flux',
            // Tool execution phases
            'tool_executing',
          ]);
          if (_printablePhases.has(phase) && msg) {
            stopSpinner();
            log('  ' + T.dim(T.G.step + ' ' + msg));
            startSpinner(chalk.dim(msg));
          } else if (msg) {
            if (steeringBar?.active) {
              steeringBar.setStatus(msg);
            } else if (spinner) {
              spinner.text = chalk.dim(msg);
            }
          }
          break;
        }

        case 'answer_segment': {
          // Eager streaming: a new answer block (initial fast pass, or a
          // refinement once background enrichment lands). Print a header and
          // reset per-segment streaming state so tokens render cleanly.
          eagerActive = true;
          eagerSegments += 1;
          stopSpinner();
          const segKind = event.data.kind || 'initial';
          const segReason = event.data.reason ? chalk.dim(` (${event.data.reason})`) : '';
          if (hasOutput) process.stdout.write('\n');
          // Themed segment headers (one design system — see theme.ts). The old
          // labels mixed an emoji (💬) with flat chalk.cyan; these use the house
          // glyph set + accent so the stream reads as one system.
          if (segKind === 'continuation') {
            log('  ' + T.accent(T.G.continue) + ' ' + T.muted('Continuing') + segReason);
          } else if (segKind === 'refinement') {
            log('  ' + T.violet(T.G.refine) + ' ' + T.muted('Refining') + segReason);
          } else {
            log('  ' + T.accent(T.G.answer) + ' ' + T.muted('Answering') + segReason);
          }
          tokensStarted = false;  // re-enter first-token path for this segment
          segmentTokenStreamed = false;  // reset per-segment token tracking
          content = '';           // per-segment accumulator (final captured at complete)
          break;
        }

        case 'segment_end': {
          if (!content.endsWith('\n')) process.stdout.write('\n');
          break;
        }

        case 'token': {
          stopSpinner();
          if (!tokensStarted) {
            tokensStarted = true;  // Permanently disable spinner for this response
            // Clear any residual progress/thinking line before first token.
            // TTY-gated: emitting cursor ANSI into a PIPE leaked literal `[2K`
            // garbage into `aither -p` / --json output (found 2026-07-24).
            process.stdout.write(T.clearLine());
            if (steeringBar?.active) steeringBar.enterTokenMode();
          }
          const t = decodeHtmlEntities(event.data.t || '');
          content += t;
          process.stdout.write(t);
          hasOutput = true;
          tokenStreamed = true;
          segmentTokenStreamed = true;
          contentDisplayed = true;
          break;
        }

        case 'message':
        case 'answer':
        case 'final_answer': {
          stopSpinner();
          // Eager streaming already rendered the answer as live segments —
          // the terminal `answer` event is normally just the canonical copy
          // for trace/getContent. BUT if the current segment printed a header
          // ("💬 Initial …") yet no token events streamed (the engine returned
          // the answer as a single 'answer' event, e.g. the search fastpath),
          // the user would see only the preamble. In that case print it now.
          if (eagerActive) {
            // Field order unified with the non-eager path below (and the
            // complete-event fallback) — a prior mismatch meant an answer
            // landing in `response` (not `answer`/`content`) never rendered
            // here, silently falling back to whatever `content` held before.
            const eagerAnswer = event.data.response || event.data.answer || event.data.content || content;
            if (!segmentTokenStreamed && eagerAnswer && eagerAnswer.trim()) {
              process.stdout.write(T.clearLine());
              process.stdout.write(renderMarkdown(wrapBareCode(eagerAnswer)));
              if (!eagerAnswer.endsWith('\n')) process.stdout.write('\n');
              segmentTokenStreamed = true;  // guard against double-print at complete
            } else if (segmentTokenStreamed && eagerAnswer && eagerAnswer.length > content.length
                       && eagerAnswer.startsWith(content)) {
              // The authoritative answer is LONGER than what streamed. Seen
              // live 2026-08-23: the omnibox printed "...If you're asking
              // about so" and stopped, while the `answer` event carried the
              // whole sentence — and this branch discarded it. Print the tail
              // rather than show a cut-off answer as if it were the answer.
              process.stdout.write(eagerAnswer.slice(content.length));
              if (!eagerAnswer.endsWith('\n')) process.stdout.write('\n');
            }
            content = eagerAnswer;
            contentDisplayed = true;
            hasOutput = true;
            break;
          }
          // Clear any residual spinner/thinking line
          process.stdout.write(T.clearLine());
          const answer = event.data.response || event.data.answer || event.data.content || '';
          if (answer) {
            // Dedup: skip if already printed (AgentRuntime emits final_answer,
            // then the router emits answer with the same content)
            if (content && answer.trim() === content.trim()) {
              break;
            }
            if (!hasOutput) process.stdout.write('\n');
            // Group-chat: label each agent's response when multiple agents respond
            const answerAgent = event.data.agent || '';
            if (isGroupChat && answerAgent) {
              process.stdout.write(chalk.bold.cyan(`\n  [${answerAgent}]\n`));
            }
            content = answer;
            // A job-routed acknowledgment ("On it — running this as background
            // job...") looks identical to a real answer otherwise — the user
            // has no visual cue that this ISN'T the actual result, just a
            // dispatch confirmation. Prefix it distinctly.
            const jobId = event.data.metadata?.job_id;
            if (event.data.metadata?.job_routed && jobId) {
              process.stdout.write(chalk.yellow(`⏳ Job ${jobId} started\n`));
            }
            // Write answer text immediately — don't block on heavy markdown
            // rendering. Markdown is deferred to the 'complete' handler for
            // responses that contain code blocks.
            process.stdout.write(answer);
            if (!answer.endsWith('\n')) process.stdout.write('\n');
            hasOutput = true;
            contentDisplayed = true;
          }
          // Render interactive/display blocks in terminal
          const blocks = event.data.render_blocks;
          if (blocks && Array.isArray(blocks) && blocks.length > 0) {
            process.stdout.write('\n');
            renderTerminalBlocks(blocks);
          }
          break;
        }

        case 'render_blocks':
        case 'await_input': {
          stopSpinner();
          const rblocks = event.data.render_blocks || event.data.blocks || [];
          if (rblocks.length > 0) {
            renderTerminalBlocks(rblocks);
          }
          if (event.data.prompt) {
            log(chalk.yellow(`\n  ⏳ ${event.data.prompt}`));
          }
          break;
        }

        case 'partial': {
          stopSpinner();
          const partial = event.data.content || event.data.text || '';
          if (partial && !hasOutput) {
            content = partial;
            process.stdout.write(partial);
            hasOutput = true;
          }
          break;
        }

        case 'tool_decision': {
          // Pre-execution preamble: names the chosen tools the instant they're
          // parsed, before the (silent) tool execution wait.
          stopSpinner();
          const preamble = event.data.preamble
            || `Calling tools: ${(event.data.tools || []).join(', ')}`;
          log('  ' + chalk.yellow(`⚡ ${preamble}`));
          break;
        }

        case 'tool_call_preview': {
          // Trace-only: the model committed to a tool NAME mid-stream. Shown the
          // instant it's known; execution still happens from the done chunk.
          stopSpinner();
          const argHint = event.data.arguments_preview
            ? chalk.gray(` ${String(event.data.arguments_preview).slice(0, 80)}`)
            : '';
          log('  ' + chalk.yellow(`🔧 Calling ${event.data.name || 'tool'}…`) + argHint);
          break;
        }

        case 'tool_call': {
          stopSpinner();
          const turnLabel2 = event.data.turn != null ? chalk.cyan(`[Turn ${event.data.turn}] `) : '';
          const tools = event.data.tools || event.data.tool_calls || [];
          for (const tool of tools) {
            const name = tool.name || tool.function?.name || 'tool';
            const args = tool.args || tool.arguments;
            traceToolCalls.push({ name, args, timestamp: Date.now() });
            // Show the most useful argument (query, url, task, prompt, etc.)
            let argDisplay = '';
            if (args) {
              const key = args.query || args.url || args.task || args.prompt || args.path || args.code;
              if (key) {
                argDisplay = chalk.dim(` → ${String(key)}`);
              } else {
                argDisplay = chalk.dim(` ${JSON.stringify(args)}`);
              }
            }
            log(`  ${turnLabel2}` + chalk.yellow(`⚡ ${name}`) + argDisplay);
          }
          break;
        }

        case 'tool_result': {
          const results = event.data.results || [];
          let anySuccessfulOutput = false;
          for (const result of results) {
            // Dedup: skip identical tool+output combos (LLM may call the
            // same tool twice across follow-up turns)
            const dedupKey = `${result.tool || 'tool'}::${(result.output || '').slice(0, 200)}`;
            if (seenToolResults.has(dedupKey)) continue;
            seenToolResults.add(dedupKey);

            const icon = result.success !== false ? chalk.green('\u2713') : chalk.red('\u2717');
            const name = result.tool || 'tool';
            if (result.success !== false && result.output) anySuccessfulOutput = true;

            if (result.output && result.success !== false) {
              try {
                const parsed = JSON.parse(result.output);

                // ── Search results: expand each result ──
                if (parsed.results && Array.isArray(parsed.results) && parsed.results.length > 0) {
                  log(`  ${icon} ${chalk.bold(name)} — ${parsed.results.length} results:`);
                  if (parsed.answer && parsed.answer.length > 0) {
                    printIndentedBlock(`📝 ${decodeHtmlEntities(parsed.answer)}`);
                  }
                  for (const [idx, r] of parsed.results.entries()) {
                    const title = decodeHtmlEntities(r.title || 'Untitled');
                    const snippet = decodeHtmlEntities(r.snippet || r.body || '');
                    log(chalk.white(`     ${idx + 1}. ${title}`));
                    if (snippet) {
                      printIndentedBlock(snippet, '        ');
                    }
                  }
                }
                // ── Webpage fetch: show title + clean content preview ──
                else if (parsed.content) {
                  const title = parsed.title ? decodeHtmlEntities(parsed.title) + ' — ' : '';
                  const cleanContent = stripWebCruft(decodeHtmlEntities(parsed.content));
                  log(`  ${icon} ${chalk.bold(name)}`);
                  printIndentedBlock(`${title}${cleanContent}`);
                }
                // ── Generic JSON ──
                else {
                  log(`  ${icon} ${chalk.bold(name)}:`);
                  printIndentedBlock(JSON.stringify(parsed, null, 2));
                }
              } catch {
                // Non-JSON output
                const lines = String(result.output).split('\n').filter((l: string) => l.trim());
                log(`  ${icon} ${chalk.bold(name)}:`);
                for (const line of lines) {
                  printIndentedBlock(line);
                }
              }
            } else if (result.success === false) {
              const err = result.output || result.error || 'unknown error';
              log(`  ${icon} ${chalk.bold(name)}:`);
              printIndentedBlock(String(err), '     ', chalk.red);
            } else {
              log(`  ${icon} ${name}`);
            }
          }
          // Mark that we showed tool output — prevents '(no response)'
          // when the LLM's text answer is empty but tools returned data
          if (anySuccessfulOutput) hasOutput = true;
          break;
        }

        case 'suggested_followups': {
          // Proactive next-steps. Plain REPL is append-only (no digit-select);
          // the eager answer already streamed above, so these land beneath it.
          const fups = Array.isArray(event.data.followups) ? event.data.followups : [];
          if (fups.length) {
            process.stdout.write('\n' + chalk.dim('  Next →') + '\n');
            fups.forEach((t: any, i: number) =>
              process.stdout.write('  ' + chalk.cyan(`[${i + 1}]`) + ' ' + chalk.dim(String(t)) + '\n'));
            hasOutput = true;
          }
          break;
        }

        case 'done':
        case 'complete': {
          stopSpinner();
          if (steeringBar?.active) steeringBar.exitTokenMode();
          // Only render content + timing once (engine + router can both emit 'complete')
          if (completePrinted) break;
          completePrinted = true;

          // Field order unified with the 'answer' handler above — this
          // fallback previously checked ONLY `content`, so a final answer
          // that arrived exclusively via the complete event (no prior
          // token/answer events) in the `response` field was silently
          // never displayed.
          const completeAnswer = event.data.response || event.data.answer || event.data.content;
          if (!contentDisplayed && completeAnswer) {
            content = completeAnswer;
            process.stdout.write(T.clearLine());
            process.stdout.write(renderMarkdown(wrapBareCode(content)));
            hasOutput = true;
            contentDisplayed = true;
          } else if (tokenStreamed && !eagerActive) {
            // Content was streamed raw via token events — re-render with
            // markdown so code blocks display properly. wrapBareCode catches
            // bare code even when no fences are present.
            // Skipped in eager mode: segments already streamed as plain text
            // and `content` only holds the last segment, so a markdown
            // re-render would duplicate / mangle the multi-segment output.
            const wrapped = wrapBareCode(content);
            if (wrapped !== content || content.includes('```')) {
              process.stdout.write('\n');
              process.stdout.write(renderMarkdown(wrapped));
            }
          }
          if (hasOutput) process.stdout.write('\n');
          autoOpenImagesFromText(content);  // pop generated images in the OS viewer

          // Update trace vars from the authoritative complete event, then let
          // finish() print the SINGLE canonical footer. Printing a footer here
          // too caused the duplicate "[model \u00b7 ms \u00b7 agent]" + "[agent | model
          // | time]" lines the user saw.
          const _cm = event.data.model || event.data.model_used;
          if (_cm && _cm !== 'auto' && _cm !== 'unknown') traceModel = _cm;
          if (event.data.agent) traceAgent = event.data.agent;
          if (event.data.turns_completed) traceTurns = event.data.turns_completed;
          break;
        }

        case 'error':
          stopSpinner();
          log(chalk.red(`\n  Error: ${event.data.error || 'unknown error'}`));
          traceErrors.push(String(event.data.error || 'unknown error'));
          break;

        case 'stream_timeout':
          // Soft timeout — stream went quiet but agent may still be running.
          // Don't show a hard error; the REPL will check forge status.
          stopSpinner();
          hasOutput = true;  // Prevent "(no response)" — we already showed trace output
          break;

        case 'stream_interrupted':
          // Transport died mid-turn (backend/LB restart) — unlike a soft
          // timeout the connection is GONE, so say so instead of going silent.
          stopSpinner();
          log(chalk.yellow(`\n  ⚠ Stream interrupted — ${event.data.error || 'connection lost'}`));
          log(chalk.dim('  The backend connection dropped mid-turn; any answer above is partial. Resend to retry.'));
          traceErrors.push(`stream interrupted: ${event.data.error || 'connection lost'}`);
          hasOutput = true;
          break;

        case 'backend_switch':
          // Mid-turn failover: local backend died, we repointed at the cloud
          // gateway and are finishing the turn there. Always visible.
          stopSpinner();
          log(chalk.yellow(`\n  ⚠ ${event.data.message || 'Switched to the cloud gateway.'}`));
          break;

        case 'heartbeat':
        case 'keepalive': {
          const elapsedMs = event.data.elapsed_ms || event.data.elapsed;
          if (elapsedMs != null) {
            const secs = Math.round(elapsedMs / 1000);
            const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
            const stageHint = lastStage ? ` · ${lastStage}` : '';
            const statusMsg = `Working... ${elapsed} elapsed${stageHint}`;
            if (steeringBar?.active) {
              steeringBar.setStatus(statusMsg);
            } else if (spinner) {
              spinner.text = chalk.dim(statusMsg);
            }
            if (secs > 0 && secs % 30 === 0) {
              stopSpinner();
              log(chalk.dim(`  ⏱ Still working... ${elapsed}${stageHint}`));
              startSpinner(chalk.dim(statusMsg));
            }
          } else {
            const stageHint = lastStage ? ` · ${lastStage}` : '';
            if (steeringBar?.active) {
              steeringBar.setStatus(`Working...${stageHint}`);
            } else if (spinner) {
              spinner.text = chalk.dim(`Working...${stageHint}`);
            } else if (!hasOutput) {
              startSpinner(chalk.dim('Working...'));
            }
          }
          break;
        }

        case 'debug':
          break; // silent

        // ── LLM lifecycle events — show what the model is doing ──
        case 'llm_start': {
          const llmModel = event.data.model || 'auto';
          const llmTurn = event.data.turn;
          const turnHint = llmTurn != null ? ` (turn ${llmTurn})` : '';
          lastStage = `inference: ${llmModel}`;
          startSpinner(chalk.dim(`🧠 LLM inference: ${llmModel}${turnHint}`));
          break;
        }

        case 'llm_done': {
          const llmMs = event.data.llm_time_ms || event.data.elapsed_ms || event.data.duration_ms || 0;
          const llmTokens = event.data.tokens_used || event.data.tokens || event.data.completion_tokens || 0;
          const llmMod = event.data.model_used || event.data.model || '';
          const hasTools = event.data.has_tool_calls;
          stopSpinner();
          const parts: string[] = [];
          if (llmMs > 0) parts.push(`${Math.round(llmMs)}ms`);
          if (llmTokens > 0) parts.push(`${llmTokens} tokens`);
          if (llmMod) parts.push(llmMod);
          if (hasTools) parts.push('+ tool calls');
          if (parts.length > 0) {
            log(chalk.dim(`  ⚡ LLM: ${parts.join(' · ')}`));
          }
          lastStage = '';
          break;
        }

        case 'llm_error': {
          stopSpinner();
          const llmErr = event.data.error || 'inference failed';
          log(chalk.red(`  ⚡ LLM error: ${llmErr}`));
          traceErrors.push(`LLM: ${llmErr}`);
          lastStage = '';
          break;
        }

        // ── Pipeline trace events — show in spinner ──
        case 'classify': {
          const intent = event.data.intent?.type || '?';
          const effort = event.data.effort?.level || '?';
          const tier = event.data.effort?.tier || '';
          const followupBoost = event.data.effort?.followup_boost || 0;
          const oneshot = event.data.effort?.oneshot || false;
          const depth = event.data.depth_label || '';
          let effortLine = `  📋 Intent: ${intent} | Effort: ${effort}`;
          if (tier) effortLine += ` | Tier: ${tier}`;
          if (depth) effortLine += ` | Depth: ${depth}`;
          if (followupBoost > 0) effortLine += ` (+${followupBoost} follow-up)`;
          if (oneshot) effortLine += ` ⚡ one-shot`;
          log(chalk.dim(effortLine));
          break;
        }

        // promotion_suggested handled below (near line 1050+)

        case 'classify_update': {
          const updatedIntent = event.data.intent?.type || '?';
          const updatedEffort = event.data.effort?.level || '?';
          const reason = event.data.reason || 'context';
          log(chalk.dim(`  📋 Intent: ${updatedIntent} | Effort: ${updatedEffort} (${reason})`));
          break;
        }

        case 'model_select': {
          const model = event.data.model_selection?.recommended_model || 'auto';
          const tier = event.data.model_selection?.tier || 'auto';
          log(chalk.dim(`  🎯 Model: ${model} (${tier})`));
          break;
        }

        case 'context_assembly': {
          const tokens = event.data.total_tokens || 0;
          const gatherMs = event.data.gather_time_ms || 0;
          const sources = event.data.sources || {};
          traceContextSources = sources;
          const sourceEntries = Object.entries(sources);
          if (sourceEntries.length > 0) {
            stopSpinner();
            log(chalk.dim(`  📦 Context assembled: ${tokens} tokens (${gatherMs}ms)`));
            for (const [name, info] of sourceEntries) {
              const si = info as any;
              const toks = si.tokens || 0;
              const extra = si.fired ? ` (${si.fired} fired)` : '';
              const bar = toks > 0 ? chalk.green('█'.repeat(Math.min(Math.ceil(toks / 50), 20))) : chalk.red('—');
              log(chalk.dim(`     ${bar} ${name}: ${toks} tokens${extra}`));
            }
            startSpinner(chalk.dim('Building prompt...'));
          } else {
            log(chalk.dim(`  📦 Context: ${tokens} tokens`));
          }
          break;
        }

        case 'context_xray': {
          // Rich context introspection — show what made it into the prompt
          const snapshot = event.data.snapshot_id || '';
          const totalCtx = event.data.total_context_tokens || 0;
          const breakdown = event.data.breakdown || {};
          if (Object.keys(breakdown).length > 0) {
            log(chalk.dim(`  🔬 Context X-Ray: ${totalCtx} tokens ${snapshot ? `(${snapshot})` : ''}`));
            for (const [k, v] of Object.entries(breakdown)) {
              log(chalk.dim(`     ${k}: ${v}`));
            }
          }
          break;
        }

        case 'context_summary': {
          const origTokens = event.data.original_tokens || 0;
          const summTokens = event.data.summary_tokens || 0;
          if (origTokens > 0) {
            const pct = summTokens > 0 ? Math.round((1 - summTokens / origTokens) * 100) : 0;
            log(chalk.dim(`  📝 Context compressed: ${origTokens} → ${summTokens} tokens (${pct}% reduction)`));
          }
          break;
        }

        case 'clarification_needed': {
          stopSpinner();
          const questions = event.data.questions || [];
          const planSummary = event.data.plan_summary || '';
          if (planSummary) {
            log(chalk.cyan(`\n  📋 Plan: `) + chalk.dim(planSummary));
          }
          if (questions.length > 0) {
            log(chalk.yellow(`\n  ⏸ Clarification needed:`));
            for (const [i, q] of questions.entries()) {
              const qText = typeof q === 'string' ? q : (q.question || q.text || '?');
              const opts = (typeof q === 'object' && q.suggested_options) ? chalk.dim(`  Options: ${q.suggested_options.join(', ')}`) : '';
              log(chalk.white(`     ${i + 1}. ${qText}`) + opts);
            }
            log(chalk.dim('\n  💡 Just type your answer — it will continue the plan automatically.'));
          }
          hasOutput = true;
          break;
        }

        case 'plan_refined': {
          stopSpinner();
          const refined = event.data.plan_summary || '';
          const executable = event.data.is_executable ? chalk.green(' [ready]') : '';
          if (refined) {
            log(chalk.cyan(`\n  📋 Plan refined: `) + chalk.dim(refined) + executable);
          }
          // Restart spinner so heartbeats keep showing liveness
          startSpinner(chalk.dim('Executing plan...'));
          break;
        }

        case 'plan_ready': {
          stopSpinner();
          // Backend sends summary string, not steps array
          const summary = event.data.summary || '';
          const steps = event.data.steps || [];
          if (summary) {
            const agentic = event.data.agentic ? chalk.cyan(' [agentic]') : '';
            log(chalk.cyan(`\n  📋 Plan: `) + chalk.dim(summary) + agentic);
          } else if (steps.length > 0) {
            log(chalk.cyan(`\n  📋 Plan: ${steps.length} steps`));
            for (const [i, step] of steps.entries()) {
              const task = typeof step === 'string' ? step : (step.task || step.description || '?');
              log(chalk.dim(`     ${i + 1}. ${task}`));
            }
          }
          // Restart spinner so heartbeats keep showing liveness
          startSpinner(chalk.dim('Executing plan...'));
          break;
        }

        case 'plan_step': {
          const icon = event.data.status === 'complete' ? chalk.green('✓') : chalk.yellow('→');
          log(chalk.dim(`  ${icon} ${event.data.step || '?'}`));
          break;
        }

        case 'approval_required': {
          stopSpinner();
          log(chalk.yellow(`\n  ⏸ Approval required: ${event.data.action || event.data.reason || 'plan review'}`));
          log(chalk.dim('    (use web UI to respond, or /approve to continue)'));
          break;
        }

        case 'tool_selection': {
          const tools = (event.data.tool_names || event.data.detected_categories || []).join(', ') || 'none';
          const strategy = event.data.strategy || '';
          log(chalk.dim(`  🔧 Tools: [${tools}]${strategy ? ` strategy=${strategy}` : ''}`));
          break;
        }

        case 'tool_loop_step': {
          // Individual tool completion within the multi-turn tool loop
          const stepName = event.data.tool_name || 'tool';
          const stepOk = event.data.success !== false;
          const stepMs = event.data.elapsed_ms || 0;
          const stepIcon = stepOk ? chalk.green('\u2713') : chalk.red('\u2717');
          const msHint = stepMs > 0 ? chalk.dim(` (${stepMs}ms)`) : '';
          log(`  ${stepIcon} ${chalk.bold(stepName)}${msHint}`);
          break;
        }

        case 'checkpoint': {
          const turn = event.data.turn || '?';
          const maxTurns = event.data.max_turns || lastKnownMaxTurns || '?';
          if (event.data.max_turns) lastKnownMaxTurns = event.data.max_turns;
          const ok = event.data.ok || 0;
          const errors = event.data.errors || 0;
          const totalCalls = event.data.total_tool_calls || 0;
          const budgetPct = event.data.budget_pct || 0;
          const elapsed = event.data.elapsed_ms ? `${event.data.elapsed_ms}ms` : '';
          // Show progress bar
          const filled = Math.round(budgetPct / 10);
          const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
          const errStr = errors > 0 ? chalk.red(` ${errors} err`) : '';
          log(chalk.dim(`  ── Turn ${turn}/${maxTurns} [${bar}] ${ok} ok${errStr} · ${totalCalls} total calls · ${elapsed}`));
          break;
        }

        case 'ooda_observe': {
          stopSpinner();
          const calls = event.data.tool_calls || 0;
          const ok = event.data.successes || 0;
          const turn3 = event.data.turn || '?';
          const maxT = event.data.max_turns || lastKnownMaxTurns || '?';
          log(chalk.dim(`  🔍 observe: Turn ${turn3}/${maxT} — ${ok}/${calls} tools ok`));
          break;
        }

        case 'ooda_decide': {
          const phase = event.data.phase || 'decide';
          const reason = event.data.reason || '';
          // Always show OODA decisions — they explain what the agent is doing
          if (reason) {
            stopSpinner();
            log(chalk.dim(`  🔄 ${phase}: ${reason}`));
          } else if (spinner) {
            spinner.text = chalk.dim(`OODA ${phase}`);
          }
          if (event.data.strip_tools) {
            log(chalk.dim('  🔄 Synthesizing from gathered data...'));
          }
          break;
        }

        case 'ooda_delegate': {
          stopSpinner();
          const target = event.data.delegate_to || '?';
          const reason = event.data.reason || '';
          log(chalk.yellow(`  🤝 Delegation → ${target}: ${reason}`));
          break;
        }

        case 'loop_guard': {
          log(chalk.red(`  ⛔ Loop guard: ${event.data.tool} — ${event.data.reason || 'blocked'}`));
          break;
        }

        case 'speculative_fire': {
          stopSpinner();
          const specTools = (event.data.tools || []).join(', ');
          log(chalk.cyan(`  🚀 Pre-firing: [${specTools}] (parallel speculative execution)`));
          break;
        }

        case 'speculative_result': {
          stopSpinner();
          const fired = event.data.tools_fired?.length || 0;
          const succeeded = event.data.tools_succeeded?.length || 0;
          const chars = event.data.total_chars || 0;
          log(chalk.green(`  ✓ Pre-fetched: ${succeeded}/${fired} tools returned data (${chars} chars)`));
          break;
        }

        case 'turn_start': {
          // Start spinner for new agent turn
          startSpinner(chalk.dim(`Turn ${event.data.turn || '?'}...`));
          break;
        }

        case 'escalation': {
          stopSpinner();
          log(chalk.yellow(`  ⬆ Escalation #${event.data.attempt || 1}: ${event.data.reason || 'quality'}`));
          break;
        }

        case 'reasoning_start':
        case 'reasoning_engage': {
          const rawDepth = event.data.depth || 'deep';
          // Map internal labels to user-friendly display
          const depth = rawDepth === 'skip' ? 'light' : rawDepth === 'none' ? 'light' : rawDepth;
          const reason = event.data.reason || event.data.content || '';
          if (spinner) {
            spinner.text = chalk.dim(`Reasoning (${depth}): ${reason || '...'}`);
          }
          // Show reasoning trace content when available
          if (reason.length > 30) {
            log(chalk.dim(`  🧠 Reasoning (${depth}): ${reason}`));
          }
          break;
        }

        case 'reasoning_strategy': {
          stopSpinner();
          const index = event.data.strategy != null ? `#${event.data.strategy}` : '';
          const name = event.data.name || event.data.strategy_name || 'strategy';
          const detail = event.data.detail || event.data.content || '';
          log(chalk.dim(`  🧠 Strategy ${index} ${name}`.trimEnd()));
          if (detail) {
            printIndentedBlock(detail);
          }
          break;
        }

        case 'reasoning_trace':
        case 'reasoning_step': {
          const step = event.data.content || event.data.step || event.data.trace || '';
          if (step) {
            stopSpinner();
            log(chalk.dim('  🧠 Reasoning step:'));
            printIndentedBlock(step);
          }
          break;
        }

        case 'agentic_upgrade': {
          stopSpinner();
          const reason = event.data.reason || 'auto';
          log(chalk.cyan(`  🔀 Agentic mode: ${reason}`));
          break;
        }

        case 'promotion_suggested': {
          stopSpinner();
          const sugEffort = event.data.suggested_effort || '?';
          const sugReason = event.data.reason || '';
          const sugMsg = event.data.message || '';
          log(chalk.yellow(`\n  ⬆ ${sugMsg || `Suggest escalation to effort ${sugEffort}: ${sugReason}`}`));
          break;
        }

        case 'council':
        case 'council_perspective': {
          const agent = event.data.agent || 'council';
          const content = event.data.perspective || event.data.consensus || '';
          if (content) {
            log(chalk.magenta(`  👥 ${agent}: `) + chalk.dim(content));
          }
          break;
        }

        case 'agent_message': {
          const agentName = event.data.agent || 'agent';
          log(chalk.blue(`  🤖 ${agentName}: `) + chalk.dim(event.data.content || ''));
          break;
        }

        case 'steering_guide': {
          log(chalk.yellow(`  🔄 Steering: ${event.data.hook || '?'} → ${event.data.reason || 'guided'}`));
          if (event.data.suggestion) {
            log(chalk.dim(`     💡 ${event.data.suggestion}`));
          }
          break;
        }

        case 'think_start': {
          // Show think configuration as a visible pipeline trace
          const model = event.data.model || 'auto';
          const effort = event.data.effort_level || '?';
          const reasoning = event.data.use_reasoning ? 'reasoning' : 'standard';
          const elapsed = event.data.elapsed_ms ? `${event.data.elapsed_ms}ms` : '';
          log('  ' + T.dim(T.G.step + ` think E${effort} ${reasoning} · ${model} ${elapsed}`));
          break;
        }

        // ── UCB pipeline stages — context gathering + LLM call ──
        case 'context_start': {
          const sources = (event.data.sources || []).join(', ') || 'none';
          startSpinner(chalk.dim(`Gathering context: ${sources}`));
          break;
        }

        case 'context_done': {
          const gatherMs2 = event.data.gather_time_ms || 0;
          const sourceResults = event.data.sources || {};
          const sourceNames = Object.keys(sourceResults);
          const neuronsFired = event.data.neurons_fired || 0;
          const cacheHits = event.data.cache_hits || 0;
          const ctxTokens = event.data.context_tokens || event.data.system_prompt_tokens || 0;
          if (sourceNames.length > 0) {
            stopSpinner();
            const extras: string[] = [];
            if (neuronsFired > 0) extras.push(`${neuronsFired} neurons`);
            if (cacheHits > 0) extras.push(`${cacheHits} cache hits`);
            if (ctxTokens > 0) extras.push(`${ctxTokens} tokens`);
            const extStr = extras.length > 0 ? ` · ${extras.join(', ')}` : '';
            log(chalk.dim(`  📦 Context gathered: ${sourceNames.join(', ')} (${gatherMs2}ms${extStr})`));
            // Show token breakdown per source
            for (const [name, info] of Object.entries(sourceResults)) {
              const si = info as any;
              const toks = si.tokens || 0;
              if (toks > 0) {
                const bar = chalk.green('█'.repeat(Math.min(Math.ceil(toks / 100), 20)));
                const extra = si.fired ? ` (${si.fired} fired)` : si.count ? ` (${si.count} entries)` : '';
                log(chalk.dim(`     ${bar} ${name}: ${toks} tokens${extra}`));
              }
            }
          }
          break;
        }

        case 'llm_start': {
          // From UCB: has model, prompt_tokens_est, has_tools
          // From AgentRuntime: has turn, timestamp (minimal)
          llmFired = true;
          const llmModel = event.data.model || 'auto';
          if (event.data.model && event.data.model !== 'auto' && event.data.model !== 'unknown') {
            traceModel = event.data.model;
          }
          const promptTokens = event.data.prompt_tokens_est || 0;
          const hasTools2 = event.data.has_tools ? ' + tools' : '';
          const turnInfo = event.data.turn ? `Turn ${event.data.turn} · ` : '';
          const tokenInfo = promptTokens > 0 ? ` (${promptTokens} tokens${hasTools2})` : '';
          const spinText = `${turnInfo}LLM inference: ${llmModel}${tokenInfo}`;
          lastStage = `LLM: ${llmModel}`;
          // Always print a visible line so the user knows what's happening
          stopSpinner();
          log(chalk.dim(`  🧠 ${spinText}`));
          startSpinner(chalk.dim(spinText));
          break;
        }

        case 'llm_done':
        case 'llm_end': {
          stopSpinner();
          if (tokensStarted) break;  // complete handler prints timing metadata
          const llmMs = event.data.llm_time_ms || event.data.duration_ms || 0;
          const tokensUsed = event.data.tokens_used || event.data.tokens || 0;
          const llmModelUsed = event.data.model_used || event.data.model || 'default';
          const hasThinking = event.data.has_thinking ? ' + reasoning' : '';
          const hasToolCalls = event.data.has_tool_calls ? ' + tool_calls' : '';
          log(chalk.dim(`  ⚡ LLM: ${llmModelUsed} → ${tokensUsed} tokens (${Math.round(llmMs)}ms)${hasThinking}${hasToolCalls}`));
          break;
        }

        case 'middleware_progress': {
          const mwName = event.data.middleware || event.data.stage || 'middleware';
          const mwDetail = event.data.detail || '';
          const mwElapsed = event.data.elapsed_ms ? ` ${Math.round(event.data.elapsed_ms)}ms` : '';
          lastStage = mwName;

          const mwLabel = `${mwName}${mwDetail ? ` (${mwDetail})` : ''}`;

          // FULL TRACE (default): print a permanent line for every pipeline
          // stage — even after the LLM fires — so the user sees exactly what
          // the system is doing and where the time goes, every turn.
          if (TRACE_FULL) {
            log('  ' + T.dim(T.G.step + ' ' + mwLabel + mwElapsed));
            if (steeringBar?.active) steeringBar.setStatus(`${mwName}...`);
            break;
          }

          // QUIET mode: after LLM fires, suppress visible lines — bar status only.
          if (tokensStarted || llmFired) {
            if (steeringBar?.active) steeringBar.setStatus(`${mwName}...`);
            break;
          }

          // QUIET mode pre-generation: ONE transient status line instead of a
          // permanent line per middleware (avoids "→ planexecutor: running" spam).
          if (steeringBar?.active) {
            steeringBar.setStatus(`${mwLabel}...`);
          } else {
            startSpinner(chalk.dim(`${mwLabel}...`));
          }
          break;
        }

        case 'mcts_plan': {
          stopSpinner();
          const mSteps = event.data.steps || [];
          const mMethodRaw = event.data.method || 'MCTS';
          const mMethodLabels: Record<string, string> = {
            'direct': 'direct',
            'mcts_heuristic': 'mcts_heuristic',
            'mcts': 'mcts',
          };
          const mMethod = mMethodLabels[mMethodRaw] || mMethodRaw;
          log(chalk.cyan(`  🌲 ${mMethod} plan: ${mSteps.length} steps`));
          for (const [i, step] of mSteps.entries()) {
            const desc = typeof step === 'string' ? step : (step.task || step.description || step.type || '?');
            const tool = (typeof step === 'object' && step.tool) ? chalk.yellow(` [${step.tool}]`) : '';
            log(chalk.dim(`     ${i + 1}. ${desc}`) + tool);
          }
          break;
        }

        // ── Context Facets — multi-phase agentic execution ──
        case 'facet_start': {
          stopSpinner();
          const chType = (event.data.facet_type || 'unknown').toUpperCase();
          const chIdx = event.data.facet_index ?? '?';
          const chTurns = event.data.max_turns || '?';
          const chTools = Array.isArray(event.data.tools) ? event.data.tools.length + ' tools' : 'all tools';
          log(chalk.cyan(`\n  ── Facet ${chIdx}: ${chType} (${chTurns} turns, ${chTools}) ──`));
          startSpinner(chalk.dim(`${chType} phase...`));
          break;
        }

        case 'facet_end': {
          stopSpinner();
          const endType = (event.data.facet_type || '').toUpperCase();
          const endTurns = event.data.turns_completed || 0;
          const endTokens = event.data.tokens_used || 0;
          const endRemaining = event.data.tokens_remaining || 0;
          const crystalPreview = event.data.crystal_summary || '';
          log(chalk.green(`  ✓ ${endType} complete: ${endTurns} turns, ${endTokens} tokens${endRemaining > 0 ? ` (+${endRemaining} unspent)` : ''}`));
          if (crystalPreview) {
            log(chalk.dim('    Crystal:'));
            printIndentedBlock(crystalPreview, '      ');
          }
          break;
        }

        case 'facet_crystallize': {
          const crIdx = event.data.facet_index ?? '?';
          const findings = event.data.key_findings || [];
          if (findings.length > 0) {
            log(chalk.yellow(`  💎 Crystallized ${findings.length} findings from facet ${crIdx}:`));
            for (const f of findings) {
              printIndentedBlock(`• ${f}`);
            }
          }
          break;
        }

        case 'budget_cascade': {
          const fromCh = event.data.from_facet || event.data.from_chapter || '?';
          const toCh = event.data.to_facet || event.data.to_chapter || 'pool (reusable for later facets)';
          const transferred = event.data.tokens_transferred || 0;
          if (transferred > 0) {
            log(chalk.dim(`  ↪ Budget cascade: ${transferred} turns from ${fromCh} → ${toCh}`));
          }
          break;
        }

        case 'artifact_delivered': {
          stopSpinner();
          const artFile = event.data.filename || event.data.path || 'file';
          const artSize = event.data.size || 0;
          const artCmd = event.data.retrieve_cmd || '';
          const artLang = event.data.language || '';
          const artPath = event.data.path || '';
          const artDownloadUrl = event.data.download_url || '';

          // Track artifact in session store
          _sessionArtifacts.push({
            filename: artFile,
            path: artPath,
            size: artSize,
            language: artLang,
            retrieve_cmd: artCmd,
            download_url: artDownloadUrl,
            timestamp: new Date().toISOString(),
          });

          const artIdx = _sessionArtifacts.length;
          const artSizeStr = artSize > 1024
            ? `${(artSize / 1024).toFixed(0)} KB`
            : `${artSize} bytes`;
          log(chalk.green.bold(`\n  📦 Artifact #${artIdx}: ${artFile} (${artSizeStr})`));
          log(chalk.cyan(`     /get ${artIdx}`) + chalk.dim(` to save to current directory`));
          break;
        }

        // Pipeline stages that update spinner
        case 'pipeline':
        case 'session_learn':
        case 'search_fire':
        case 'judge':
        case 'delegation_decide':
        case 'fast_path':
        case 'security_gate':
        case 'memory_recall':
        case 'guardrail_check': {
          if (spinner) {
            const msg = event.data.message || event.data.stage || event.data.phase
              || event.data.status || event.type;
            spinner.text = chalk.dim(msg);
          }
          break;
        }

        // ── Missing event handlers — full observability ──

        case 'turn_end': {
          const teTurn = event.data.turn || '?';
          const teDuration = event.data.duration_ms ? `${Math.round(event.data.duration_ms)}ms` : '';
          const teOutcome = event.data.outcome || '';
          log(chalk.dim(`  ── Turn ${teTurn} end${teOutcome ? `: ${teOutcome}` : ''}${teDuration ? ` (${teDuration})` : ''}`));
          break;
        }

        case 'tool_denied': {
          const denied = event.data.denied || [];
          if (denied.length > 0) {
            log(chalk.red(`  ⛔ Tools denied: ${denied.join(', ')}`));
          }
          break;
        }

        case 'tool_selected': {
          const selToolsArr = event.data.tools || [];
          const selTool = selToolsArr.length > 0
            ? `[${selToolsArr.slice(0, 4).join(', ')}${selToolsArr.length > 4 ? `, +${selToolsArr.length - 4}` : ''}]`
            : (event.data.tool || event.data.name || '?');
          const selTotal = event.data.total_available || 0;
          const selReason = selTotal > 0 ? `${selToolsArr.length}/${selTotal} tools` : (event.data.reason || '');
          log(chalk.dim(`  🔧 Tool selected: ${selTool}${selReason ? ` — ${selReason}` : ''}`));
          break;
        }

        case 'llm_error': {
          stopSpinner();
          const llmErr = event.data.error || event.data.message || 'unknown';
          const llmErrModel = event.data.model || '?';
          log(chalk.red(`  ✗ LLM error (${llmErrModel}): ${String(llmErr)}`));
          traceErrors.push(`LLM error (${llmErrModel}): ${String(llmErr)}`);
          break;
        }

        case 'reasoning_depth': {
          const rdDepth = event.data.depth || event.data.level || '?';
          const rdReason = event.data.reason || '';
          log(chalk.dim(`  🧠 Reasoning depth: ${rdDepth}${rdReason ? ` — ${rdReason}` : ''}`));
          break;
        }

        case 'agentic_promotion': {
          stopSpinner();
          const apReason = event.data.reason || 'auto';
          const apEffort = event.data.effort || '?';
          log(chalk.cyan(`  🔀 Agentic promotion: effort=${apEffort} — ${apReason}`));
          break;
        }

        case 'steering': {
          const stHook = event.data.hook || event.data.type || '?';
          const stReason = event.data.reason || '';
          log(chalk.yellow(`  🔄 Steering: ${stHook}${stReason ? ` — ${stReason}` : ''}`));
          break;
        }

        case 'strategy_subsystem': {
          const ssName = event.data.subsystem || event.data.name || '?';
          const ssStatus = event.data.status || event.data.decision || '';
          log('  ' + T.dim(T.G.step + ` strategy ${ssName} → ${ssStatus}`));
          break;
        }

        case 'plan_approved': {
          log(chalk.green(`  ✓ Plan approved${event.data.plan_id ? ` (${event.data.plan_id})` : ''}`));
          break;
        }

        case 'verification': {
          const vResults = event.data.results || [];
          if (Array.isArray(vResults) && vResults.length > 0) {
            for (const v of vResults) {
              const icon = v.success ? chalk.green('✓') : chalk.red('✗');
              const path = v.path || '';
              const kind = v.kind || '';
              const reason = v.reason || '';
              const kindLabel = kind ? ` (${kind.replace(/_/g, ' ')})` : '';
              log(chalk.dim(`  🔍 ${icon} ${path}${kindLabel}${reason ? ` — ${reason}` : ''}`));
            }
          } else {
            const vResult = event.data.passed ? chalk.green('✓ passed') : chalk.red('✗ failed');
            const vDetail = event.data.detail || event.data.reason || '';
            log(chalk.dim(`  🔍 Verification: ${vResult}${vDetail ? ` — ${vDetail}` : ''}`));
          }
          break;
        }

        case 'image_gen_start': {
          stopSpinner();
          const igPrompt = event.data.prompt || event.data.description || '';
          log(chalk.cyan(`  🎨 Generating image: ${igPrompt}`));
          startSpinner(chalk.dim('Generating image...'));
          break;
        }

        case 'image_gen_complete': {
          stopSpinner();
          const igUrl = event.data.url || '';
          log(chalk.green(`  ✓ Image generated${igUrl ? `: ${igUrl}` : ''}`));
          break;
        }

        case 'image_gen_failed': {
          stopSpinner();
          const igErr = event.data.error || 'unknown';
          log(chalk.red(`  ✗ Image generation failed: ${igErr}`));
          break;
        }

        case 'session_context': {
          const scTopic = event.data.topic || event.data.summary || '';
          if (scTopic) {
            log(chalk.dim(`  📝 Session context: ${scTopic}`));
          }
          break;
        }

        case 'reasoning_backend_health': {
          const backends = event.data.backends || {};
          const entries = Object.entries(backends);
          // Friendly display names for backend IDs
          const friendlyNames: Record<string, string> = {
            'vllm': 'orchestrator vLLM',
            'vllm_swap': 'local swap (on-demand)',
            'vllm_orchestrator': 'orchestrator (fallback)',
            'vllm_reasoning': 'local reasoning (on-demand)',
            'vllm_coding': 'coding vLLM',
            'vllm_qwen': 'Qwen vLLM',
            'vllm_cloud_reasoning': 'cloud reasoning',
            'vllm_gemma4_reasoning': 'Gemma4 (cloud)',
            'vllm_gemma4_flagship': 'Gemma4 flagship (cloud)',
            'vllm_dgx': 'DGX Spark',
            'vllm_dgx_swap': 'DGX Spark (swap)',
            'vllm_dgx_embed': 'DGX Spark (embeddings)',
            'vllm_dgx_orch': 'DGX Spark (orchestrator)',
            'deepseek_api': 'DeepSeek API',
            'comfyui': 'ComfyUI',
          };
          // On-demand backends are expected to be offline — hide when down, show when up
          const onDemandBackends = new Set([
            'vllm_swap', 'vllm_reasoning', 'vllm_dgx_swap',
            'vllm_gemma4_reasoning', 'vllm_gemma4_flagship', 'vllm_cloud_reasoning',
          ]);
          if (entries.length > 0) {
            const online = entries.filter(([, alive]) => alive);
            // Only show offline backends that aren't on-demand (expected off)
            const offline = entries.filter(([name, alive]) => !alive && !onDemandBackends.has(name));
            for (const [name, alive] of [...online, ...offline]) {
              const label = friendlyNames[name] || name.replace(/^vllm_/, '').replace(/_/g, ' ');
              const status = alive ? chalk.green('online') : chalk.red('offline');
              log(chalk.dim(`  🔧 ${label}: ${status}`));
            }
          }
          break;
        }

        case 'autonomous_start':
        case 'autonomous_task': {
          stopSpinner();
          const atTask = event.data.task || event.data.description || '';
          log(chalk.cyan(`  🤖 Autonomous task: ${atTask}`));
          break;
        }

        case 'expedition_created': {
          const expId = event.data.expedition_id || event.data.id || '?';
          log(chalk.cyan(`  🗺 Expedition created: ${expId}`));
          break;
        }

        case 'checkpoint_resumed': {
          const crTurn = event.data.turn || '?';
          log(chalk.dim(`  ↩ Checkpoint resumed at turn ${crTurn}`));
          break;
        }

        case 'council_review': {
          const crVerdict = event.data.verdict || event.data.decision || '';
          const crReason = event.data.reason || '';
          log(chalk.magenta(`  👥 Council review: ${crVerdict}${crReason ? ` — ${crReason}` : ''}`));
          break;
        }

        case 'cuga_available': {
          break;  // Internal signal, no display needed
        }

        case 'context_stage': {
          const csStage = event.data.substage || event.data.stage || 'context';
          const csStatus = event.data.status || event.data.detail || '';
          const csLabel = csStatus ? `${csStage}: ${csStatus}` : csStage;
          lastStage = csLabel;
          stopSpinner();
          log(chalk.dim(`  [context_stage] ${csLabel}`));
          startSpinner(chalk.dim(csLabel));
          break;
        }

        case 'pipeline': {
          const plStage = event.data.stage || event.data.phase || '';
          const plStrategy = event.data.strategy || '';
          const plEffort = event.data.effort;
          // Show effort/strategy info inline
          if (plEffort && typeof plEffort === 'object') {
            const efLvl = plEffort.level || '?';
            const efLabel = plEffort.label || plEffort.tier || '';
            stopSpinner();
            log(chalk.dim(`  [pipeline] effort=${efLvl}${efLabel ? ` (${efLabel})` : ''}${plStrategy ? ` strategy=${plStrategy}` : ''}`));
          } else if (plStage) {
            lastStage = plStage;
            if (spinner) {
              spinner.text = chalk.dim(plStage);
            }
          }
          break;
        }

        case 'mcts_iteration': {
          // Live MCTS planning progress — shows the planner is actually
          // working instead of a silent "planexecutor" blackout.
          const mi = event.data.iteration ?? '?';
          const mt = event.data.total ?? '?';
          const mbv = typeof event.data.best_value === 'number' ? event.data.best_value.toFixed(3) : '?';
          const mms = event.data.elapsed_ms ? ` ${Math.round(event.data.elapsed_ms)}ms` : '';
          lastStage = `mcts ${mi}/${mt}`;
          if (TRACE_FULL) {
            log(chalk.dim(`  🌲 MCTS: iter ${mi}/${mt} · best=${mbv} · depth=${event.data.depth ?? '?'}${mms}`));
          } else if (steeringBar?.active) {
            steeringBar.setStatus(`mcts ${mi}/${mt}...`);
          }
          break;
        }

        case 'plan_phase': {
          const ppPhase = event.data.name || event.data.phase || 'phase';
          const ppMs = event.data.elapsed_ms ? ` ${Math.round(event.data.elapsed_ms)}ms` : '';
          const ppCand = event.data.candidates != null ? ` · ${event.data.candidates} candidate(s)` : '';
          const ppIter = event.data.iterations ? ` · ${event.data.iterations} iters` : '';
          lastStage = `plan: ${ppPhase}`;
          if (TRACE_FULL) {
            log(chalk.dim(`  📐 Plan phase: ${ppPhase}${ppMs}${ppCand}${ppIter}`));
          } else if (steeringBar?.active) {
            steeringBar.setStatus(`plan: ${ppPhase}...`);
          }
          break;
        }

        case 'plan_start': {
          const psTier = event.data.tier || '';
          const psTimeout = event.data.timeout_ms ? ` (budget ${Math.round(event.data.timeout_ms)}ms)` : '';
          lastStage = 'planning';
          if (TRACE_FULL) {
            log(chalk.dim(`  📐 Planning started${psTier ? `: ${psTier}` : ''}${psTimeout}`));
          } else if (steeringBar?.active) {
            steeringBar.setStatus('planning...');
          }
          break;
        }

        case 'plan_complete':
        case 'plan_status': {
          const pcStatus = event.data.status || event.data.outcome || 'done';
          lastStage = `plan: ${pcStatus}`;
          // "timeout"/"no_plan" are normal — planning is optional enrichment,
          // the turn proceeds without a plan. Don't alarm the user.
          const pcBenign = pcStatus === 'timeout' || pcStatus === 'no_plan' || pcStatus === 'no_result';
          const pcIcon = pcBenign ? '○' : '✓';
          log(chalk.dim(`  ${pcIcon} Planning ${pcBenign ? `skipped (${pcStatus}) — proceeding without a plan` : pcStatus}`));
          break;
        }

        case 'turn_progress': {
          const tpTurn = event.data.turn || '?';
          const tpMax = event.data.max_turns || '?';
          if (event.data.max_turns) lastKnownMaxTurns = event.data.max_turns;
          lastStage = `turn ${tpTurn}/${tpMax}`;
          if (spinner) {
            spinner.text = chalk.dim(`Turn ${tpTurn}/${tpMax}...`);
          }
          break;
        }

        // ── Pipeline transparency events ──
        case 'middleware_chain_complete': {
          const mwCount = event.data.count || 0;
          const mwMs = Math.round(event.data.total_ms || 0);
          log(chalk.dim(`  🔗 Pipeline: ${mwCount} stages, ${mwMs}ms`));
          break;
        }
        case 'context_flame_graph': {
          const neurons = event.data.neurons_fired || 0;
          const ctxTokens = event.data.total_tokens || 0;
          const quality = (event.data.quality_score || 0).toFixed(2);
          log(chalk.dim(`  🧠 Context: ${neurons} neurons, ${ctxTokens} tokens, quality=${quality}`));
          break;
        }
        case 'prefire_result': {
          if (event.data.tool) {
            log(chalk.dim(`  ⚡ Pre-fired: ${event.data.tool} (${event.data.chars || 0} chars)`));
          } else if (event.data.tools) {
            log(chalk.dim(`  ⚡ Pre-firing: ${event.data.tools.join(', ')}`));
          }
          break;
        }
        case 'context_eviction': {
          const evCount = event.data.evicted || 0;
          const evTokens = event.data.tokens_freed || 0;
          log(chalk.dim(`  🗑 Evicted: ${evCount} chunks, ${evTokens} tokens freed`));
          break;
        }
        case 'neuron_fire': {
          const nChunks = event.data.chunks_count || 0;
          const nTokens = event.data.total_tokens || 0;
          log(chalk.dim(`  🧬 Neurons: ${nChunks} chunks, ${nTokens} tokens`));
          break;
        }
        case 'notebook_export': {
          log(chalk.dim(`  📓 Notebook: ${event.data.notebook_id || ''}`));
          break;
        }
        case 'speculative_prefetch':
        case 'outcome_recorded':
          break; // silent — internal bookkeeping

        default: {
          // Show content from unexpected events as fallback
          if (event.data.content && !hasOutput) {
            stopSpinner();
            process.stdout.write(event.data.content);
            content += event.data.content;
            hasOutput = true;
          }
          // Show meaningful unknown events so nothing is silently swallowed.
          // Pipeline substages are discriminated by `stage` (the wire type is
          // often 'pipeline'); label by stage and prefer a human field, else —
          // under full trace — show a compact scalar dump so telemetry like
          // llm_route / thinking_budget / reasoning_summary is never invisible.
          const d = event.data || {};
          const label = d.stage || event.type;
          let msg = d.message || d.reason || d.status || d.summary || d.detail || '';
          if (!msg && TRACE_FULL && (d.stage || event.type === 'pipeline')) {
            msg = Object.entries(d)
              .filter(([k, v]) => k !== 'type' && k !== 'stage' &&
                (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
              .slice(0, 4)
              .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
              .join(' ');
          }
          if (msg && event.type !== 'debug') {
            // Trace lines are a SIDE-NOTE, not content: a hairline step glyph +
            // a HUMANIZED label. Previously this dumped the raw internal event
            // type at content weight ("[enrichment_detached] answer final …"),
            // which is the single ugliest thing in the stream — internal
            // vocabulary in the user's face (found live 2026-07-24).
            const human = humanizeTraceLabel(String(label));
            const body = String(msg).slice(0, 120);
            // Skip the label when the message already says it ("grounding ·
            // grounding continues in background" read as a stutter).
            const showLabel = !body.toLowerCase().includes(human.toLowerCase());
            log('  ' + T.dim(T.G.step + ' ' + (showLabel ? human + ' · ' : '') + body));
          }
          break;
        }
      }
    },

    getContent() {
      return content;
    },

    finish() {
      stopSpinner();
      if (!hasOutput) {
        // "(no response)" alone is THREE different facts wearing one label: the
        // model really did return nothing, the stream ended before any content
        // arrived, or events arrived that this renderer has no branch for.
        // Measured 2026-08-21: an omnibox turn sat 11.7s and printed exactly
        // this, and there was no way to tell which -- so the next step was a
        // guess, and the turn after it went back to working, which is how a
        // real defect gets filed as "a transient".
        //
        // traceEvents already holds every event; the information was there and
        // simply was not being said. Blanks are unknowns, not zeros.
        const kinds = traceEvents.map((e) => e.type);
        if (kinds.length === 0) {
          console.log(chalk.dim(
            '  (no response - the stream carried no events at all; the request '
            + 'reached a server and it sent nothing)'));
        } else {
          const uniq = Array.from(new Set(kinds));
          console.log(chalk.dim(
            '  (no response - ' + kinds.length + ' event(s) arrived, none carried '
            + 'content: ' + uniq.join(', ') + ')'));
        }
      }

      // ── Status bar — compact summary after each response ──
      const elapsed = Date.now() - startTime;
      // Themed footer: the agent carries her violet glyph, the rest is quiet
      // metadata joined with the house separator — replaces the flat
      // `[agent: x | model: y | 6.0s]` bracket dump.
      const parts: string[] = [];
      if (traceAgent) parts.push(T.violet(T.G.agent) + ' ' + T.muted(traceAgent));
      if (traceModel) parts.push(T.dim(traceModel));
      if (traceTurns > 0) parts.push(T.dim(`${traceTurns}/${lastKnownMaxTurns} turns`));
      if (traceToolCalls.length > 0) parts.push(T.dim(`${traceToolCalls.length} tools`));
      parts.push(T.dim(`${(elapsed / 1000).toFixed(1)}s`));
      console.log('  ' + T.metaJoin(parts));

      // ── Persist session trace to disk ──
      if (sessionId) {
        try {
          const sessDir = join(homedir(), '.aither', 'sessions', sessionId);
          if (!existsSync(sessDir)) mkdirSync(sessDir, { recursive: true });
          const profile = this.getSessionProfile();
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const filePath = join(sessDir, `${ts}.json`);
          writeFileSync(filePath, JSON.stringify(profile, null, 2));
        } catch (_e) {
          // best-effort — don't crash on trace write failure
        }
      }
    },

    getTrace(): SSEEvent[] {
      return traceEvents;
    },

    getSessionProfile(): SessionProfile {
      return {
        session_id: sessionId || 'anonymous',
        prompt: prompt || '',
        started_at: startedAt,
        duration_ms: Date.now() - startTime,
        event_count: traceEvents.length,
        tool_calls: traceToolCalls,
        thinking_traces: traceThinking,
        context_sources: traceContextSources,
        model: traceModel,
        agent: traceAgent,
        errors: traceErrors,
        events: traceEvents,
      };
    },
  };
}

/* ── Terminal Block Renderer ────────────────────────────────── */

function renderTerminalBlocks(blocks: any[]): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'header':
        console.log(chalk.bold.cyan(`\n  ${block.text}`) + (block.subtitle ? chalk.dim(` — ${block.subtitle}`) : ''));
        break;

      case 'kv': {
        const pairs = block.pairs || {};
        for (const [k, v] of Object.entries(pairs)) {
          console.log(chalk.dim(`    ${k}: `) + chalk.white(String(v)));
        }
        break;
      }

      case 'table': {
        const cols: string[] = (block.columns || []).map((c: any) => typeof c === 'string' ? c : c.label);
        const rows: string[][] = (block.rows || []).map((r: any[]) => r.map(String));
        if (cols.length > 0) {
          console.log('  ' + formatTable(cols, rows).split('\n').join('\n  '));
        }
        break;
      }

      case 'callout': {
        const icons: Record<string, string> = { info: 'ℹ', success: '✓', warning: '⚠', error: '✗', tip: '💡' };
        const colors: Record<string, typeof chalk> = {
          info: chalk.blue, success: chalk.green, warning: chalk.yellow,
          error: chalk.red, tip: chalk.magenta,
        };
        const color = colors[block.variant || 'info'] || chalk.blue;
        const icon = icons[block.variant || 'info'] || 'ℹ';
        console.log(color(`  ${icon} ${block.title || ''} ${block.text}`));
        break;
      }

      case 'progress': {
        if (block.steps) {
          const icons: Record<string, string> = { done: '✓', active: '⟳', pending: '○', error: '✗' };
          for (const step of block.steps) {
            const icon = icons[step.status] || '○';
            const color = step.status === 'done' ? chalk.green : step.status === 'active' ? chalk.blue : step.status === 'error' ? chalk.red : chalk.dim;
            console.log(color(`    ${icon} ${step.name}`) + (step.detail ? chalk.dim(` (${step.detail})`) : ''));
          }
        } else if (block.value != null) {
          const pct = Math.round(block.value * 100);
          const filled = Math.round(pct / 5);
          const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
          console.log(chalk.blue(`  [${bar}] ${pct}%`) + (block.label ? chalk.dim(` ${block.label}`) : ''));
        }
        break;
      }

      case 'scores': {
        for (const [name, val] of Object.entries(block.scores || {})) {
          const v = val as number;
          const pct = Math.round(v * 100);
          const color = pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.red;
          console.log(`    ${chalk.dim(name.padEnd(20))} ${color(`${pct}%`)}`);
        }
        break;
      }

      case 'code': {
        const label = block.filename || block.language || 'code';
        console.log(chalk.dim(`\n  ─── ${label} ───`));
        const codeLines = (block.content || '').split('\n');
        for (const codeLine of codeLines) {
          console.log(chalk.white(`  ${codeLine}`));
        }
        console.log(chalk.dim(`  ─── end ───`));
        if (block.filename && block.filename !== 'code' && !block.filename.startsWith('code.')) {
          console.log(chalk.dim(`  Saved to: ${block.filename}`));
        }
        break;
      }

      case 'list': {
        const items: any[] = block.items || [];
        for (const item of items) {
          const text = typeof item === 'string' ? item : item.text;
          console.log(chalk.dim('  • ') + text);
        }
        break;
      }

      case 'approve':
        console.log(chalk.yellow.bold(`\n  ⚠ ${block.title}`));
        if (block.detail) console.log(chalk.dim(`    ${block.detail}`));
        console.log(chalk.dim(`    [${block.approve_label || 'Approve'}] / [${block.reject_label || 'Reject'}]`));
        console.log(chalk.dim(`    (interactive approval — use web UI to respond)`));
        break;

      case 'form':
        if (block.title) console.log(chalk.cyan.bold(`\n  📋 ${block.title}`));
        if (block.description) console.log(chalk.dim(`    ${block.description}`));
        for (const f of block.fields || []) {
          const def = f.default != null ? chalk.dim(` [${f.default}]`) : '';
          console.log(chalk.dim(`    ${f.label}:`) + def);
        }
        console.log(chalk.dim(`    (interactive form — use web UI to submit)`));
        break;

      case 'select':
        if (block.label) console.log(chalk.cyan(`  ${block.label}`));
        for (const opt of block.options || []) {
          const label = typeof opt === 'string' ? opt : opt.label;
          const desc = typeof opt === 'object' && opt.description ? chalk.dim(` — ${opt.description}`) : '';
          console.log(chalk.dim('    ○ ') + label + desc);
        }
        console.log(chalk.dim(`    (interactive selection — use web UI to choose)`));
        break;

      case 'markdown':
        if (block.text) console.log('  ' + renderMarkdown(block.text).trim().split('\n').join('\n  '));
        break;

      case 'panel': {
        // Portal-kit panel: show title, fallback text, and a deep link.
        // Terminal cannot render React panels, so degrade gracefully.
        const panelId = block.panel_id || 'panel';
        const panelTitle = block.title || panelId;
        const fallbackText = block.fallback;

        // Portal deep link — portalBase(), NOT backendBase() (that is the API).
        const portalUrl = `${portalBase()}/?panel=${encodeURIComponent(panelId)}`;
        const link = osc8Link(portalUrl, 'View in Portal');

        // Header line with title
        console.log(chalk.bold.cyan(`\n  ${panelTitle}`));

        // Show fallback text if provided
        if (fallbackText && fallbackText.trim()) {
          console.log(chalk.dim(`    ${fallbackText}`));
        }

        // Deep link to portal
        console.log(chalk.dim('    ') + link);
        break;
      }

      default:
        // Unknown block — show type + any text content
        if (block.text || block.content) {
          console.log(chalk.dim(`  [${block.type}] `) + (block.text || block.content));
        }
        break;
    }
  }
}

/* ── Table Formatter ────────────────────────────────────────── */

export function formatTable(headers: string[], rows: string[][]): string {
  // Strip ANSI for width calculation
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const widths = headers.map((h, i) =>
    Math.max(strip(h).length, ...rows.map(r => strip(r[i] || '').length))
  );

  const pad = (s: string, w: number) => s + ''.padEnd(Math.max(0, w - strip(s).length));
  const header = headers.map((h, i) => pad(h, widths[i])).join('  ');
  const sep = widths.map(w => '\u2500'.repeat(w)).join('\u2500\u2500');
  const body = rows.map(row =>
    row.map((cell, i) => pad(cell || '', widths[i])).join('  ')
  ).join('\n');

  return `${chalk.bold(header)}\n${chalk.dim(sep)}\n${body}`;
}


/* ── Steering Bar — fixed bottom bar via ANSI scroll regions ──── */

/**
 * Keeps a fixed input bar at the bottom of the terminal while
 * stream output scrolls above.  Uses DECSTBM (Set Scrolling Region)
 * to physically separate the output area from the bar — no stdout
 * monkey-patching, no erase/redraw races.
 *
 * Layout:
 *   Rows 1 to (rows-3):  SCROLL REGION — all output, tokens, spinners
 *   Row (rows-2):         Status spinner (e.g., "generation...")
 *   Row (rows-1):         Separator line ────────
 *   Row (rows):           [steer] > input
 *
 * Output cannot collide with the bar because they occupy different
 * terminal regions.
 */
export class SteeringBar {
  private _active = false;
  private _inputText = '';
  private _statusText = '';
  private _spinFrame = 0;
  private _spinTimer: ReturnType<typeof setInterval> | null = null;
  private _tokenMode = false;
  private _resizeHandler: (() => void) | null = null;
  private _resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastRows = 0;  // Last geometry we drew the bar at (for resize cleanup)
  private static readonly _SPIN_CHARS = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

  get active() { return this._active; }
  get inputText() { return this._inputText; }

  activate(): void {
    if (this._active) return;
    this._active = true;
    this._inputText = '';
    this._statusText = '';

    if (!process.stdout.isTTY) return;

    // Set up scroll region and draw initial bar
    this._setupRegion();

    // Handle terminal resize. Dragging a terminal edge fires many 'resize'
    // events in a burst; redrawing the scroll-region bar on each one (against
    // partially-reflowed geometry) is what left a stale duplicate green
    // "aither >" prompt behind. Debounce, then do a CLEAN repaint that resets
    // the scroll region and erases the OLD bar lines before redrawing.
    this._resizeHandler = () => this._handleResize();
    process.stdout.on('resize', this._resizeHandler);
  }

  /** Debounced, artifact-free resize repaint. */
  private _handleResize(): void {
    if (!this._active || !process.stdout.isTTY) return;
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      this._resizeTimer = null;
      if (!this._active || !process.stdout.isTTY) return;

      // Clear the bar lines at their PREVIOUS positions (the source of the
      // stale duplicate prompt) with the scroll region reset to full screen
      // so we can address any row, then re-establish the region + redraw.
      const oldRows = this._lastRows || (process.stdout.rows || 24);
      let buf = '\x1b7\x1b[r';  // save cursor, reset scroll region to full
      for (let r = Math.max(1, oldRows - 2); r <= oldRows; r++) {
        buf += `\x1b[${r};1H\x1b[2K`;  // clear each old bar line
      }
      buf += '\x1b8';  // restore cursor
      process.stdout.write(buf);

      this._setupRegion();  // recompute region for new geometry + redraw
    }, 60);
  }

  deactivate(): void {
    if (!this._active) return;
    this._active = false;
    this._statusText = '';

    if (this._spinTimer) {
      clearInterval(this._spinTimer);
      this._spinTimer = null;
    }

    if (this._resizeTimer) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }

    if (this._resizeHandler) {
      process.stdout.removeListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }

    if (process.stdout.isTTY) {
      const rows = process.stdout.rows || 24;
      // Save cursor (in scroll region), clear the bottom 3 bar lines
      let buf = '\x1b7';
      for (let r = rows - 2; r <= rows; r++) {
        buf += `\x1b[${r};1H\x1b[2K`;
      }
      // Reset scroll region to full screen, restore cursor, move to new line
      buf += '\x1b[r\x1b8\n';
      process.stdout.write(buf);
    }

  }

  /** Set scroll region and draw bar, preserving cursor position. */
  private _setupRegion(): void {
    const rows = process.stdout.rows || 24;
    const scrollEnd = Math.max(1, rows - 3);
    // Save cursor, set scroll region, restore cursor — content stays put
    process.stdout.write(`\x1b7\x1b[1;${scrollEnd}r\x1b8`);
    this._lastRows = rows;  // remember geometry for the next resize cleanup
    this._drawBar();
  }

  /** Show spinner + status text in the bar (replaces ora when bar is active). */
  setStatus(text: string): void {
    this._statusText = text;
    if (!this._spinTimer && this._active) {
      this._spinTimer = setInterval(() => {
        this._spinFrame = (this._spinFrame + 1) % SteeringBar._SPIN_CHARS.length;
        if (this._active) this._drawBar();
      }, 80);
    }
    this._drawBar();
  }

  /** Clear status text. */
  clearStatus(): void {
    this._statusText = '';
    if (this._spinTimer) {
      clearInterval(this._spinTimer);
      this._spinTimer = null;
    }
    this._drawBar();
  }

  /** Update displayed input text (called from readline _ttyWrite hook). */
  setInput(text: string): void {
    this._inputText = text;
    this._drawBar();
  }

  /** Clear input after steer send. */
  clearInput(): void {
    this._inputText = '';
    this._drawBar();
  }

  enterTokenMode(): void {
    this._tokenMode = true;
    if (this._spinTimer) { clearInterval(this._spinTimer); this._spinTimer = null; }
  }

  exitTokenMode(): void {
    this._tokenMode = false;
  }

  /**
   * Draw the fixed bottom bar — single atomic write.
   * Uses absolute positioning outside the scroll region, then restores
   * cursor back into the scroll region.
   */
  private _drawBar(): void {
    if (!this._active || !process.stdout.isTTY) return;

    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;
    const barWidth = Math.min(cols, 60);

    // Status line content
    let statusContent = '';
    if (this._statusText) {
      const frame = SteeringBar._SPIN_CHARS[this._spinFrame];
      statusContent = `${chalk.cyan(frame)} ${chalk.dim(this._statusText)}`;
    }

    // Input line content
    const prefix = chalk.dim(' aither') + chalk.yellow(' > ');
    const prefixLen = 10;
    const maxInput = cols - prefixLen - 1;
    const display = this._inputText.length > maxInput
      ? this._inputText.slice(-maxInput)
      : this._inputText;

    const sep = chalk.dim('─'.repeat(barWidth));

    // Build entire bar as one atomic buffer:
    // Save cursor (in scroll region)
    let buf = '\x1b7';
    // Row rows-2: status line
    buf += `\x1b[${rows - 2};1H\x1b[2K${statusContent}`;
    // Row rows-1: separator
    buf += `\x1b[${rows - 1};1H\x1b[2K${sep}`;
    // Row rows: input prompt
    buf += `\x1b[${rows};1H\x1b[2K${prefix}${display}`;
    // Restore cursor (back to scroll region)
    buf += '\x1b8';

    process.stdout.write(buf);
  }
}
