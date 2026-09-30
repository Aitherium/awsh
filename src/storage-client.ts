/**
 * Genesis client wrapper for `awsh storage` — the awstorage inventory control
 * plane (AitherOS/packages/awstorage, `routers/storage.py`,
 * `.AITHEROS/AWSTORAGE-DESIGN.md`).
 *
 * Every read here is a thin GET against `/api/v1/storage/*` through
 * `GenesisClient.getDetailed` — never `.get()`, which collapses any error
 * (401, 403, 413, 503, unreachable) to `null`. That collapse is indistinguishable
 * from "no data yet", and this surface exists specifically so a caller can tell
 * the two apart (see the NOTE on listExpeditions() in client.ts, and
 * security-review-patterns.md #5 — an always-empty read reads as a working,
 * inert feature unless the failure is surfaced).
 *
 * There is deliberately no apply/approve function here. The router exposes no
 * approve or apply route (a human answers a decision card through
 * `/api/decisions`, never through this CLI) and this client does not invent one.
 * The one write, shareStoragePath(), only CREATES a proposal.
 */

import type { GenesisClient } from './client.js';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

/** Default duplicate floor on every surface (contract A5): 1 MiB. */
export const DEFAULT_MIN_BYTES = 1024 * 1024;
/** The first-run command the "not indexed" state shows (A5). */
export const FIRST_RUN_COMMAND = 'awstorage files scan --all-volumes && awstorage push';
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * The node id this machine speaks for, in `awstorage whoami` order: env
 * AWSTORAGE_NODE, then ~/.aither/node-id, then the hostname. Never throws.
 */
export function awstorageWhoami(deps: {
  env?: Record<string, string | undefined>;
  readFile?: (p: string) => string;
  home?: () => string;
  host?: () => string;
} = {}): { node: string; source: string } {
  const env = deps.env ?? process.env;
  const fromEnv = String(env.AWSTORAGE_NODE ?? '').trim();
  if (fromEnv) return { node: fromEnv, source: 'env:AWSTORAGE_NODE' };
  const file = join((deps.home ?? homedir)(), '.aither', 'node-id');
  try {
    const text = String((deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(file)).trim();
    if (NODE_ID_RE.test(text)) return { node: text, source: `file:${file}` };
  } catch {
    /* no node-id file: fall through to the hostname */
  }
  return { node: (deps.host ?? hostname)(), source: 'hostname' };
}

/** Index state every search/dupes/tree answer carries (A5). */
export interface IndexState {
  indexed_roots?: { root: string }[];
  stale?: boolean;
}

/** Which of the three distinct empty states an EMPTY answer is. A server that does
 *  not report index state reads as "no match", never "not indexed". */
export function emptyStateLine(data: IndexState | null | undefined, what: string): string {
  if (data && Array.isArray(data.indexed_roots) && data.indexed_roots.length === 0) {
    return `no node is indexed yet -- run \`${FIRST_RUN_COMMAND}\` on the machine`;
  }
  if (data && data.stale) return `the index is stale -- ${what} may be missing; re-run \`${FIRST_RUN_COMMAND}\``;
  return `no ${what}`;
}

export interface StorageResult<T = any> {
  ok: boolean;
  data?: T;
  /** The server's own message (HTTPException detail) — the real cause of a
   *  401/403/413/503, not a generic "request failed". */
  error?: string;
  /** 0 means the request never reached a server (network/timeout). */
  status?: number;
}

function isErrorShape(v: any): v is { error: string; status: number } {
  return !!v && typeof v === 'object' && typeof v.error === 'string';
}

async function get(client: GenesisClient, path: string): Promise<StorageResult> {
  const res = await client.getDetailed(path);
  if (isErrorShape(res)) {
    return { ok: false, error: res.error, status: res.status };
  }
  return { ok: true, data: res };
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Human-readable byte size — the ONE formatBytes for the storage surface
 * (nodes/inventory/diff/ledger tables and the TUI panel all import this
 * rather than each rolling their own).
 */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const sign = n < 0 ? '-' : '';
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 || v >= 10 ? 0 : 1;
  return `${sign}${v.toFixed(digits)}${units[i]}`;
}

export async function getStorageNodes(client: GenesisClient): Promise<StorageResult> {
  return get(client, '/api/v1/storage/nodes');
}

export interface InventoryOpts {
  node?: string;
  root?: string;
  snapshot?: number;
  cls?: string;
  refetchable?: boolean;
  top?: number;
}

export async function getStorageInventory(
  client: GenesisClient,
  opts: InventoryOpts = {},
): Promise<StorageResult> {
  return get(
    client,
    `/api/v1/storage/inventory${qs({
      node: opts.node,
      root: opts.root,
      snapshot: opts.snapshot,
      cls: opts.cls,
      refetchable: opts.refetchable === undefined ? undefined : String(opts.refetchable),
      top: opts.top,
    })}`,
  );
}

export interface DiffOpts {
  node: string;
  root: string;
  fromId?: number;
  toId?: number;
  minDelta?: number;
}

/** Genesis requires BOTH `node` and `root` for /diff (no default pair lookup
 *  without them) — callers must validate before calling this. */
export async function getStorageDiff(client: GenesisClient, opts: DiffOpts): Promise<StorageResult> {
  return get(
    client,
    `/api/v1/storage/diff${qs({
      node: opts.node,
      root: opts.root,
      from_id: opts.fromId,
      to_id: opts.toId,
      min_delta: opts.minDelta,
    })}`,
  );
}

export interface ProposalsOpts {
  node?: string;
  /** Server default is "proposed"; pass "all" to see every status. */
  status?: string;
  limit?: number;
}

export async function getStorageProposals(
  client: GenesisClient,
  opts: ProposalsOpts = {},
): Promise<StorageResult> {
  return get(client, `/api/v1/storage/proposals${qs({ node: opts.node, status: opts.status, limit: opts.limit })}`);
}

export interface LedgerOpts {
  node?: string;
  limit?: number;
}

export async function getStorageLedger(client: GenesisClient, opts: LedgerOpts = {}): Promise<StorageResult> {
  return get(client, `/api/v1/storage/ledger${qs({ node: opts.node, limit: opts.limit })}`);
}

export async function getStoragePolicy(client: GenesisClient): Promise<StorageResult> {
  return get(client, '/api/v1/storage/policy');
}

/* ── Disk index: files search / dupes / tree / share ──────────────────────
 * The contract (the disk index contract: routers/storage.py + routers/storage_share.py):
 *   GET  /api/v1/storage/files/search?q=&node=&ext=&min_bytes=&newer_days=&limit=&cursor=
 *   GET  /api/v1/storage/files/dupes?node=&min_bytes=&limit=   (min_bytes default 1 MiB)
 *   GET  /api/v1/storage/files/tree?node=&path=&depth=
 *   GET  /api/v1/storage/files/nodes, GET /api/v1/storage/files/proposals?node=
 *   POST /api/v1/storage/share {node,path,seal?} -> a card-gated proposal (platform
 *        nodes only until card recipients land), GET /api/v1/storage/shares
 * The server derives which nodes the caller may see from the authenticated
 * caller; `node` here is only a filter, never an authorization claim.
 */

export interface FileHit {
  node: string;
  path: string;
  bytes: number;
  /** Pre-A5 servers sent `size`. */
  size?: number;
  mtime?: number | string | null;
  ext?: string | null;
  mime?: string | null;
  sha256?: string | null;
}

export interface FilesSearchOpts {
  q: string;
  node?: string;
  ext?: string;
  minBytes?: number;
  newerDays?: number;
  limit?: number;
  cursor?: string;
}

export async function searchStorageFiles(
  client: GenesisClient,
  opts: FilesSearchOpts,
): Promise<StorageResult<IndexState & { items: FileHit[]; next_cursor?: string | null; partial?: boolean }>> {
  return get(
    client,
    `/api/v1/storage/files/search${qs({
      q: opts.q,
      node: opts.node,
      ext: opts.ext,
      min_bytes: opts.minBytes,
      newer_days: opts.newerDays,
      limit: opts.limit,
      cursor: opts.cursor,
    })}`,
  );
}

export interface DupeGroup {
  sha256: string;
  bytes: number;
  /** Pre-A5 servers sent `size`. */
  size?: number;
  count: number;
  wasted_bytes: number;
  /** What a proposal could actually reclaim -- the reclaimable figure (A5). */
  actionable_bytes?: number;
  paths: { node: string; path: string }[];
  paths_truncated?: boolean;
}

export interface DupesOpts {
  node?: string;
  minBytes?: number;
  limit?: number;
}

export async function getStorageDupes(
  client: GenesisClient,
  opts: DupesOpts = {},
): Promise<StorageResult<IndexState & { groups: DupeGroup[]; total_wasted_bytes?: number; next_cursor?: string | null }>> {
  return get(
    client,
    `/api/v1/storage/files/dupes${qs({ node: opts.node, min_bytes: opts.minBytes ?? DEFAULT_MIN_BYTES, limit: opts.limit })}`,
  );
}

/** The caller's indexed nodes (A2) -- pick one of these, never guess. */
export async function getStorageFileNodes(client: GenesisClient): Promise<StorageResult> {
  return get(client, '/api/v1/storage/files/nodes');
}

/** Manage proposals, scope-filtered by Genesis (A7). */
export async function getStorageManageProposals(
  client: GenesisClient,
  opts: { node?: string; limit?: number } = {},
): Promise<StorageResult> {
  return get(client, `/api/v1/storage/files/proposals${qs({ node: opts.node, limit: opts.limit })}`);
}

export interface TreeChild {
  name: string;
  kind: string;
  bytes?: number;
  files?: number;
  newest_mtime?: number | string | null;
}

export interface TreeOpts {
  node?: string;
  path?: string;
  depth?: number;
}

export async function getStorageTree(
  client: GenesisClient,
  opts: TreeOpts = {},
): Promise<StorageResult<IndexState & { path: string; children: TreeChild[]; truncated?: boolean; next_cursor?: string | null }>> {
  return get(
    client,
    `/api/v1/storage/files/tree${qs({ node: opts.node, path: opts.path, depth: opts.depth })}`,
  );
}

export interface ShareOpts {
  node: string;
  path: string;
  seal?: boolean;
}

/**
 * Ask Genesis to share a NODE path. This does NOT publish anything by itself: the
 * server answers with a proposal id and raises its decision card, which a human
 * answers (A7: always card-gated; tenant nodes are 409 until card recipients land).
 * The body carries only what the contract names — the server resolves ownership
 * from the bearer. Workspace files are shared through aitherium.com/share.
 */
export async function shareStoragePath(client: GenesisClient, opts: ShareOpts): Promise<StorageResult> {
  const body: Record<string, any> = { node: opts.node, path: opts.path };
  if (opts.seal !== undefined) body.seal = opts.seal;
  const res = await client.postDetailed('/api/v1/storage/share', body);
  if (isErrorShape(res)) return { ok: false, error: res.error, status: res.status };
  return { ok: true, data: res };
}

export async function getStorageShares(client: GenesisClient): Promise<StorageResult> {
  return get(client, '/api/v1/storage/shares');
}

/* ── `--local` scan: no network, no Genesis ─────────────────────────────── */

export interface LocalScanResult {
  ok: boolean;
  snapshot?: any;
  error?: string;
}

function runOnce(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (result: { ok: boolean; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      done({ ok: false, stdout: '', stderr: err?.message || String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => done({ ok: false, stdout, stderr: err.message }));
    child.on('close', (code) => done({ ok: code === 0, stdout, stderr }));
  });
}

/**
 * `awsh storage scan --local <root>` spawns the standalone `awstorage` CLI
 * scanner directly — the same brick node runners use, with no fleet involved.
 * Tries the installed console script first, falls back to the module form
 * (`python -m awstorage.cli`) for a dev checkout with no `[project.scripts]`
 * entry point installed yet.
 */
export async function runLocalScan(root: string): Promise<LocalScanResult> {
  // `awstorage scan <root> [--json <file>]` -- `root` is POSITIONAL (there is no
  // `--roots` flag) and `--json` writes the snapshot to a FILE, it does not print
  // it to stdout (awstorage/cli.py:_cmd_scan). So this spawns into a temp file and
  // reads that back, rather than parsing stdout (which carries the human-readable
  // summary/table, not JSON).
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const outFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'awsh-storage-')), 'scan.json');
  const args = ['scan', root, '--json', outFile, '--quiet'];
  let res = await runOnce('awstorage', args);
  if (!res.ok && /ENOENT/i.test(res.stderr)) {
    res = await runOnce('python', ['-m', 'awstorage.cli', ...args]);
  }
  if (!res.ok) {
    await fs.rm(path.dirname(outFile), { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      error: (res.stderr || res.stdout || 'awstorage not found on PATH (pip install awstorage)').trim().slice(0, 800),
    };
  }
  try {
    const text = await fs.readFile(outFile, 'utf-8');
    return { ok: true, snapshot: JSON.parse(text) };
  } catch (err: any) {
    return { ok: false, error: `awstorage did not write a readable snapshot file: ${err?.message || err}` };
  } finally {
    await fs.rm(path.dirname(outFile), { recursive: true, force: true }).catch(() => {});
  }
}
