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
 * There is deliberately no write/apply/approve function here. The router
 * exposes no approve or apply route (a human answers a decision card through
 * `/api/decisions`, never through this CLI) and this client does not invent one.
 */

import type { GenesisClient } from './client.js';
import { spawn } from 'node:child_process';

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
