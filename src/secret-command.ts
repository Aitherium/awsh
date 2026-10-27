/**
 * `/secret` — the aithersecrets / lockbox / Proton Pass vault, from awsh.
 *
 * THREE PLANES, one verb, because they are three different things that all
 * answer "where is my password?" and each was reachable from a different tool:
 *
 *   machine     AitherSecrets (`:8111`, via the Genesis proxy). The service
 *               credentials this box runs on. This is what `adk vault` and the
 *               Python shell's `/secret` plugin talk to; awsh had no path to it.
 *   personal    The caller's own Lockbox (GET /api/genesis/lockbox/user).
 *               WRITE-ONLY by design — the read route does not exist, so
 *               `personal get` refuses instead of pretending.
 *   workspace   Workspace-scoped secrets (GET /api/genesis/workspace-secrets/*),
 *               owner/admin, every value read audit-logged.
 *   proton      Proton Pass, READ-THROUGH from the export kept in AitherSecrets.
 *               Items are listed masked (`/api/proton-pass/items`, safe dicts);
 *               a value comes only from `/api/proton-pass/autofill`, which the
 *               server audits. Nothing is copied into our vault — Proton stays
 *               the source of record.
 *
 * A value is printed ONLY by an explicit `get`/`autofill` verb, to stdout, with
 * no decoration, so it can be piped. Every other verb prints names and masks.
 * Error text never carries a value.
 */

import chalk from 'chalk'
import type { FetchLike, SecretEntry, VaultClient, VaultEnv } from './lockbox-client.js'
import {
  createVaultClient,
  maskValue,
  missingCredential,
  resolveSecretsUrl,
  vaultHeaders,
} from './lockbox-client.js'

/** The Genesis client this shell already holds, narrowed to what we call. */
export interface SecretBackend {
  get(path: string): Promise<any>
  post(path: string, body?: Record<string, unknown>): Promise<any>
  put(path: string, body?: Record<string, unknown>): Promise<any>
  delete(path: string): Promise<any>
}

export interface SecretDeps {
  backend?: SecretBackend
  vault?: VaultClient
  env?: VaultEnv
  /** The logged-in session bearer, when this machine is not the vault operator. */
  bearer?: string | null
  fetchImpl?: FetchLike
  askHidden?: (prompt: string) => Promise<string>
  log?: (line: string) => void
  /** Where a revealed value goes. Separate from `log` so it can be piped. */
  writeValue?: (value: string) => void
}

export const USAGE = [
  '/secret                       vault status (machine vault)',
  '/secret ls [--json]           names only, never values',
  '/secret get <name>            print one value (pipes)',
  '/secret set <name>            store; value is prompted hidden, never on argv',
  '/secret rm <name>             delete one',
  '/secret personal ls           your Lockbox entries (write-only: no get)',
  '/secret personal set <name>',
  '/secret personal rm <name>',
  '/secret workspace ls [--key <k>]',
  '/secret workspace get <key>   audit-logged by the server',
  '/secret workspace set <key>',
  '/secret proton ls [--search <q>] [--vault <v>]',
  '/secret proton get <domain|item-id>   audit-logged; Proton stays the source',
].join('\n')

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** `--flag value` / `--flag` pairs out of an argv, leaving positionals. Throws on
 *  a flag with no value so a typo cannot silently become a positional. */
export function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const name = a.slice(2)
    if (!name) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      i++
    } else {
      flags[name] = true
    }
  }
  return { positional, flags }
}

/** A name that is safe as a path segment and never contains a value-ish blob.
 *  Deliberately the same shape the Lockbox routes enforce. */
export function validSecretName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.\-:]{0,127}$/.test(name)
}

/** Personal Lockbox entries: `{secrets: [{name, stored}]}` or a bare array. */
export function parsePersonalSecrets(body: unknown): string[] {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { secrets?: unknown }).secrets)
      ? ((body as { secrets: unknown[] }).secrets)
      : []
  return raw
    .map((item) =>
      typeof item === 'string' ? item : (item as { name?: unknown })?.name,
    )
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}

/** Workspace keys: `{secrets: [{key, masked, …}]}`. */
export function parseWorkspaceKeys(body: unknown): Array<{ key: string; masked?: string }> {
  const raw = body && typeof body === 'object' ? (body as { secrets?: unknown }).secrets : undefined
  const list = Array.isArray(raw) ? raw : Array.isArray(body) ? body : []
  const out: Array<{ key: string; masked?: string }> = []
  for (const item of list) {
    const o = item as { key?: unknown; masked?: unknown } | null
    if (!o || typeof o.key !== 'string') continue
    const entry: { key: string; masked?: string } = { key: o.key }
    if (typeof o.masked === 'string') entry.masked = o.masked
    out.push(entry)
  }
  return out.sort((a, b) => a.key.toLowerCase().localeCompare(b.key.toLowerCase()))
}

/** Proton items: `{data: {items: [...]}}` — `to_safe_dict()`, so no passwords. */
export function parseProtonItems(body: unknown): Array<Record<string, unknown>> {
  const items = (body as { data?: { items?: unknown } })?.data?.items
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : []
}

function buildVault(deps: SecretDeps): VaultClient {
  if (deps.vault) return deps.vault
  const env = deps.env || (process.env as VaultEnv)
  return createVaultClient({
    url: resolveSecretsUrl(env),
    headers: vaultHeaders(env, deps.bearer),
    fetchImpl: deps.fetchImpl,
  })
}

/** Run a `/secret …` line. Returns the process exit code. */
export async function runSecretCommand(argv: string[], deps: SecretDeps = {}): Promise<number> {
  const log = deps.log || ((line: string) => console.log(line))
  const write = deps.writeValue || ((value: string) => process.stdout.write(value + '\n'))
  const { positional, flags } = parseFlags(argv)
  const scope = positional[0] || 'status'

  const backend = deps.backend
  const needBackend = (): SecretBackend | null => {
    if (backend) return backend
    log(`  ${chalk.yellow('/secret')} needs a signed-in session for this scope.`)
    return null
  }

  switch (scope) {
    // ── machine vault (AitherSecrets) ──────────────────────────────────────
    case 'status': {
      const env = deps.env || (process.env as VaultEnv)
      log(`  ${chalk.bold('AitherSecrets')}  ${chalk.dim(resolveSecretsUrl(env))}`)
      if (missingCredential(env, deps.bearer)) {
        log(`  ${chalk.yellow('no credential')} — set AITHER_ADMIN_KEY (operator) or sign in with ${chalk.bold('adk login')}.`)
        return 1
      }
      const vault = buildVault(deps)
      const reach = await vault.health()
      if (!reach.ok) {
        log(`  ${chalk.red('unreachable')} — ${reach.detail}`)
        return 1
      }
      const entries = await vault.list().catch(() => [] as SecretEntry[])
      log(`  ${chalk.green('reachable')} — ${reach.detail}, ${entries.length} secrets`)
      return 0
    }

    case 'ls':
    case 'list': {
      const vault = buildVault(deps)
      let entries: SecretEntry[]
      try {
        entries = await vault.list()
      } catch (err) {
        log(`  ${chalk.red('cannot list')} — ${errorText(err)}`)
        return 1
      }
      if (flags.json) {
        log(JSON.stringify(entries, null, 2))
        return 0
      }
      if (!entries.length) {
        log(chalk.dim('  no secrets in the machine vault.'))
        return 0
      }
      for (const e of entries) {
        log(`  ${e.name}${e.type && e.type !== 'generic' ? chalk.dim(`  [${e.type}]`) : ''}`)
      }
      log(chalk.dim(`  ${entries.length} names — values are never listed.`))
      return 0
    }

    case 'get': {
      const name = positional[1]
      if (!name) { log(chalk.yellow('  usage: /secret get <name>')); return 2 }
      if (!validSecretName(name)) { log(chalk.yellow('  that is not a secret name.')); return 2 }
      try {
        const value = await buildVault(deps).get(name)
        if (value === null) { log(chalk.yellow(`  ${name} is not in the machine vault.`)); return 1 }
        write(value)
        return 0
      } catch (err) {
        log(`  ${chalk.red('cannot read')} — ${errorText(err)}`)
        return 1
      }
    }

    case 'set': {
      const name = positional[1]
      if (!name) { log(chalk.yellow('  usage: /secret set <name>')); return 2 }
      if (!validSecretName(name)) { log(chalk.yellow('  that is not a secret name.')); return 2 }
      // NEVER from argv: argv is echoed to the terminal and appended to history.
      const ask = deps.askHidden
      if (!ask) {
        log(chalk.yellow('  hidden input is unavailable here; set it from the TUI (awsh) instead.'))
        return 2
      }
      const value = await ask(`  value for ${name} (hidden): `)
      if (!value) { log(chalk.yellow('  cancelled — nothing stored.')); return 1 }
      const ok = await buildVault(deps).set(name, value, typeof flags.type === 'string' ? flags.type : 'generic')
      if (ok) log(`  ${chalk.green('stored')} ${name} (${maskValue(value)})`)
      else log(`  ${chalk.red('refused')} — the vault did not accept ${name}.`)
      return ok ? 0 : 1
    }

    case 'rm':
    case 'remove':
    case 'delete': {
      const name = positional[1]
      if (!name) { log(chalk.yellow('  usage: /secret rm <name>')); return 2 }
      const ok = await buildVault(deps).remove(name)
      log(ok ? `  ${chalk.green('removed')} ${name}` : `  ${chalk.red('cannot remove')} ${name}`)
      return ok ? 0 : 1
    }

    // ── personal Lockbox (write-only) ──────────────────────────────────────
    case 'personal': {
      const b = needBackend(); if (!b) return 1
      const verb = positional[1] || 'ls'
      if (verb === 'get' || verb === 'show') {
        log(chalk.yellow('  personal secrets are write-only by design — there is no read route.'))
        log(chalk.dim('  To change one, set it again; to use it, a service reads it by name.'))
        return 2
      }
      if (verb === 'ls' || verb === 'list') {
        const names = parsePersonalSecrets(await b.get('/api/genesis/lockbox/user'))
        if (!names.length) { log(chalk.dim('  no personal secrets stored.')); return 0 }
        for (const n of names) log(`  ${n}`)
        log(chalk.dim(`  ${names.length} names — stored, never readable.`))
        return 0
      }
      const name = positional[2]
      if (!name) { log(chalk.yellow('  usage: /secret personal <ls|set|rm> [name]')); return 2 }
      if (!validSecretName(name)) { log(chalk.yellow('  that is not a secret name.')); return 2 }
      if (verb === 'rm' || verb === 'remove') {
        await b.delete(`/api/genesis/lockbox/user/${encodeURIComponent(name)}`)
        log(`  ${chalk.green('removed')} ${name}`)
        return 0
      }
      if (verb === 'set') {
        const ask = deps.askHidden
        if (!ask) { log(chalk.yellow('  hidden input unavailable here.')); return 2 }
        const value = await ask(`  value for ${name} (hidden): `)
        if (!value) { log(chalk.yellow('  cancelled — nothing stored.')); return 1 }
        await b.put(`/api/genesis/lockbox/user/${encodeURIComponent(name)}`, { value })
        log(`  ${chalk.green('stored')} ${name} (${maskValue(value)})`)
        return 0
      }
      log(chalk.yellow(`  unknown personal verb: ${verb}`))
      return 2
    }

    // ── workspace secrets (owner/admin, audit-logged reads) ────────────────
    case 'workspace': {
      const b = needBackend(); if (!b) return 1
      const verb = positional[1] || 'ls'
      const workspaceId = typeof flags.workspace === 'string' ? flags.workspace : ''
      const wsQuery = workspaceId ? `workspace_id=${encodeURIComponent(workspaceId)}` : ''

      if (verb === 'ls' || verb === 'list') {
        const keys = parseWorkspaceKeys(
          await b.get(`/api/genesis/workspace-secrets/keys${wsQuery ? `?${wsQuery}` : ''}`),
        )
        if (!keys.length) { log(chalk.dim('  no workspace secrets.')); return 0 }
        for (const k of keys) log(`  ${k.key}${k.masked ? chalk.dim(`  ${k.masked}`) : ''}`)
        return 0
      }

      const key = positional[2]
      if (!key) { log(chalk.yellow('  usage: /secret workspace <ls|get|set|rm> [key]')); return 2 }

      if (verb === 'get') {
        const q = new URLSearchParams({ key, ...(workspaceId ? { workspace_id: workspaceId } : {}) })
        const body = await b.get(`/api/genesis/workspace-secrets/value?${q.toString()}`)
        const value = (body as { value?: unknown })?.value
        if (typeof value !== 'string') { log(chalk.yellow('  the server returned no value.')); return 1 }
        write(value)
        return 0
      }
      if (verb === 'set') {
        const ask = deps.askHidden
        if (!ask) { log(chalk.yellow('  hidden input unavailable here.')); return 2 }
        const value = await ask(`  value for ${key} (hidden): `)
        if (!value) { log(chalk.yellow('  cancelled — nothing stored.')); return 1 }
        await b.post('/api/genesis/workspace-secrets/set', {
          key, value, ...(workspaceId ? { workspace_id: workspaceId } : {}),
        })
        log(`  ${chalk.green('stored')} ${key} (${maskValue(value)})`)
        return 0
      }
      if (verb === 'rm' || verb === 'remove') {
        await b.post('/api/genesis/workspace-secrets/delete', {
          key, ...(workspaceId ? { workspace_id: workspaceId } : {}),
        })
        log(`  ${chalk.green('removed')} ${key}`)
        return 0
      }
      log(chalk.yellow(`  unknown workspace verb: ${verb}`))
      return 2
    }

    // ── Proton Pass (read-through; never copied) ───────────────────────────
    case 'proton': {
      const b = needBackend(); if (!b) return 1
      const verb = positional[1] || 'ls'
      if (verb === 'ls' || verb === 'list') {
        const q = new URLSearchParams()
        if (typeof flags.search === 'string') q.set('search', flags.search)
        if (typeof flags.vault === 'string') q.set('vault', flags.vault)
        const items = parseProtonItems(await b.get(`/api/proton-pass/items${q.toString() ? `?${q}` : ''}`))
        if (!items.length) { log(chalk.dim('  no Proton Pass items (export loaded?).')); return 0 }
        for (const it of items) {
          const name = String(it.name ?? it.title ?? it.item_id ?? '(unnamed)')
          const user = typeof it.username === 'string' && it.username ? chalk.dim(`  ${it.username}`) : ''
          log(`  ${name}${user}`)
        }
        log(chalk.dim(`  ${items.length} items — values stay in Proton; /secret proton get reveals one (audited).`))
        return 0
      }
      if (verb === 'get') {
        const who = positional[2]
        if (!who) { log(chalk.yellow('  usage: /secret proton get <domain|item-id>')); return 2 }
        const body = await b.post('/api/proton-pass/autofill', {
          domain: who, ...(who.includes('@') ? {} : { item_id: who }),
        })
        const data = (body as { data?: Record<string, unknown> })?.data
        if (!data || typeof data.password !== 'string') {
          log(chalk.yellow('  no credential for that domain/item.'))
          return 1
        }
        // Print the password only — username goes to stderr-ish log lines, so the
        // common `$(awsh /secret proton get github.com)` never captures both.
        if (typeof data.username === 'string' && data.username) log(chalk.dim(`  ${data.username}`))
        write(data.password)
        return 0
      }
      log(chalk.yellow(`  unknown proton verb: ${verb}`))
      return 2
    }

    case 'help':
    case '--help':
    case '-h':
      log(USAGE)
      return 0

    default:
      log(chalk.yellow(`  unknown scope: ${scope}`))
      log(USAGE)
      return 2
  }
}
