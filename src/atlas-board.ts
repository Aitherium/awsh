/**
 * Atlas' program-manager board in the terminal: `aither -c board`.
 *
 * One source for every surface: the gateway MCP tool `atlas_board`, which reads
 * Genesis `GET /atlas/issues/board` (platform-gated). The desk Deck, Veil Mission
 * Control and the Discord pin all show the same snapshot, so this module only
 * fetches and formats -- it never recomputes stages.
 */

/** One row of `issue_board.rows_for`: `pr` is the PR URL ("" when none). */
export interface AtlasBoardRow {
  number: number;
  stage?: string;
  title?: string;
  detail?: string;
  age_s?: number;
  pr?: string | null;
  thread?: string | null;
  thread_url?: string | null;
  [key: string]: unknown;
}

export interface AtlasBoard {
  counts?: Record<string, number>;
  rows?: AtlasBoardRow[];
  metrics?: Record<string, unknown>;
  text?: string;
  /** epoch seconds */
  updated_at?: number | null;
  error?: string;
}

/** Call the tool and normalise the answer to an AtlasBoard (never throws). */
export async function fetchAtlasBoard(
  invoke: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<AtlasBoard> {
  try {
    const raw = await invoke('atlas_board', { view: 'full' });
    if (raw && typeof raw === 'object') return raw as AtlasBoard;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as AtlasBoard; } catch { return { error: raw.slice(0, 200) }; }
    }
    return { error: 'atlas_board returned nothing' };
  } catch (err: any) {
    return { error: err?.message || 'atlas_board failed' };
  }
}

/** 3h / 2d / 45m -- the same coarse age the Discord board prints. */
export function formatAge(seconds: number | undefined): string {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** "demiurge 2 · lyra 1 · owner 3" in a stable order (largest first, then name). */
export function formatCounts(counts: Record<string, number> | undefined): string {
  const entries = Object.entries(counts || {}).filter(([, n]) => Number(n) > 0);
  if (!entries.length) return 'no tracked issues';
  entries.sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));
  return entries.map(([stage, n]) => `${stage} ${n}`).join(' · ');
}

/**
 * Plain-text lines for the board. `full` prints the server-rendered board text
 * (identical to the Discord pin); otherwise just counts + updated_at.
 */
export function formatAtlasBoard(board: AtlasBoard, opts: { full?: boolean } = {}): string[] {
  if (board.error) return [`Atlas board unavailable: ${board.error}`];
  const lines = [`Atlas:    ${formatCounts(board.counts)}`];
  const at = Number(board.updated_at);
  if (Number.isFinite(at) && at > 0) {
    lines.push(`          updated ${new Date(at * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z`);
  }
  if (opts.full) {
    const text = (board.text || '').trim();
    if (text) {
      lines.push('');
      lines.push(...text.split('\n').map((l) => `  ${l}`));
    } else {
      for (const r of board.rows || []) {
        const link = r.pr || r.thread_url || '';
        const age = formatAge(r.age_s);
        lines.push(`  #${r.number}  ${r.stage || '?'}${age ? `  ${age}` : ''}${link ? `  ${link}` : ''}`);
      }
    }
  }
  return lines;
}
