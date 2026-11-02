/**
 * resume-line.ts — WHERE YOU LEFT OFF: external working memory on the home screen.
 *
 * The data is the EXISTING session focus tracker (`.claude/hooks/session-focus.py`):
 * its Stop hook writes one record per session to
 * `~/.aither/focus/<project-key>/<session_id>.json` with `first_ask`, `last_ask`,
 * `next` (the closing report's `NEXT:` step) and `updated` (epoch seconds). Session
 * titles named by the local model live in `~/.aither/session-labels/<sid>.json`.
 * This module only READS those files — it is not a second tracker.
 *
 * Output, above the NEXT block:
 *   Last: making the Iris song (2 h ago) — next: approve the lyrics draft
 *     2 more threads (4ff63b67, b03083e3) — python .claude/hooks/session-focus.py --show <id>
 *
 * Silent by contract: missing dir, unreadable or malformed records, or nothing newer
 * than three days all yield `[]` — never an error line. `AWSH_RESUME=0` disables it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Records older than this are not "where you left off" any more. */
export const RESUME_MAX_AGE_SEC = 3 * 86400;
/** The hook's own `--show` read; the affordance that reveals the other threads. */
const SHOW_CMD = 'python .claude/hooks/session-focus.py --show <id>';
const GOAL_MAX = 70;
const NEXT_MAX = 90;

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
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.—-]+$/, '') + '…';
}

/** "2 h ago" / "15 min ago" / "3 d ago" — specific, never vague. */
export function ageWords(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function readTitle(labelsDir: string, sid: string): string {
  const safe = sid.replace(/[^A-Za-z0-9-]/g, '');
  if (!safe) return '';
  try {
    const t = JSON.parse(readFileSync(join(labelsDir, `${safe}.json`), 'utf8'))?.title;
    return typeof t === 'string' ? t : '';
  } catch {
    return '';
  }
}

/** Fresh focus records, newest first, one per session. Never throws. */
export function loadFocusRecords(opts: ResumeOptions = {}): FocusRecord[] {
  const root = opts.focusDir ?? (process.env.AITHER_FOCUS_DIR || join(homedir(), '.aither', 'focus'));
  const labels = opts.labelsDir
    ?? (process.env.AWRELAY_SESSION_LABELS?.trim() || join(homedir(), '.aither', 'session-labels'));
  const now = opts.nowSec ?? Date.now() / 1000;
  const bySid = new Map<string, FocusRecord>();
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
        if (!sid || !Number.isFinite(updated) || now - updated > RESUME_MAX_AGE_SEC) continue;
        const goal = readTitle(labels, sid) || (typeof r.first_ask === 'string' ? r.first_ask : '');
        if (!goal.trim()) continue;
        const prev = bySid.get(sid);
        if (prev && prev.updated >= updated) continue;
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

/** The home lines for a set of records: the newest thread, then the count of the rest. */
export function formatResume(recs: FocusRecord[], nowSec: number = Date.now() / 1000): string[] {
  const top = recs[0];
  if (!top) return [];
  let line = `Last: ${clip(top.goal, GOAL_MAX)} (${ageWords(nowSec - top.updated)})`;
  if (top.next.trim()) line += ` — next: ${clip(top.next, NEXT_MAX)}`;
  const out = [line];
  const more = recs.length - 1;
  if (more > 0) {
    const ids = recs.slice(1, 4).map((r) => r.sessionId.slice(0, 8)).join(', ');
    const tail = more > 3 ? ', …' : '';
    out.push(`  ${more} more thread${more === 1 ? '' : 's'} (${ids}${tail}) — ${SHOW_CMD}`);
  }
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
