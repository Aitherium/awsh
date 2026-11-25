/**
 * The daily-driver verbs, wired to the real planes:
 *   awsh agent [name]   tool-using Claude Code agent session via the harness daemon
 *   awsh status         fleet + Atlas board + waiting cards (answer inline)
 *   awsh agents [spawn <name> [prompt]]   the roster + live sessions; spawn one
 *   awsh cards [answer <n> <option> [note]]
 *   awsh board
 * Also the REPL's `/status`, `/agents`, `/cards`.
 *
 * Every verb LOCATES its plane first (gateway-locate.ts) -- the defaults that were
 * wrong on the fleet distro are exactly what this replaces.
 */

import { createInterface } from 'node:readline/promises';
import { fetchAtlasBoard, formatAtlasBoard, type AtlasBoard } from './atlas-board.js';
import { DEFAULT_AGENT, agentSessionBody, hostCwd, parseAgentArgs, runAgentRepl } from './agent-repl.js';
import { formatDaily, gatherDaily, parseCardAnswer, formatCards, type WaitingCard } from './daily-status.js';
import { measureFleet } from './fleet-health.js';
import { detectWsl, locateHarness, locateMcpGateway } from './gateway-locate.js';
import { McpHttpClient } from './mcp-client.js';

type Out = (line: string) => void;
const say: Out = (l) => console.log(l);

async function harnessApi() {
  const found = await locateHarness();
  const { api, daemonUrl } = await import('./harness-client.js');
  const where = found?.url || daemonUrl();
  // In WSL, a daemon reached on a non-loopback address is the Windows host's: it
  // needs Windows paths (agent-repl.ts hostCwd).
  const crossesToWindows = detectWsl() && !/\/\/(127\.0\.0\.1|localhost)[:/]/.test(where);
  return { api, found, where, crossesToWindows };
}

/** Unwrap an MCP `{content:[{text}]}` result into JSON (or the text). */
export function unwrapToolResult(result: any): unknown {
  const content = result?.content;
  const text = Array.isArray(content) && content[0] && typeof content[0].text === 'string' ? content[0].text : null;
  if (text === null) return result;
  if (result?.isError) throw new Error(text.slice(0, 200));
  try { return JSON.parse(text); } catch { return text; }
}

/** Call a gateway MCP tool on the LOCATED local gateway (or the configured one). */
export async function callGatewayTool(tool: string, params: Record<string, unknown>): Promise<unknown> {
  const { loadConfig } = await import('./config.js');
  const cfg = loadConfig();
  const gw = await locateMcpGateway({}, cfg.mcpUrl, cfg.authToken || '');
  if (!gw) throw new Error('MCP gateway not reachable at 127.0.0.1:8182 (set AITHER_MCP_URL)');
  const client = new McpHttpClient(gw.url, gw.token || null);
  return unwrapToolResult(await client.callTool(tool, params));
}

async function fetchCards(): Promise<WaitingCard[]> {
  const { api } = await harnessApi();
  const res = await api<{ decisions: WaitingCard[] }>('/decisions?status=open');
  return res?.decisions || [];
}

async function answerCard(args: string, out: Out): Promise<number> {
  let cards: WaitingCard[];
  try { cards = await fetchCards(); } catch (e: any) { out(`  cards: ${e?.message || e}`); return 1; }
  const parsed = parseCardAnswer(args, cards);
  if (typeof parsed === 'string') { out(`  ${parsed}`); return 2; }
  const { api } = await harnessApi();
  try {
    await api(`/decisions/${encodeURIComponent(parsed.id)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ choice: parsed.key, note: parsed.note, via: 'awsh' }),
    });
  } catch (e: any) { out(`  answer failed: ${e?.message || e}`); return 1; }
  out(`  answered ${parsed.id}: ${parsed.key}`);
  return 0;
}

export async function runStatus(out: Out = say, interactive = false): Promise<number> {
  const status = await gatherDaily({
    measureFleet: () => measureFleet(),
    fetchBoard: () => fetchAtlasBoard(callGatewayTool),
    fetchCards,
  });
  out('');
  for (const l of formatDaily(status)) out(`  ${l}`);
  out('');
  if (interactive && status.cards?.length && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const line = (await rl.question('  answer a card (<n> <option> [note], Enter to skip): ')).trim();
      if (line) return answerCard(line, out);
    } finally { rl.close(); }
  }
  return 0;
}

export async function runCards(args: string, out: Out = say): Promise<number> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  if (sub === 'answer') return answerCard(rest.join(' '), out);
  try {
    for (const l of formatCards(await fetchCards())) out(`  ${l}`);
    return 0;
  } catch (e: any) {
    for (const l of formatCards(null, e?.message)) out(`  ${l}`);
    return 1;
  }
}

export async function runBoard(out: Out = say): Promise<number> {
  const board: AtlasBoard = await fetchAtlasBoard(callGatewayTool);
  for (const l of formatAtlasBoard(board, { full: true })) out(`  ${l}`);
  return board.error ? 1 : 0;
}

/** `agents` lists the roster and live agent sessions; `agents spawn <name> [prompt]` starts one. */
export async function runAgents(args: string, out: Out = say): Promise<number> {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const { api, where, crossesToWindows } = await harnessApi();
  if ((words[0] || '').toLowerCase() === 'spawn') {
    const parsed = parseAgentArgs(['--new', ...words.slice(1)]);
    const a = { ...parsed, cwd: hostCwd(parsed.cwd, crossesToWindows) };
    try {
      const created = await api<any>('/sessions', { method: 'POST', body: JSON.stringify(agentSessionBody(a)) });
      if (a.prompt) {
        await api(`/sessions/${encodeURIComponent(created.id)}/wait?until=ready,idle&timeout=60`).catch(() => null);
        await api(`/sessions/${encodeURIComponent(created.id)}/submit`, {
          method: 'POST', body: JSON.stringify({ text: a.prompt, submit: true }),
        });
      }
      out(`  spawned ${a.agent} · ${created.id}${a.prompt ? ' · working on your prompt' : ''}`);
      out(`  talk to it: awsh agent ${a.agent} --resume ${created.id}`);
      return 0;
    } catch (e: any) { out(`  spawn failed (${where}): ${e?.message || e}`); return 1; }
  }
  try {
    const [roster, sessions] = await Promise.all([
      api<{ agents: any[] }>('/agents'),
      api<{ sessions: any[] }>('/sessions').catch(() => ({ sessions: [] as any[] })),
    ]);
    const live = (sessions.sessions || []).filter((s) => String(s.title || '').startsWith('awsh · '));
    const ids = (roster.agents || []).map((x) => String(x.id || x.name)).filter(Boolean);
    // These are the agents this harness can START: a generated subset of the identity
    // registry (aither, aither's children, identities with dispatch_keywords). It is
    // not the full roster and says nothing about who is working -- that is Genesis
    // GET /atlas/agent-status (config/identities joined with Atlas presence).
    out(`  startable here (${ids.length}): ${ids.join(', ')}`);
    out('  subset of config/identities this harness can start; liveness not measured here.');
    out('  all defined agents + who is working: get_agent_fleet_status (GET /atlas/agent-status)');
    if (live.length) {
      out(`  live agent sessions (${live.length}):`);
      for (const s of live.slice(0, 5)) out(`    ${s.id}  ${String(s.title).slice(7)}  ${s.state}`);
      if (live.length > 5) out(`    +${live.length - 5} more`);
    }
    out(`  start: awsh agent <name>   ·   background: awsh agents spawn <name> "<prompt>"   (default ${DEFAULT_AGENT})`);
    return 0;
  } catch (e: any) {
    out(`  agents: ${e?.message || e} -- harness daemon expected at ${where} (adk harness serve)`);
    return 1;
  }
}

/** `awsh agent …` -- the interactive REPL on a real terminal. */
export async function runAgent(argv: string[]): Promise<number> {
  const { api, crossesToWindows } = await harnessApi();
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  let closed = false;
  rl.on('close', () => { closed = true; });
  try {
    return await runAgentRepl(argv, {
      api,
      crossesToWindows,
      write: (s) => process.stdout.write(s),
      readLine: async (prompt) => {
        if (closed) return null;
        try { return await rl.question(prompt); } catch { return null; }
      },
      local: {
        status: async () => { await runStatus(); },
        cards: async (rest) => { await runCards(rest); },
        board: async () => { await runBoard(); },
        agents: async (rest) => { await runAgents(rest); },
      },
    });
  } finally {
    rl.close();
  }
}
