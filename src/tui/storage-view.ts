/**
 * Storage cockpit view — read-only observation of node freshness from the
 * awstorage inventory plane (Genesis `/api/v1/storage/nodes`).
 *
 * Pure render function following the TUI view seam used by sessions-view.ts:
 * (snapshot, width) → string[]. No fetch, no client — the caller resolves the
 * snapshot (or its absence) and hands it in, so this stays testable without a
 * live Genesis.
 */

import { COLORS } from './theme.js';
import { formatBytes } from '../storage-client.js';

export interface StorageNodeRow {
  node_id: string;
  bytes?: number;
  latest?: string | null;
  age_seconds?: number | null;
  is_stale?: boolean;
}

export interface StoragePanelSnapshot {
  /** false when Genesis could not be reached or answered non-2xx — the
   *  degraded arm this view exists to render honestly rather than as a
   *  silent empty table (security-review-patterns.md #5). */
  reachable: boolean;
  error?: string;
  nodes: StorageNodeRow[];
  total_bytes?: number;
}

function ageLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '?';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return width > 1 ? `${s.slice(0, width - 1)}…` : s.slice(0, width);
}

/**
 * Pure render function: build the storage cockpit panel.
 *
 * Returns pre-colored, width-bounded lines. `reachable: false` renders the
 * degraded arm ("storage unavailable …") instead of pretending the node list
 * is complete — an unreachable Genesis must never look identical to "no
 * storage nodes have reported yet".
 */
export function buildStoragePanel(snapshot: StoragePanelSnapshot, width: number): string[] {
  const lines: string[] = [];
  lines.push(COLORS.accent('Storage'));

  if (!snapshot.reachable) {
    lines.push(COLORS.error(`✗ storage unavailable${snapshot.error ? `: ${truncate(snapshot.error, Math.max(10, width - 20))}` : ''}`));
    return lines;
  }

  const nodes = snapshot.nodes || [];
  if (nodes.length === 0) {
    lines.push(COLORS.muted('no storage nodes have reported yet'));
    return lines;
  }

  const nameWidth = Math.max(8, Math.min(20, width - 40));
  lines.push(
    COLORS.muted(
      `${'node'.padEnd(nameWidth)}  ${'bytes'.padStart(9)}  ${'age'.padStart(6)}  status`,
    ),
  );

  for (const n of nodes) {
    const staleness = n.is_stale ? COLORS.warn('stale') : COLORS.success('fresh');
    lines.push(
      `${truncate(n.node_id || '?', nameWidth).padEnd(nameWidth)}  ` +
      `${formatBytes(n.bytes).padStart(9)}  ` +
      `${ageLabel(n.age_seconds).padStart(6)}  ${staleness}`,
    );
  }

  const staleCount = nodes.filter((n) => n.is_stale).length;
  lines.push('');
  lines.push(
    COLORS.muted(
      `${nodes.length} node(s) · ${formatBytes(snapshot.total_bytes)} total` +
      (staleCount > 0 ? ` · ${staleCount} stale` : ''),
    ),
  );

  return lines;
}
