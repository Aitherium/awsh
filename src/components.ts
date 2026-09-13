/**
 * components.ts — what is INSTALLED on this device, as packs the shell can use.
 *
 * THE POINT. `awsh gobbonet` launches a brain pack. A COMPONENT is the other
 * thing a machine carries: awgym, awrun's queue, awdesk, an ollama — things
 * with a port, a UI, a few commands. Before 2026-09-06 awsh could not see them:
 * packs.ts reads brain_pack.yaml trees and nothing else, so a brick a user had
 * just `pip install`ed was invisible from the shell that is supposed to be its
 * cockpit.
 *
 * WHY THE DAEMON AND NOT A SECOND LOADER. awdk's addon_manager is the ONE
 * component loader (entry points, ~/.aither/components, the bundled set) and its
 * daemon serves the merged answer at GET /components. Re-reading those YAML
 * files here would be a second copy of the rules, and two copies of one rule
 * drift — that is not a risk, it is what happened to the browser-inference
 * worker while a comment asked people to keep the copies in step. packs.ts's
 * tiny key:value parser cannot read `surfaces:` anyway. So: ask the daemon;
 * when it is not running, SAY so rather than listing nothing.
 *
 * WHAT MAY OPEN. A component's UI is offered only at a plain-http loopback URL
 * (`http://127.0.0.1:<port>`): never a hostname, never https behind the internal
 * CA no browser trusts, never a remote node's loopback. A capability (no port of
 * its own) opens on the host that serves it. Same rules as the Living Desktop's
 * local-components lane — one contract, two consumers.
 */

import type { Pack, PackCommand } from './packs.js';

/** The awdk daemon (adk/daemon_endpoint.py DEFAULT_PORT). 127.0.0.1, never localhost. */
export const DAEMON_BASE = process.env.AITHER_ADK_URL || 'http://127.0.0.1:9001';

export interface ComponentSurfaces {
  ui?: { path?: string; title?: string; icon?: string; frame?: boolean };
  mcp?: { path?: string };
  commands?: Array<{ name?: string; description?: string; run?: string; url?: string }>;
}

export interface LocalComponent {
  id: string;
  brick: string;
  name: string;
  type: string;
  hosted_by?: string;
  status: string;
  endpoint: string;
  health_ok: boolean;
  surfaces: ComponentSurfaces;
}

export type ComponentsResult =
  /** nothing answered at the base */
  | { state: 'offline'; base: string; components: [] }
  /** something answered, but not the component API — an awdk older than 2026-09-06
   *  serves its UI pack's index page at every unknown path, which is HTTP 200 and
   *  not JSON. Reporting that as "offline" would send the user to start a daemon
   *  that is already running. */
  | { state: 'unsupported'; base: string; components: [] }
  | { state: 'online'; base: string; port: number; components: LocalComponent[] };

const LOOPBACK_HTTP = /^http:\/\/127\.0\.0\.1:\d{2,5}(\/|$)/;

/** Only a plain-http loopback URL may be opened. */
export function isOpenableUrl(url: string | undefined | null): url is string {
  return typeof url === 'string' && LOOPBACK_HTTP.test(url);
}

/** The UI URL for a component, or null when it has none or it is not loopback. */
export function componentUrl(c: LocalComponent, hostBase: string): string | null {
  const ui = c.surfaces?.ui;
  if (!ui) return null;
  const base = c.type === 'capability' ? hostBase : c.endpoint;
  if (!isOpenableUrl(base)) return null;
  const path = ui.path && ui.path.startsWith('/') ? ui.path : '/' + (ui.path ?? '');
  return base.replace(/\/$/, '') + path;
}

function normalise(raw: unknown): LocalComponent[] {
  if (!Array.isArray(raw)) return [];
  const out: LocalComponent[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    if (!id) continue;
    out.push({
      id,
      brick: typeof o.brick === 'string' ? o.brick : '',
      name: typeof o.name === 'string' && o.name ? o.name : id,
      type: typeof o.type === 'string' ? o.type : 'docker',
      hosted_by: typeof o.hosted_by === 'string' ? o.hosted_by : undefined,
      status: typeof o.status === 'string' ? o.status : 'available',
      endpoint: typeof o.endpoint === 'string' ? o.endpoint : '',
      health_ok: o.health_ok === true,
      surfaces: (o.surfaces && typeof o.surfaces === 'object' ? o.surfaces : {}) as ComponentSurfaces,
    });
  }
  return out;
}

/** Ask the daemon. Never throws; `offline` names the base it tried. */
export async function fetchComponents(
  base: string = DAEMON_BASE,
  fetchFn: typeof fetch = fetch,
): Promise<ComponentsResult> {
  try {
    const res = await fetchFn(`${base}/components`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) {
      // A daemon that answers /health but 404s /components is RUNNING and old.
      // "Not answering" would send the user to start what is already started.
      try {
        const h = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(1500) });
        if (h.ok) return { state: 'unsupported', base, components: [] };
      } catch {
        // fall through: nothing answers at all
      }
      return { state: 'offline', base, components: [] };
    }
    let body: { port?: number; components?: unknown };
    try {
      body = (await res.json()) as { port?: number; components?: unknown };
    } catch {
      return { state: 'unsupported', base, components: [] };
    }
    if (!Array.isArray(body?.components)) return { state: 'unsupported', base, components: [] };
    const port = Number(body.port) || Number(new URL(base).port) || 9001;
    return { state: 'online', base, port, components: normalise(body.components) };
  } catch {
    return { state: 'offline', base, components: [] };
  }
}

/**
 * A component as a Pack the rest of awsh already understands: its `commands`
 * become pack commands, its UI becomes `appUrl`. No `systemPrompt` on purpose —
 * a component does not change the shell's brain, so isUsable() stays false and
 * `awsh <component>` (no --app) does not silently enter a session wearing it.
 * No `appScript` either: the daemon starts components (`adk addon enable`),
 * the shell only ATTACHES to what already answers.
 */
export function componentToPack(c: LocalComponent, r: ComponentsResult): Pack | null {
  const hostBase = `http://127.0.0.1:${r.state === 'online' ? r.port : 9001}`;
  const url = componentUrl(c, hostBase);
  const commands: PackCommand[] = [];
  for (const cmd of c.surfaces?.commands ?? []) {
    // The same refusal packs.ts makes: a command with no action is not a menu entry.
    if (!cmd || typeof cmd.name !== 'string' || !cmd.name || !(cmd.run || cmd.url)) continue;
    commands.push({ name: cmd.name, description: cmd.description, run: cmd.run, url: cmd.url });
  }
  if (!url && commands.length === 0) return null;   // nothing the shell can do with it
  return {
    name: c.id,
    title: c.surfaces?.ui?.title || c.name,
    commands: commands.length ? commands : undefined,
    appUrl: url ?? undefined,
    manifest: `${r.base}/components#${c.id}`,
    root: `daemon:${r.base}`,
  };
}

/** Every component the daemon knows that the shell can list, open or command. */
export async function discoverComponentPacks(
  base: string = DAEMON_BASE,
  fetchFn: typeof fetch = fetch,
): Promise<{ result: ComponentsResult; packs: Pack[] }> {
  const result = await fetchComponents(base, fetchFn);
  const packs: Pack[] = [];
  for (const c of result.components) {
    const p = componentToPack(c, result);
    if (p) packs.push(p);
  }
  return { result, packs };
}

/**
 * Open a component's UI in the default browser. Loopback-only by construction
 * (isOpenableUrl), detached, no console window — spawning a console child from
 * a shell is how a window steals focus (gate 1t / DC007).
 */
export async function openUrl(url: string): Promise<boolean> {
  if (!isOpenableUrl(url)) return false;
  const { spawn } = await import('node:child_process');
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url],
              { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Case-insensitive lookup by component id. */
export async function findComponentPack(
  name: string,
  base: string = DAEMON_BASE,
  fetchFn: typeof fetch = fetch,
): Promise<Pack | undefined> {
  const want = name.toLowerCase();
  const { packs } = await discoverComponentPacks(base, fetchFn);
  return packs.find(p => p.name.toLowerCase() === want);
}
