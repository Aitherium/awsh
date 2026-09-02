/**
 * `aither storage …` / `/storage …` — the awstorage inventory control plane
 * from the CLI.
 *
 * Reads go through GenesisClient against `/api/v1/storage/*`
 * (routers/storage.py). There is no `approve`/`apply` subcommand here on
 * purpose: the router exposes no such route (a human answers a decision
 * card through /api/decisions, never through this CLI — see
 * `.AITHEROS/AWSTORAGE-DESIGN.md` N4/SIC007). `scan --local` is the one
 * subcommand that never touches the network — it spawns the standalone
 * `awstorage` scanner CLI in-place.
 */

import type { GenesisClient } from './client.js';
import { COLORS } from './tui/theme.js';
import { formatTable } from './renderer.js';
import {
  formatBytes,
  getStorageNodes,
  getStorageInventory,
  getStorageDiff,
  getStorageProposals,
  getStorageLedger,
  getStoragePolicy,
  runLocalScan,
  type StorageResult,
} from './storage-client.js';

export interface StorageArgs {
  sub: string;
  flags: Record<string, string | boolean>;
  positional: string[];
  help: boolean;
}

/**
 * Minimal flag parser shared by every storage subcommand: `--name value` when
 * the next token isn't itself a flag, else `--name` is a boolean switch.
 * Everything else is positional.
 */
export function parseStorageArgs(argv: string[]): StorageArgs {
  const help = argv.includes('--help') || argv.includes('-h');
  const first = argv[0] || '';
  const sub = first === '--help' || first === '-h' ? '' : first.toLowerCase();
  const rest = argv.slice(1);
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--help' || a === '-h') continue;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--') && next !== '-h') {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { sub, flags, positional, help };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: string | boolean | undefined): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bool(v: string | boolean | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  return v === 'true' || v === '1';
}

function usage(): void {
  console.log(`
${COLORS.accent('aither storage')} — awstorage inventory control plane (nodes, drives, proposals)

  aither storage nodes                                     which nodes have scanned, how stale
  aither storage inventory [--node N] [--root R] [--top 25] [--cls C] [--refetchable]
                                                             ranked disk consumers from the latest snapshot
  aither storage diff --node N --root R [--from-id ID] [--to-id ID]
                                                             added/removed/grown/shrunk since a prior scan
  aither storage proposals [--node N] [--status proposed|all|...]
                                                             pending/answered reclaim proposals
  aither storage ledger [--node N] [--limit 200]             what apply actually did (dry-run vs executed)
  aither storage policy                                      the effective fleet policy (read-only)
  aither storage scan --local <root>                        run the awstorage scanner HERE, no fleet needed

Reads hit Genesis's /api/v1/storage/* — there is no approve/apply subcommand: a
destructive proposal is answered as a decision card by a human, never from here.
`);
}

function printFailure(r: StorageResult, label: string): number {
  const code = r.status ?? 0;
  if (code === 0) {
    console.error(COLORS.error(`  storage ${label}: cannot reach Genesis — ${r.error}`));
  } else if (code === 401 || code === 403) {
    console.error(COLORS.error(`  storage ${label}: not authorized (${code}) — ${r.error}`));
  } else if (code === 503) {
    console.error(COLORS.error(`  storage ${label}: awstorage unavailable (503) — ${r.error}`));
  } else {
    console.error(COLORS.error(`  storage ${label}: HTTP ${code} — ${r.error}`));
  }
  return 1;
}

async function handleNodes(client: GenesisClient): Promise<number> {
  const r = await getStorageNodes(client);
  if (!r.ok) return printFailure(r, 'nodes');
  const nodes = r.data?.nodes || [];
  if (!nodes.length) {
    console.log(COLORS.muted('  no storage nodes have reported yet'));
    return 0;
  }
  console.log(COLORS.accent(`\n  Storage Nodes  (${nodes.length}, ${formatBytes(r.data?.total_bytes)} total)\n`));
  const rows = nodes.map((n: any) => [
    n.node_id ?? '?',
    formatBytes(n.bytes),
    n.latest ?? '-',
    n.age_seconds != null ? `${Math.round(n.age_seconds / 60)}m` : '?',
    n.is_stale ? COLORS.warn('stale') : COLORS.success('fresh'),
  ]);
  console.log(formatTable(['NODE', 'BYTES', 'LATEST SCAN', 'AGE', 'STATUS'], rows));
  console.log();
  return 0;
}

async function handleInventory(client: GenesisClient, flags: StorageArgs['flags']): Promise<number> {
  const r = await getStorageInventory(client, {
    node: str(flags.node),
    root: str(flags.root),
    cls: str(flags.cls),
    refetchable: bool(flags.refetchable),
    top: num(flags.top) ?? 25,
  });
  if (!r.ok) return printFailure(r, 'inventory');
  const trees: any[] = r.data?.trees || [];
  const summary = r.data?.summary || {};
  console.log(
    COLORS.accent(
      `\n  Inventory  snapshot ${r.data?.snapshot_id ?? '?'}` +
      (summary.total_bytes != null ? `  (${formatBytes(summary.total_bytes)} total)` : ''),
    ),
  );
  if (!trees.length) {
    console.log(COLORS.muted('  (no ranked entries — empty snapshot, or the filter matched nothing)\n'));
    return 0;
  }
  const rows = trees.map((t: any) => [
    formatBytes(t.size_bytes ?? t.bytes ?? t.total_bytes),
    t.category ?? t.cls ?? t.classification ?? '?',
    t.refetchable ? COLORS.success('yes') : COLORS.muted('no'),
    String(t.path ?? t.root ?? '?'),
  ]);
  console.log(formatTable(['BYTES', 'CATEGORY', 'REFETCH', 'PATH'], rows));
  console.log();
  return 0;
}

async function handleDiff(client: GenesisClient, flags: StorageArgs['flags']): Promise<number> {
  const node = str(flags.node);
  const root = str(flags.root);
  if (!node || !root) {
    console.error(COLORS.warn('  usage: aither storage diff --node <id> --root <path> [--from-id N] [--to-id N]'));
    return 2;
  }
  const r = await getStorageDiff(client, {
    node,
    root,
    fromId: num(flags['from-id']),
    toId: num(flags['to-id']),
    minDelta: num(flags['min-delta']),
  });
  if (!r.ok) return printFailure(r, 'diff');
  const d = r.data || {};
  const added: any[] = d.added || [];
  const removed: any[] = d.removed || [];
  const grown: any[] = d.grown || [];
  const shrunk: any[] = d.shrunk || [];
  console.log(
    COLORS.accent(
      `\n  Diff ${node}:${root}  +${added.length} -${removed.length} grown ${grown.length} shrunk ${shrunk.length}` +
      (d.summary?.either_truncated ? COLORS.warn('  (bounded scan — incomplete)') : ''),
    ),
  );
  const rows: string[][] = [];
  for (const e of added) rows.push([COLORS.success('added'), formatBytes(e.bytes ?? e.delta), String(e.path ?? '?')]);
  for (const e of removed) rows.push([COLORS.error('removed'), formatBytes(e.bytes ?? Math.abs(e.delta ?? 0)), String(e.path ?? '?')]);
  for (const e of grown) rows.push([COLORS.warn('grown'), `+${formatBytes(e.delta)}`, String(e.path ?? '?')]);
  for (const e of shrunk) rows.push([COLORS.accent('shrunk'), formatBytes(e.delta), String(e.path ?? '?')]);
  if (!rows.length) {
    console.log(COLORS.muted('  no changes between the two snapshots\n'));
    return 0;
  }
  console.log(formatTable(['KIND', 'DELTA', 'PATH'], rows));
  console.log();
  return 0;
}

async function handleProposals(client: GenesisClient, flags: StorageArgs['flags']): Promise<number> {
  const r = await getStorageProposals(client, {
    node: str(flags.node),
    status: str(flags.status),
    limit: num(flags.limit),
  });
  if (!r.ok) return printFailure(r, 'proposals');
  const rows: any[] = r.data?.proposals || [];
  console.log(
    COLORS.accent(
      `\n  Proposals  (${r.data?.count ?? rows.length}, ${formatBytes(r.data?.bytes)} total` +
      (r.data?.auto_bytes ? `, ${formatBytes(r.data.auto_bytes)} auto-applicable` : '') + ')',
    ),
  );
  if (!rows.length) {
    console.log(COLORS.muted('  none — nothing is waiting on a decision\n'));
    return 0;
  }
  const table = rows.map((p: any) => [
    String(p.id ?? p.proposal_id ?? '?'),
    p.status ?? '?',
    p.cls ?? p.class ?? '?',
    p.node ?? '?',
    formatBytes(p.bytes),
    String(p.path ?? (Array.isArray(p.paths) ? p.paths[0] : '') ?? '-'),
  ]);
  console.log(formatTable(['ID', 'STATUS', 'CLASS', 'NODE', 'BYTES', 'PATH'], table));
  console.log(COLORS.muted('\n  no approve here — answer the raised card via /decisions\n'));
  return 0;
}

async function handleLedger(client: GenesisClient, flags: StorageArgs['flags']): Promise<number> {
  const r = await getStorageLedger(client, { node: str(flags.node), limit: num(flags.limit) });
  if (!r.ok) return printFailure(r, 'ledger');
  const rows: any[] = r.data?.ledger || [];
  console.log(COLORS.accent(`\n  Ledger  (${r.data?.count ?? rows.length} row(s))`));
  if (!rows.length) {
    console.log(COLORS.muted('  empty — nothing has been applied yet\n'));
    return 0;
  }
  const table = rows.map((row: any) => [
    row.at ?? row.timestamp ?? '?',
    row.node ?? '?',
    row.action ?? '?',
    row.outcome === 'dry-run' ? COLORS.muted('dry-run') : COLORS.success('executed'),
    row.result ?? row.outcome ?? '?',
    formatBytes(row.bytes),
    String(row.path ?? '-'),
  ]);
  console.log(formatTable(['AT', 'NODE', 'ACTION', 'MODE', 'RESULT', 'BYTES', 'PATH'], table));
  console.log();
  return 0;
}

async function handlePolicy(client: GenesisClient): Promise<number> {
  const r = await getStoragePolicy(client);
  if (!r.ok) return printFailure(r, 'policy');
  console.log(COLORS.accent(`\n  Effective storage policy  (${r.data?.path ?? '(package default)'})\n`));
  console.log(JSON.stringify(r.data?.policy ?? r.data, null, 2));
  console.log();
  return 0;
}

async function handleScan(flags: StorageArgs['flags'], positional: string[]): Promise<number> {
  const root = str(flags.local) || positional[0];
  if (!flags.local && !root) {
    console.error(COLORS.warn('  usage: aither storage scan --local <root>'));
    console.error(COLORS.muted('  (fleet-side scans are raised by the host steward, not this CLI)'));
    return 2;
  }
  if (!root) {
    console.error(COLORS.warn('  usage: aither storage scan --local <root>'));
    return 2;
  }
  const res = await runLocalScan(root);
  if (!res.ok) {
    console.error(COLORS.error(`  local scan failed: ${res.error}`));
    return 1;
  }
  const snap = res.snapshot || {};
  const trees: any[] = snap.trees || [];
  console.log(
    COLORS.accent(
      `\n  Local scan  ${root}  (${trees.length} tree(s), truncated=${snap.truncated ?? '?'})\n`,
    ),
  );
  if (!trees.length) {
    console.log(COLORS.muted('  no entries returned\n'));
    return 0;
  }
  const top = [...trees]
    .sort((a: any, b: any) => (b.bytes ?? 0) - (a.bytes ?? 0))
    .slice(0, 25);
  const rows = top.map((t: any) => [formatBytes(t.bytes), t.cls ?? '?', String(t.path ?? '?')]);
  console.log(formatTable(['BYTES', 'CATEGORY', 'PATH'], rows));
  console.log(COLORS.muted('\n  (local scan only — not pushed to Genesis; run `awstorage push` for that)\n'));
  return 0;
}

/**
 * Entry point for both `aither storage …` (main.ts interception) and the
 * `/storage …` REPL builtin (commands.ts, tokenized with parseQuotedArgs).
 * Returns an exit-style code: 0 ok, 1 the request failed, 2 a usage error —
 * never 0 on silence.
 */
export async function runStorageCommand(argv: string[], client: GenesisClient): Promise<number> {
  const parsed = parseStorageArgs(argv);
  if (parsed.help || !parsed.sub) {
    usage();
    return parsed.sub ? 0 : 2;
  }
  switch (parsed.sub) {
    case 'nodes':
      return handleNodes(client);
    case 'inventory':
      return handleInventory(client, parsed.flags);
    case 'diff':
      return handleDiff(client, parsed.flags);
    case 'proposals':
      return handleProposals(client, parsed.flags);
    case 'ledger':
      return handleLedger(client, parsed.flags);
    case 'policy':
      return handlePolicy(client);
    case 'scan':
      return handleScan(parsed.flags, parsed.positional);
    default:
      console.error(COLORS.warn(`  unknown storage subcommand: ${parsed.sub}`));
      usage();
      return 2;
  }
}
