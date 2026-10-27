/**
 * AitherSecrets — the vault client awsh never had.
 *
 * awdk has `adk vault` (`adk/vault_lockbox.py`, an 850-line client with a
 * keyring, PIN unlock, agent credentials and a local encrypted fallback) and
 * awdk's Python shell has a `/secret` plugin. The awsh CLI had NEITHER: only
 * `credential-guard.ts` (refuse to send a credential to a strange listener) and
 * `secret-input.ts` (read a secret without echoing it). A person told to "put
 * it in the vault" from awsh had no verb for it, which is why the vault felt
 * like it did not exist outside the Python lane.
 *
 * This is the transport, kept deliberately small and pure so it can be tested
 * without a vault: URL and credential resolution, four calls, and parsers that
 * accept the two body shapes the service actually returns.
 *
 * THE CONTRACT (AitherGenesis/routers/secrets_proxy.py, the host-reachable
 * path that authenticates a session and routes to the vault service):
 *   GET    /secrets           -> {"secrets": [{"name": …} | "NAME"]} or [ … ]
 *   GET    /secrets/{name}    -> "value" or {"value": "…"}
 *   POST   /secrets           {name, value, secret_type, access_level, …}
 *   DELETE /secrets/{name}
 *   GET    /health            -> {"service": "…"}
 *
 * Never log a value, never put one in an error message: callers get a masked
 * form and an explicit `reveal` boolean instead.
 */

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface SecretEntry {
  name: string
  type?: string
  store?: string
}

export interface VaultReach {
  ok: boolean
  detail: string
}

/** The parts of the environment this client reads. Kept explicit so the
 *  resolution order is testable instead of implied by `process.env`. */
export interface VaultEnv {
  AITHER_SECRETS_URL?: string
  AITHERSECRETS_URL?: string
  AITHER_ADMIN_KEY?: string
  AITHER_INTERNAL_SECRET?: string
  AITHER_MASTER_KEY?: string
}

const DEFAULT_URL = 'http://127.0.0.1:8001'

/**
 * Where the vault is.
 *
 * `AITHER_SECRETS_URL` / `AITHERSECRETS_URL` (both spellings are in the tree;
 * docker-compose.aitheros.yml sets the first, the awdk plugin honours both) win.
 * The default is the Genesis proxy on 127.0.0.1:8001, NOT the vault container
 * address: a session bearer is what the host has, and the proxy is the path that
 * accepts it. A container sets the env var and talks to 8111 directly.
 */
export function resolveSecretsUrl(env: VaultEnv = process.env as VaultEnv): string {
  const explicit = env.AITHER_SECRETS_URL || env.AITHERSECRETS_URL
  return (explicit || DEFAULT_URL).trim().replace(/\/+$/, '')
}

/**
 * Headers for a vault call: an operator key when this machine holds one, else
 * the logged-in session bearer the caller hands in. Neither present is an
 * honest failure at the call site, not an empty header set.
 */
export function vaultHeaders(
  env: VaultEnv = process.env as VaultEnv,
  bearer?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const key = env.AITHER_ADMIN_KEY || env.AITHER_INTERNAL_SECRET || env.AITHER_MASTER_KEY
  if (key) headers['X-API-Key'] = key
  else if (bearer) headers.Authorization = `Bearer ${bearer}`
  return headers
}

/** True when nothing could authenticate the call. */
export function missingCredential(
  env: VaultEnv = process.env as VaultEnv,
  bearer?: string | null,
): boolean {
  return !(env.AITHER_ADMIN_KEY || env.AITHER_INTERNAL_SECRET || env.AITHER_MASTER_KEY || bearer)
}

/** Names only. Accepts `{secrets: [...]}`, a bare array, string items, and
 *  `{name: …}` items — the proxy has answered in all four shapes. */
export function parseSecretsList(body: unknown): SecretEntry[] {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { secrets?: unknown }).secrets)
      ? ((body as { secrets: unknown[] }).secrets)
      : []
  const out: SecretEntry[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item) out.push({ name: item })
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      if (typeof o.name === 'string' && o.name) {
        out.push({
          name: o.name,
          type: typeof o.type === 'string' ? o.type : undefined,
          store: typeof o.store === 'string' ? o.store : undefined,
        })
      }
    }
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

/** A value, from either body shape. An absent or non-string value is null —
 *  never a stringified object that would be printed as if it were a secret. */
export function parseSecretValue(body: unknown): string | null {
  if (typeof body === 'string') return body
  if (body && typeof body === 'object') {
    const v = (body as Record<string, unknown>).value
    if (typeof v === 'string') return v
  }
  return null
}

/** What a person may see of a value without asking to reveal it. */
export function maskValue(value: string): string {
  if (!value) return ''
  if (value.length <= 6) return '*'.repeat(value.length)
  return `${value[0]}${'*'.repeat(Math.max(3, value.length - 4))}${value.slice(-3)}`
}

/** Error text safe to print: no value ever reaches it. */
function failure(status: number, what: string): string {
  return `${what}: HTTP ${status}`
}

export interface VaultClient {
  list(): Promise<SecretEntry[]>
  get(name: string): Promise<string | null>
  set(name: string, value: string, type?: string): Promise<boolean>
  remove(name: string): Promise<boolean>
  health(): Promise<VaultReach>
}

/**
 * Build a client. `fetchImpl` is injected (Node's global fetch by default) so a
 * test can drive every branch — including the 404 that means "no such secret",
 * which must be null and not an exception.
 */
export function createVaultClient(opts: {
  url?: string
  headers: Record<string, string>
  fetchImpl?: FetchLike
  timeoutMs?: number
}): VaultClient {
  const base = (opts.url || DEFAULT_URL).replace(/\/+$/, '')
  const doFetch: FetchLike = opts.fetchImpl || ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>)
  const timeout = opts.timeoutMs ?? 15_000

  async function call(path: string, init: Parameters<FetchLike>[1] = {}) {
    return doFetch(`${base}${path}`, {
      ...init,
      headers: { ...opts.headers, ...(init?.headers || {}) },
      signal: AbortSignal.timeout(timeout),
    })
  }

  return {
    async list() {
      const r = await call('/secrets')
      if (!r.ok) throw new Error(failure(r.status, 'listing secrets'))
      return parseSecretsList(await r.json().catch(() => ({})))
    },

    async get(name: string) {
      const r = await call(`/secrets/${encodeURIComponent(name)}`)
      if (r.status === 404) return null
      if (!r.ok) throw new Error(failure(r.status, `reading ${name}`))
      return parseSecretValue(await r.json().catch(() => null))
    },

    async set(name: string, value: string, type = 'generic') {
      const r = await call('/secrets', {
        method: 'POST',
        body: JSON.stringify({
          name,
          value,
          secret_type: type,
          access_level: 'internal',
          allowed_services: [],
          expires_in_days: null,
        }),
      })
      return r.ok
    },

    async remove(name: string) {
      const r = await call(`/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' })
      return r.ok || r.status === 404
    },

    async health() {
      try {
        const r = await doFetch(`${base}/health`, { signal: AbortSignal.timeout(8_000) })
        if (r.ok) {
          const body = (await r.json().catch(() => ({}))) as { service?: unknown }
          return { ok: true, detail: typeof body.service === 'string' ? body.service : 'ok' }
        }
        return { ok: false, detail: `HTTP ${r.status}` }
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
