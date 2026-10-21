/**
 * Context views — see and search agent memory, and pick files to hand the agent,
 * without leaving the terminal (owner 2026-10-21: "stop having to use windows file
 * explorer to drag and drop context to my agents").
 *
 *   /mem <query>     awm recall, rendered in the viewer
 *   /files [N]       newest N files in ~/Downloads (or AITHER_FILES_DIR), numbered
 *   /attach 1 3      queue those entries; the next message carries their paths
 *   /attach clear    drop the queue
 *   /graph <q>       awgraph query (code/knowledge graph)
 *   /strata <q>      the mesh file index (/api/v1/storage/files/search): files on every machine
 *   /nexus <q>       platform memory via Genesis /external/memory/recall (Spirit, Nexus, graph)
 *   /share <path>    awshare publish (a lone file is staged into a folder first)
 *   /seal <folder>   awseal sign
 *   /git             awgit status
 *
 * Pure render + parse functions following the storage-view.ts seam: the caller does
 * the I/O (readdir, the awm subprocess) and hands the result in, so this stays
 * testable with no filesystem and no awm installed.
 */

import { COLORS } from './theme.js';

export type ContextCommand =
  | { kind: 'mem'; query: string }
  | { kind: 'files'; count: number }
  | { kind: 'attach'; indexes: number[] }
  | { kind: 'attach-clear' }
  | { kind: 'attach-list' }
  | { kind: 'graph'; query: string }
  | { kind: 'strata'; query: string }
  | { kind: 'nexus'; query: string }
  | { kind: 'share'; path: string }
  | { kind: 'seal'; path: string }
  | { kind: 'git' }
  | { kind: 'usage'; message: string };

/** Every slash-command name the context views own (runCommand dispatches on this). */
export const CONTEXT_COMMANDS: readonly string[] = [
  'mem', 'memory', 'files', 'attach', 'graph', 'strata', 'nexus', 'share', 'seal', 'git',
];

/** A path argument with optional surrounding quotes removed (Windows paths carry spaces). */
function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) ? t.slice(1, -1) : t;
}

export const FILES_DEFAULT = 15;
export const FILES_MAX = 200;

/** Parse the argument string of /mem, /files or /attach. */
export function parseContextCommand(name: string, args: string): ContextCommand | null {
  const a = args.trim();
  if (name === 'mem' || name === 'memory') {
    return a ? { kind: 'mem', query: a } : { kind: 'usage', message: 'Usage: /mem <query>  (searches agent memory)' };
  }
  if (name === 'files') {
    if (!a) return { kind: 'files', count: FILES_DEFAULT };
    const n = Number.parseInt(a, 10);
    if (!Number.isFinite(n) || n < 1 || String(n) !== a) {
      return { kind: 'usage', message: `Usage: /files [N]  (N = 1..${FILES_MAX})` };
    }
    return { kind: 'files', count: Math.min(n, FILES_MAX) };
  }
  if (name === 'attach') {
    if (!a) return { kind: 'attach-list' };
    if (a === 'clear' || a === 'none') return { kind: 'attach-clear' };
    const parts = a.split(/[\s,]+/).filter(Boolean);
    const idx = parts.map(p => Number.parseInt(p, 10));
    if (idx.some((n, i) => !Number.isFinite(n) || n < 1 || String(n) !== parts[i])) {
      return { kind: 'usage', message: 'Usage: /attach <n> [n2 ...]  (numbers from /files) · /attach clear' };
    }
    return { kind: 'attach', indexes: [...new Set(idx)] };
  }
  if (name === 'graph') {
    return a ? { kind: 'graph', query: a } : { kind: 'usage', message: 'Usage: /graph <question>  (awgraph code/knowledge graph)' };
  }
  if (name === 'strata') {
    return a ? { kind: 'strata', query: a } : { kind: 'usage', message: 'Usage: /strata <name or path fragment>  (files across your machines)' };
  }
  if (name === 'nexus') {
    return a ? { kind: 'nexus', query: a } : { kind: 'usage', message: 'Usage: /nexus <query>  (platform memory: Spirit, Nexus, graph)' };
  }
  if (name === 'share') {
    const p = unquote(a);
    return p ? { kind: 'share', path: p } : { kind: 'usage', message: 'Usage: /share <file or folder>  (awshare: verifiable bundle)' };
  }
  if (name === 'seal') {
    const p = unquote(a);
    return p ? { kind: 'seal', path: p } : { kind: 'usage', message: 'Usage: /seal <folder>  (awseal: sign it)' };
  }
  if (name === 'git') return { kind: 'git' };
  return null;
}

/** The outcome of one brick subprocess (awgraph, awshare, awseal, awgit). */
export interface ToolRun {
  ok: boolean;
  /** argv[0], shown in the header and in the not-installed line. */
  tool: string;
  stdout?: string;
  stderr?: string;
  /** Set when the process failed. */
  error?: string;
  /** ENOENT: the brick is not on PATH. */
  notInstalled?: boolean;
}

/** Render a brick run. A missing tool is ONE plain line, never a fake result. */
export function buildToolPanel(title: string, run: ToolRun, width: number): string[] {
  const out: string[] = [COLORS.accent(fit(title, width)), ''];
  if (run.notInstalled) {
    out.push(COLORS.warn(`  ${run.tool} not installed`));
    return out;
  }
  const body = (run.stdout || '').split(/\r?\n/).filter(l => l.trim());
  if (!run.ok) {
    out.push(COLORS.error(`  ${run.tool} failed: ${run.error || 'unknown error'}`));
    const tail = (run.stderr || '').split(/\r?\n/).filter(l => l.trim()).slice(-4);
    for (const l of tail) out.push(COLORS.muted('  ' + fit(l, width - 2)));
  }
  if (!body.length && run.ok) out.push(COLORS.muted('  (no output)'));
  for (const l of body) out.push(fit(l, width));
  return out;
}

export interface StrataHit {
  node: string;
  path: string;
  bytes?: number;
  size?: number;
}

export interface StrataResult {
  ok: boolean;
  query: string;
  items?: StrataHit[];
  partial?: boolean;
  error?: string;
}

export function buildStrataPanel(res: StrataResult, width: number): string[] {
  const out: string[] = [COLORS.accent(`files across your machines · "${fit(res.query, Math.max(10, width - 34))}"`), ''];
  if (!res.ok) {
    out.push(COLORS.error(`  file index unavailable: ${res.error || 'unknown error'}`));
    return out;
  }
  const items = res.items || [];
  if (!items.length) {
    out.push(COLORS.muted('  no indexed file matches'));
    return out;
  }
  const nodeW = Math.min(16, Math.max(...items.map(i => i.node.length)));
  const pathW = Math.max(12, width - nodeW - 13);
  for (const it of items) {
    const b = it.bytes ?? it.size ?? 0;
    out.push(`  ${fit(it.node, nodeW).padEnd(nodeW)}  ${fit(it.path, pathW).padEnd(pathW)}  ${human(b).padStart(7)}`);
  }
  if (res.partial) out.push('', COLORS.warn('  partial: some machines did not answer'));
  return out;
}

export interface NexusMemory {
  content?: string;
  text?: string;
  memory?: string;
  score?: number;
  tier?: string;
  source?: string;
}

export interface NexusResult {
  ok: boolean;
  query: string;
  memories?: NexusMemory[];
  error?: string;
}

export function buildNexusPanel(res: NexusResult, width: number): string[] {
  const out: string[] = [COLORS.accent(`platform memory · "${fit(res.query, Math.max(10, width - 24))}"`), ''];
  if (!res.ok) {
    out.push(COLORS.error(`  platform memory unavailable: ${res.error || 'unknown error'}`));
    return out;
  }
  const ms = res.memories || [];
  if (!ms.length) {
    out.push(COLORS.muted('  nothing recalled for that query'));
    return out;
  }
  for (const m of ms) {
    const text = String(m.content || m.text || m.memory || '').replace(/\s+/g, ' ').trim();
    const score = typeof m.score === 'number' ? `${Math.round(m.score * 100)}% ` : '';
    const tag = m.tier || m.source;
    out.push(fit(`  ${score}${tag ? `[${tag}] ` : ''}${text}`, width));
  }
  return out;
}

export interface FileEntry {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

/** Newest first, ties broken by name so the numbering is stable. */
export function newestFirst(entries: FileEntry[], count: number): FileEntry[] {
  return [...entries]
    .sort((x, y) => (y.mtimeMs - x.mtimeMs) || x.name.localeCompare(y.name))
    .slice(0, count);
}

function human(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}

function age(mtimeMs: number, now: number): string {
  const s = Math.max(0, Math.round((now - mtimeMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function fit(s: string, w: number): string {
  return s.length <= w ? s : (w <= 1 ? s.slice(0, w) : s.slice(0, w - 1) + '…');
}

export function buildFilesPanel(
  dir: string, entries: FileEntry[], width: number, attached: readonly string[], now = Date.now(),
): string[] {
  const out: string[] = [COLORS.accent(`${dir}  ·  newest ${entries.length}`), ''];
  if (!entries.length) {
    out.push(COLORS.warn('  no files here'));
    return out;
  }
  const nameW = Math.max(12, width - 24);
  entries.forEach((e, i) => {
    const mark = attached.includes(e.path) ? COLORS.success('+') : ' ';
    const num = String(i + 1).padStart(3);
    out.push(`${mark}${num}  ${fit(e.name, nameW).padEnd(nameW)}  ${human(e.size).padStart(7)}  ${age(e.mtimeMs, now).padStart(4)}`);
  });
  out.push('', COLORS.muted('  /attach 1 3  queues files for your next message · /attach clear'));
  return out;
}

export interface MemResult {
  ok: boolean;
  query: string;
  lines?: string[];
  error?: string;
}

export function buildMemPanel(res: MemResult, width: number): string[] {
  const out: string[] = [COLORS.accent(`memory · "${fit(res.query, Math.max(10, width - 14))}"`), ''];
  if (!res.ok) {
    // The degraded arm is rendered, never an empty pane that reads as "no memories".
    out.push(COLORS.error(`  memory search unavailable: ${res.error || 'unknown error'}`));
    out.push(COLORS.muted('  needs the awm CLI on PATH (pip install awm)'));
    return out;
  }
  const lines = (res.lines || []).filter(l => l.trim());
  if (!lines.length) {
    out.push(COLORS.muted('  nothing recalled for that query'));
    return out;
  }
  for (const l of lines) out.push(fit(l, width));
  return out;
}

/** Text prepended to the next message so the agent opens the files itself. */
export function attachmentPreamble(paths: readonly string[]): string {
  if (!paths.length) return '';
  return `[attached files - read them from disk]\n${paths.map(p => `- ${p}`).join('\n')}\n\n`;
}
