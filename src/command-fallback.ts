/**
 * command-fallback.ts — make catalog-only commands executable, in BOTH REPLs.
 *
 * A slash command that has no built-in handler in COMMANDS can still be real:
 *   - an MCP tool the registry discovered (/shell/commands/mcp, remote MCP), or
 *   - a Genesis route tagged @shell_command, which /shell/commands returns with
 *     `genesis_endpoint` (e.g. /shell/ctl/temp, /ctl/verbs).
 * Before this module those entries showed in the picker and then printed
 * "Unknown command" — the registry stored `genesisEndpoint` and nothing read it,
 * and the TUI had no fallback at all. One resolver + one runner, shared by
 * repl.ts and tui/repl-tui.ts, so the two can no longer drift.
 */

import type { GenesisClient } from './client.js';
import type { ShellConfig } from './config.js';
import type { CommandRegistry } from './command-registry.js';
import { invokeMcpTool } from './commands.js';

export type CommandFallback =
  | { kind: 'mcp'; name: string; tool: string }
  | { kind: 'genesis'; name: string; endpoint: string };

/** Parse slash-command args as JSON params or `key=value` pairs (bare words → `input`). */
export function parseToolParams(args: string): Record<string, any> {
  const params: Record<string, any> = {};
  const trimmed = (args || '').trim();
  if (!trimmed) return params;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* not JSON — fall through to key=value */ }
  }
  for (const pair of trimmed.split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq > 0) params[pair.slice(0, eq)] = pair.slice(eq + 1);
    else params['input'] = params['input'] ? `${params['input']} ${pair}` : pair;
  }
  return params;
}

/** How a command with no built-in handler can still run, or null when it cannot. */
export function resolveFallback(registry: CommandRegistry, name: string): CommandFallback | null {
  if (!name) return null;
  const tool = registry.getMcpTool(name);
  if (tool) return { kind: 'mcp', name, tool: tool.name };
  const entry = registry.resolve(name);
  const endpoint = entry?.genesisEndpoint;
  if (!entry || !endpoint) return null;
  // Genesis lists MCP tools as `mcp:<tool>` with endpoint /tools/call.
  if (endpoint === '/tools/call') {
    return { kind: 'mcp', name, tool: entry.name.replace(/^mcp:/, '') };
  }
  return { kind: 'genesis', name: entry.name, endpoint };
}

export interface FallbackResult {
  ok: boolean;
  /** Short label for the output header, e.g. "MCP: foo" or "Genesis: /shell/ctl/temp". */
  label: string;
  output?: any;
  error?: string;
}

/** Execute a resolved fallback. Never throws; errors come back in `error`. */
export async function runFallback(
  client: GenesisClient,
  fb: CommandFallback,
  args: string,
  config: Pick<ShellConfig, 'sessionId'>,
): Promise<FallbackResult> {
  const params = parseToolParams(args);
  if (fb.kind === 'mcp') {
    const label = `MCP: ${fb.tool}`;
    try {
      const output = await invokeMcpTool(client, fb.tool, params);
      if (output && typeof output === 'object' && 'error' in output && (output as any).error) {
        return { ok: false, label, error: String((output as any).error) };
      }
      return { ok: true, label, output };
    } catch (err: any) {
      return { ok: false, label, error: err?.message || String(err) };
    }
  }

  const label = `Genesis: ${fb.endpoint}`;
  if (/[{}]/.test(fb.endpoint)) {
    return { ok: false, label, error: `/${fb.name} needs path parameters (${fb.endpoint}); not callable from the shell` };
  }
  // Genesis shell-callable routes take the raw text as `value` and the chat
  // session as `session_id` (the /shell/ctl/* contract); key=value pairs ride along.
  const body: Record<string, any> = { session_id: config.sessionId, value: (args || '').trim(), ...params };
  try {
    let res = await client.postDetailed(fb.endpoint, body);
    if (res?.error && res?.status === 405) res = await client.getDetailed(fb.endpoint);
    if (res?.error) {
      const status = res.status ? ` (HTTP ${res.status})` : '';
      return { ok: false, label, error: `${res.error}${status}` };
    }
    if (res && typeof res === 'object' && res.ok === false) {
      return { ok: false, label, error: String(res.message || 'refused'), output: res };
    }
    return { ok: true, label, output: res };
  } catch (err: any) {
    return { ok: false, label, error: err?.message || String(err) };
  }
}

/** Render a fallback's output as text: a `message` field wins, else JSON. */
export function formatFallbackOutput(output: any): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && typeof output.message === 'string' && output.message) return output.message;
  return JSON.stringify(output, null, 2);
}
