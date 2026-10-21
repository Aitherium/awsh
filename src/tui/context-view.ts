/**
 * Context views — see and search agent memory, and pick files to hand the agent,
 * without leaving the terminal (owner 2026-10-21: "stop having to use windows file
 * explorer to drag and drop context to my agents").
 *
 *   /mem <query>     awm recall, rendered in the viewer
 *   /files [N]       newest N files in ~/Downloads (or AITHER_FILES_DIR), numbered
 *   /attach 1 3      queue those entries; the next message carries their paths
 *   /attach clear    drop the queue
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
  | { kind: 'usage'; message: string };

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
  return null;
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
