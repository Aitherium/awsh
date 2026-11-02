/**
 * resume-line.ts — WHERE YOU LEFT OFF: external working memory on the home screen.
 *
 * The data is the EXISTING session focus tracker (`.claude/hooks/session-focus.py`):
 * its Stop hook writes one record per session to
 * `~/.aither/focus/<project-key>/<session_id>.json` with `first_ask`, `last_ask`,
 * `next` (the closing report's `NEXT:` step), `transcript`, `project` and `updated`
 * (epoch seconds). Session titles named by the local model live in
 * `~/.aither/session-labels/<sid>.json`. This module only READS those files.
 *
 * Output, above the NEXT block:
 *   Last: making the Iris song (2 h ago) — next: approve the lyrics draft
 *     2 more threads
 *
 * Only OWNER-launched threads count. Excluded, each by a marker the data carries:
 *   - a non-`cli` `entrypoint` in the transcript head (`sdk-cli` = spawned by a
 *     program: awdesk card callbacks, forge, workflows);
 *   - a transcript outside `~/.claude/projects/` (harness/test event logs);
 *   - a project dir under a temp or worktree path;
 *   - a first ask that is a machine preamble (card answers, crash-resume launcher).
 * The "+N more" line counts only threads touched in the last 24 h and is dropped at 0.
 * It carries no hint: awsh has no command that lists these threads.
 *
 * Silent by contract: missing dir, unreadable or malformed records, or nothing newer
 * than three days all yield `[]` — never an error line. `AWSH_RESUME=0` disables it.
 */
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Records older than this are not "where you left off" any more. */
export const RESUME_MAX_AGE_SEC = 3 * 86400;
/** Other threads count toward "+N more" only while touched this recently. */
export const LIVE_THREAD_SEC = 86400;
const GOAL_MAX = 60;
const NEXT_MAX = 90;
/** Bytes of the transcript head read for its `entrypoint` marker. */
const HEAD_BYTES = 16 * 1024;

/** First asks written by a program, not typed by the owner. */
const MACHINE_ASK = [
  /^owner answered (credential |decision )?card\b/i,
  /^you are helping the user resume\b/i,
  /^<(task-notification|command-name)/i,
];

export interface FocusRecord {
  sessionId: string;
  goal: string;
  next: string;
  latestAsk: string;
  updated: number;
}

export interface ResumeOptions {
  /** `~/.aither/focus` unless `AITHER_FOCUS_DIR` (the hook's own override). */
  focusDir?: string;
  /** `~/.aither/session-labels` unless `AWRELAY_SESSION_LABELS`. */
  labelsDir?: string;
  nowSec?: number;
}

/** Collapse whitespace and clip at a word boundary (law: truncation is never silent). */
export function clip(text: string, max: number): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.—+&/-]+$/, '') + '…';
}

/** A readable title: paste/image markers gone, URLs reduced to their last path
 *  segment (`https://github.com/wizzense/i-have-adhd` → `i-have-adhd`), whitespace
 *  collapsed, clipped at 60 on a word boundary. */
export function cleanTitle(text: string, max: number = GOAL_MAX): string {
  const raw = String(text || '');
  // A title the labeller already clipped keeps an honest ellipsis after cleaning.
  const wasClipped = /…\s*$/.test(raw.replace(/\[(Image|Pasted text)[^\]]*\]/gi, '').trim());
  const s = raw
    .replace(/\[(Image|Pasted text)[^\]]*\]/gi, ' ')
    .replace(/\bhttps?:\/\/[^\s)\]>'"]+/gi, (url) => {
      const path = url.replace(/[?#].*$/, '').replace(/[/.,;:]+$/, '');
      const parts = path.split('/').filter(Boolean);
      return parts.length > 1 ? parts[parts.length - 1] : '';
    })
    .replace(/…/g, ' ') // a label generator's own clip mark; ours is re-added below
    .replace(/\s+/g, ' ')
    // `url -- [Image #1] -- text` leaves `-- --` runs once the markers are gone.
    .replace(/(?:\s+(?:--+|—)(?=\s))+/g, ' —')
    .trim()
    .replace(/^[-—:|,.\s]+/, '')
    .replace(/[-—:|,\s]+$/, '');
  const out = clip(s, max);
  return wasClipped && out && !out.endsWith('…') ? out.replace(/[\s+&/]+$/, '') + '…' : out;
}

/** "2 h ago" / "15 min ago" / "3 d ago" — specific, never vague. */
export function ageWords(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** The model-named session title. A `source: "fallback"` label is only the first ask
 *  pre-clipped by the labeller, so the full first ask (cleaned here) beats it. */
function readTitle(labelsDir: string, sid: string): string {
  const safe = sid.replace(/[^A-Za-z0-9-]/g, '');
  if (!safe) return '';
  try {
    const label = JSON.parse(readFileSync(join(labelsDir, `${safe}.json`), 'utf8'));
    if (label?.source === 'fallback') return '';
    return typeof label?.title === 'string' ? label.title : '';
  } catch {
    return '';
  }
}

/** The transcript's `entrypoint` ("cli" when the owner typed `claude`), or '' when
 *  the head cannot be read — unknown is not evidence, so it is not excluded. */
export function transcriptEntrypoint(path: string): string {
  if (!path) return '';
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const m = /"entrypoint"\s*:\s*"([^"]+)"/.exec(buf.subarray(0, n).toString('utf8'));
    return m ? m[1] : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** True when the record carries a marker of a program-launched session. */
export function isMachineSession(r: Record<string, unknown>): boolean {
  const ask = typeof r.first_ask === 'string' ? r.first_ask.trim() : '';
  if (MACHINE_ASK.some((re) => re.test(ask))) return true;
  const project = typeof r.project === 'string' ? r.project.replace(/\\/g, '/') : '';
  if (/\/(te?mp|worktrees?|\.worktrees)\//i.test(project + '/')) return true;
  const transcript = typeof r.transcript === 'string' ? r.transcript : '';
  if (transcript && !/[\\/]\.claude[\\/]projects[\\/]/.test(transcript)) return true;
  const entry = transcriptEntrypoint(transcript);
  return entry !== '' && entry !== 'cli';
}

/** Fresh OWNER focus records, newest first, one per session. Never throws. */
export function loadFocusRecords(opts: ResumeOptions = {}): FocusRecord[] {
  const root = opts.focusDir ?? (process.env.AITHER_FOCUS_DIR || join(homedir(), '.aither', 'focus'));
  const labels = opts.labelsDir
    ?? (process.env.AWRELAY_SESSION_LABELS?.trim() || join(homedir(), '.aither', 'session-labels'));
  const now = opts.nowSec ?? Date.now() / 1000;
  const bySid = new Map<string, FocusRecord>();
  const machine = new Set<string>();
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return [];
  }
  for (const proj of projects) {
    if (proj === 'seen') continue; // the --deliver bookkeeping dir, not records
    let files: string[];
    try {
      files = readdirSync(join(root, proj)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(root, proj, f);
      try {
        // mtime first: hundreds of old records are skipped without a parse.
        if (now - statSync(path).mtimeMs / 1000 > RESUME_MAX_AGE_SEC) continue;
        const r = JSON.parse(readFileSync(path, 'utf8'));
        if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
        const updated = Number(r.updated);
        const sid = typeof r.session_id === 'string' ? r.session_id : '';
        if (!sid || machine.has(sid)) continue;
        if (!Number.isFinite(updated) || now - updated > RESUME_MAX_AGE_SEC) continue;
        const prev = bySid.get(sid);
        if (prev && prev.updated >= updated) continue;
        if (!prev && isMachineSession(r)) {
          machine.add(sid);
          continue;
        }
        const ask = typeof r.first_ask === 'string' ? r.first_ask : '';
        const goal = cleanTitle(readTitle(labels, sid)) || cleanTitle(ask);
        if (!goal) continue;
        bySid.set(sid, {
          sessionId: sid,
          goal,
          next: typeof r.next === 'string' ? r.next : '',
          latestAsk: typeof r.last_ask === 'string' ? r.last_ask : '',
          updated,
        });
      } catch {
        continue;
      }
    }
  }
  return [...bySid.values()].sort((a, b) => b.updated - a.updated);
}

/** The home lines: the newest owner thread, then the count of the other LIVE ones. */
export function formatResume(recs: FocusRecord[], nowSec: number = Date.now() / 1000): string[] {
  const top = recs[0];
  if (!top) return [];
  let line = `Last: ${top.goal} (${ageWords(nowSec - top.updated)})`;
  // "nothing for you …" is a closing courtesy, not a step the reader can take.
  if (top.next.trim() && !/^nothing\b/i.test(top.next.trim())) {
    line += ` — next: ${clip(top.next, NEXT_MAX)}`;
  }
  const out = [line];
  const more = recs.slice(1).filter((r) => nowSec - r.updated <= LIVE_THREAD_SEC).length;
  if (more > 0) out.push(`  ${more} more thread${more === 1 ? '' : 's'}`);
  return out;
}

/** Everything the call site needs: `[]` whenever there is nothing worth saying. */
export function resumeLines(opts: ResumeOptions = {}): string[] {
  if (process.env.AWSH_RESUME === '0') return [];
  try {
    const now = opts.nowSec ?? Date.now() / 1000;
    return formatResume(loadFocusRecords({ ...opts, nowSec: now }), now);
  } catch {
    return [];
  }
}
