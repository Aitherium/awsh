/**
 * Find the two local planes awsh is useless without: the harness daemon (agents,
 * sessions, decision cards) and the AitherOS MCP gateway (fleet tools, the Atlas board).
 *
 * WHY (measured 2026-11-09, awsh as root in the awnix fleet distro):
 *   - `mcpUrl` defaulted to '' unless a gateway was configured, so `/board` and every
 *     MCP tool fell through to `POST /tools/call` on whatever chat backend the ladder
 *     picked -- there, the awdk demo agent on :8099, which has no fleet tools at all.
 *     The real gateway is `127.0.0.1:8182` (never `localhost`: `::1:8182` refuses).
 *   - The harness daemon runs on the Windows host. Inside awnix it is reachable only
 *     through the fleet bridge relay `10.89.0.1:8362`, never `127.0.0.1:8362`, and its
 *     bearer lives in the WINDOWS user's `~/.aither/harness_token`, not root's.
 *
 * Every candidate is PROBED, never assumed, and a found endpoint is exported to this
 * process's env (`AITHER_HARNESS_URL` / `AITHER_HARNESS_TOKEN`) so the five sibling
 * daemon clients, which each read those two variables, all follow without a rewrite.
 * An explicit env value is always honoured verbatim and disables the search.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LOCAL_HARNESS_URL = 'http://127.0.0.1:8362';
export const LOCAL_MCP_GATEWAY = 'http://127.0.0.1:8182';
/** The awnix podman bridge, where a socat relay forwards :8362 to the Windows host. */
export const FLEET_BRIDGE_IP = '10.89.0.1';

export interface LocateDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** true inside any WSL distro. */
  isWsl?: boolean;
  readFile?: (path: string) => string | null;
  listDir?: (path: string) => string[];
  /** GET url with optional bearer; resolves to the HTTP status, 0 when unreachable. */
  probe?: (url: string, token?: string) => Promise<number>;
}

export function detectWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

const safeRead = (p: string): string | null => {
  try { return readFileSync(p, 'utf8').trim() || null; } catch { return null; }
};
const safeList = (p: string): string[] => {
  try { return existsSync(p) ? readdirSync(p) : []; } catch { return []; }
};

async function defaultProbe(url: string, token?: string): Promise<number> {
  try {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    return res.status;
  } catch {
    return 0;
  }
}

function resolved(deps: LocateDeps) {
  return {
    env: deps.env ?? process.env,
    home: deps.home ?? homedir(),
    isWsl: deps.isWsl ?? detectWsl(deps.env ?? process.env),
    readFile: deps.readFile ?? safeRead,
    listDir: deps.listDir ?? safeList,
    probe: deps.probe ?? defaultProbe,
  };
}

/** Pure: harness URLs to try, best first, de-duplicated. */
export function harnessUrlCandidates(env: NodeJS.ProcessEnv, isWsl: boolean, fileUrl = ''): string[] {
  const explicit = (env.AITHER_HARNESS_URL || '').trim();
  if (explicit) return [explicit.replace(/\/+$/, '')];
  const out = [fileUrl.trim(), LOCAL_HARNESS_URL];
  if (isWsl) out.push(`http://${(env.AITHER_FLEET_BRIDGE_IP || FLEET_BRIDGE_IP).trim()}:8362`);
  return [...new Set(out.filter(Boolean).map((u) => u.replace(/\/+$/, '')))];
}

/** Pure: MCP gateway base URLs (no `/mcp`) to try, best first. */
export function gatewayUrlCandidates(env: NodeJS.ProcessEnv, configuredMcpUrl = ''): string[] {
  const explicit = (env.AITHER_MCP_URL || configuredMcpUrl || '').trim();
  if (explicit) return [explicit.replace(/\/+$/, '').replace(/\/mcp$/, '')];
  return [LOCAL_MCP_GATEWAY];
}

/**
 * Pure: where a bearer FILE may live, best first. Inside WSL the owner's Windows
 * profile is mounted under /mnt/c (and /var/mnt/c on an image-based distro); a file
 * there is used only when exactly ONE Windows profile carries it -- two would be a
 * guess about whose credential to send.
 */
export function tokenFileCandidates(
  name: string, home: string, isWsl: boolean, listDir: (p: string) => string[],
): string[] {
  const out = [join(home, '.aither', name)];
  if (isWsl) {
    for (const root of ['/mnt/c/Users', '/var/mnt/c/Users']) {
      const owners = listDir(root)
        .filter((u) => !/^(Public|Default|Default User|All Users|desktop\.ini)$/i.test(u))
        .map((u) => `${root}/${u}/.aither/${name}`);
      out.push(...owners);
    }
  }
  return out;
}

function readTokens(files: string[], readFile: (p: string) => string | null, home: string): string[] {
  const own = join(home, '.aither');
  const tokens: string[] = [];
  const foreign: string[] = [];
  for (const f of files) {
    const t = readFile(f);
    if (!t) continue;
    (f.startsWith(own) ? tokens : foreign).push(t);
  }
  const uniqueForeign = [...new Set(foreign)];
  if (uniqueForeign.length === 1) tokens.push(uniqueForeign[0]);
  return [...new Set(tokens)];
}

export interface Located { url: string; token: string; tried: string[] }

/**
 * Find a harness daemon that answers /health AND accepts a bearer on /agents.
 * On success exports AITHER_HARNESS_URL/AITHER_HARNESS_TOKEN into `env` (process.env
 * by default). Returns null with nothing exported when no candidate answers.
 */
export async function locateHarness(deps: LocateDeps = {}, fileUrl = ''): Promise<Located | null> {
  const d = resolved(deps);
  const tried: string[] = [];
  const envToken = (d.env.AITHER_HARNESS_TOKEN || '').trim();
  const tokens = envToken
    ? [envToken]
    : readTokens(tokenFileCandidates('harness_token', d.home, d.isWsl, d.listDir), d.readFile, d.home);
  for (const url of harnessUrlCandidates(d.env, d.isWsl, fileUrl)) {
    tried.push(url);
    if ((await d.probe(`${url}/health`)) !== 200) continue;
    for (const token of tokens) {
      if ((await d.probe(`${url}/agents`, token)) === 200) {
        d.env.AITHER_HARNESS_URL = url;
        d.env.AITHER_HARNESS_TOKEN = token;
        return { url, token, tried };
      }
    }
  }
  return null;
}

/**
 * Find the MCP gateway (`<base>/health` == 200) and the bearer the stdio bridge uses
 * (`~/.aither/session-bearer`). Returns `{url: <base>/mcp, token}` or null.
 */
export async function locateMcpGateway(
  deps: LocateDeps = {}, configuredMcpUrl = '', fallbackToken = '',
): Promise<Located | null> {
  const d = resolved(deps);
  const tried: string[] = [];
  const tokens = readTokens(tokenFileCandidates('session-bearer', d.home, d.isWsl, d.listDir), d.readFile, d.home);
  for (const base of gatewayUrlCandidates(d.env, configuredMcpUrl)) {
    tried.push(base);
    if ((await d.probe(`${base}/health`)) !== 200) continue;
    return { url: `${base}/mcp`, token: tokens[0] || fallbackToken, tried };
  }
  return null;
}
