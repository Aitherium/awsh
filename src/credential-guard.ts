/**
 * No credential leaves this process for a port on this machine another account holds.
 *
 * A local port is first-come. On a shared machine (awnix gives every uid its own
 * daemon ports from a formula anyone can read) another local user can bind ours while
 * our daemon is down, and whatever we then send -- the account bearer (Authorization,
 * X-API-Key), the harness bearer, the awdk daemon token -- is theirs to replay.
 * localDaemonToken() already withholds the daemon token; this guard covers EVERY
 * credential on EVERY fetch (headers, login/2FA body fields, `?token=` queries), so a
 * new call site cannot reopen the hole. Websockets do not go through fetch: relay.ts
 * and terminal.ts call refuseForeignListener() before they connect.
 *
 * Linux: every LISTEN row (/proc/net/tcp{,6}) reachable through the URL must belong to
 * our uid or to root (root can read our credential files anyway, and owns the fleet's
 * published ports). A table we cannot read refuses (fail closed). No LISTEN row at all
 * passes: the bytes then go nowhere (refused) or through a root-installed DNAT rule,
 * which is how rootful podman publishes a port. localDaemonToken() stays stricter and
 * withholds the daemon token there too. Elsewhere the kernel cannot say, and the guard
 * is a no-op. "This machine" is loopback plus, on Linux, any address on a local
 * interface and any name resolving to one: a URL naming our LAN IP or hostname reaches
 * a 0.0.0.0 squatter just as well. Remote hosts are not its concern.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hostname as osHostname, networkInterfaces } from 'node:os';
import { connectTargets, listenerUids } from './client.js';

/** Request headers that carry something worth stealing. */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-aither-local-token', 'cookie'];
/** JSON body / query / websocket-payload fields that do (login, 2FA, device grant, join). */
const CREDENTIAL_FIELDS = ['password', 'token', 'api_key', 'apikey', 'access_token',
  'refresh_token', 'temp_token', 'otp_token', 'device_code', 'client_secret'];

function hasField(pairs: Iterable<[string, unknown]>): boolean {
  for (const [k, v] of pairs) {
    if (CREDENTIAL_FIELDS.includes(String(k).toLowerCase()) && String(v ?? '').trim() !== '') return true;
  }
  return false;
}

/** True when a request body (JSON text, URLSearchParams or a plain object) names a credential field. */
export function bodyCarriesCredential(body: unknown): boolean {
  if (body === null || body === undefined) return false;
  if (body instanceof URLSearchParams) return hasField(body.entries());
  let doc: unknown = body;
  if (typeof body === 'string') {
    try { doc = JSON.parse(body); } catch { return hasField(new URLSearchParams(body).entries()); }
  }
  return !!doc && typeof doc === 'object' && !Array.isArray(doc) &&
    hasField(Object.entries(doc as object));
}

/** True when the URL's query string names a credential field (`?token=`). */
export function urlCarriesCredential(url: string): boolean {
  try { return hasField(new URL(url).searchParams.entries()); } catch { return false; }
}

/** `url` without its path, query or userinfo -- safe to print in an error. */
function originOf(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return '<unparseable url>'; }
}

export interface GuardEnv {
  procNet: string;
  uid: number | null;
  linux: boolean;
  /** Tests only: this machine's interface addresses, hostname and resolver. */
  interfaces?: () => string[];
  hostname?: () => string;
  lookup?: (host: string) => Promise<string[]>;
}

function defaultEnv(): GuardEnv {
  return {
    procNet: '/proc/net',
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    linux: process.platform === 'linux',
  };
}

/**
 * An address in the form /proc/net decodes it to (client.ts decodeProcAddr): IPv4
 * dotted, an IPv4-mapped IPv6 address as its IPv4, `::` / `::1`, and any other IPv6 as
 * eight uncompressed lower-case hex groups. A zone id (`%eth0`) is dropped. Not an IP: ''.
 */
export function canonicalAddr(ip: string): string {
  ip = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return '';
  let text = ip;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const b = tail[1].split('.').map(Number);
    text = text.slice(0, -tail[1].length) +
      `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : (rest ? rest.split(':') : []);
  const fill = rest === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  const g = [...left, ...fill, ...right].map((x) => parseInt(x, 16));
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
  }
  if (g.every((x) => x === 0)) return '::';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return '::1';
  return g.map((x) => x.toString(16)).join(':');
}

function localAddresses(env: GuardEnv): Set<string> {
  const out = new Set<string>();
  const list = env.interfaces ? env.interfaces()
    : Object.values(networkInterfaces()).flat().map((i) => i?.address ?? '');
  for (const a of list) { const c = canonicalAddr(a); if (c) out.add(c); }
  return out;
}

async function resolveAll(host: string, env: GuardEnv): Promise<string[]> {
  if (env.lookup) return env.lookup(host);
  const rows = await dnsLookup(host, { all: true });
  return rows.map((r) => r.address);
}

/**
 * The addresses on THIS machine a client dialling `host` may reach, else [] (remote).
 * Loopback names and literals first (connectTargets); then, on Linux, an IP literal
 * assigned to a local interface, or a name that resolves to one (os.hostname(), the
 * LAN name, ...). A name that cannot be resolved is remote -- except our own hostname,
 * which throws (the caller refuses: we cannot tell where it goes).
 */
export async function localTargets(host: string, env: GuardEnv): Promise<string[]> {
  const loop = connectTargets(host);
  if (loop.length || !env.linux) return loop;
  const local = localAddresses(env);
  const bare = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const literal = canonicalAddr(bare);
  if (literal) return local.has(literal) ? [literal] : connectTargets(literal);
  let addrs: string[];
  try {
    addrs = await resolveAll(bare, env);
  } catch {
    const self = (env.hostname ? env.hostname() : osHostname()).replace(/\.$/, '').toLowerCase();
    if (bare === self) throw new Error(`cannot resolve this machine's own name ${host}`);
    return [];
  }
  const hits = new Set<string>();
  for (const a of addrs) {
    const c = canonicalAddr(a);
    if (!c) continue;
    const loopHit = connectTargets(c);
    if (loopHit.length) loopHit.forEach((x) => hits.add(x));
    else if (local.has(c)) hits.add(c);
  }
  return [...hits];
}

/** True when any header named in CREDENTIAL_HEADERS carries a non-empty value. */
export function carriesCredential(headers: unknown): boolean {
  if (!headers) return false;
  let pairs: Array<[string, unknown]>;
  if (Array.isArray(headers)) {
    pairs = headers as Array<[string, unknown]>;
  } else if (headers instanceof Headers) {
    pairs = [];
    headers.forEach((v, k) => pairs.push([k, v]));
  } else {
    pairs = Object.entries(headers as object);
  }
  return pairs.some(([k, v]) =>
    CREDENTIAL_HEADERS.includes(String(k).toLowerCase()) && String(v ?? '').trim() !== '');
}

/**
 * Why a credential must NOT go to `url`, or null when it may. Only URLs that reach THIS
 * machine are judged, on Linux: every listener reachable through the URL -- on the
 * target address itself or on the wildcard 0.0.0.0 / :: for that port -- must belong
 * to us or root.
 */
export async function credentialTargetProblem(url: string,
  env: GuardEnv = defaultEnv()): Promise<string | null> {
  let host = '';
  let port = 0;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port) || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80);
  } catch { return null; }
  let targets: string[];
  try { targets = await localTargets(host, env); } catch (e: any) { return String(e?.message || e); }
  if (targets.length === 0 || !env.linux) return null;
  const where = `${targets.join(' / ')} port ${port}`;
  if (env.uid === null) return `cannot tell who listens on ${where} (no uid)`;
  const uids = listenerUids(port, targets, env.procNet);
  if (uids === null) return `cannot tell who listens on ${where} (${env.procNet}/tcp unreadable)`;
  const foreign = uids.filter((u) => u !== env.uid && u !== 0);
  if (foreign.length) {
    return `${where} is held by uid ${foreign.join(',')}, not you (uid ${env.uid}) -- ` +
      'another local account may have taken your daemon\'s port';
  }
  return null;
}

/** Rejects when `url` reaches a port on this machine we do not own. For a transport known
 *  to carry a credential (a websocket join, a tokened query): await it BEFORE connecting. */
export async function refuseForeignListener(url: string, env?: GuardEnv): Promise<void> {
  const problem = await credentialTargetProblem(url, env);
  if (problem) throw new Error(`awsh refused to send credentials to ${originOf(url)}: ${problem}`);
}

/** Rejects before a credential (header, body field or query field) is sent to a port on
 *  this machine we do not own. */
export async function assertCredentialTarget(url: string, headers: unknown, env?: GuardEnv,
  body?: unknown): Promise<void> {
  if (!carriesCredential(headers) && !bodyCarriesCredential(body) && !urlCarriesCredential(url)) return;
  await refuseForeignListener(url, env);
}

type FetchFn = typeof fetch;

/** `inner`, refusing (rejecting) any request whose credentials would reach a foreign listener. */
export function guardFetch(inner: FetchFn, env?: GuardEnv): FetchFn {
  const guarded = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? '');
    await assertCredentialTarget(url, init?.headers, env, init?.body);
    if (input && typeof input === 'object' && !(input instanceof URL)) {
      await assertCredentialTarget(url, input.headers, env);
    }
    return inner(input, init);
  }) as FetchFn;
  (guarded as any).__awshCredentialGuard = true;
  return guarded;
}

/** Wrap the process-wide fetch once. Called first thing by the CLI entry point. */
export function installCredentialGuard(): void {
  if ((globalThis.fetch as any)?.__awshCredentialGuard) return;
  globalThis.fetch = guardFetch(globalThis.fetch.bind(globalThis));
}
