/**
 * Built-in slash commands for AitherShell CLI.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import chalk from 'chalk';
import ora from './spinner.js';
import type { GenesisClient } from './client.js';
import type { ShellConfig } from './config.js';
import { getActiveConfig, DEFAULT_AGENT } from './config.js';
import { getRemoteMcpClient } from './mcp-client.js';
import { isAdultContentVisible, invalidateAdultGate, ADULT_TIERS } from './adult-gate.js';
import { formatTable, getSessionArtifacts, clearSessionArtifacts, resolveImagePath, osc8Link, addSessionArtifact, type SessionArtifact } from './renderer.js';
import {
  loadSession, saveSession, listSessions, deleteSession,
  transcriptMarkdown, sessionTokens,
} from './session-store.js';
import {
  loginWithPassword,
  verify2FA,
  register,
  logoutSession,
  validateToken,
  buildProfile,
  setProfile,
  clearProfile,
  getActiveProfile,
  getActiveUser,
  getActiveToken,
  requestEmailOTP,
  verifyEmailOTP,
  requestDeviceCode,
  pollDeviceToken,
} from './auth.js';
import { runWizard } from './install-wizard.js';
import {
  personaHealthy,
  getPersonaStatus,
  setPersonaCharacter,
  personaWindowAction,
  playPersonaAnimation,
  listPersonaAnimations,
  setPersonaAgent,
  listPersonaAgentAvatars,
  exportPersonaToShell,
} from './persona-bridge.js';
import {
  addProject, listProjects, switchProject, removeProject, getActiveWorkspace, pickDirectory,
} from './workspace.js';

export type CommandHandler = (
  client: GenesisClient,
  args: string,
  config: ShellConfig,
) => Promise<void>;

interface Command {
  description: string;
  usage?: string;
  handler: CommandHandler;
}

type OnboardMode = 'auto' | 'code' | 'knowledge' | 'repo';

interface LocalTargetProfile {
  exists: boolean;
  isDirectory: boolean;
  codeFiles: number;
  docFiles: number;
  hasGit: boolean;
  scannedFiles: number;
}

const ONBOARD_CODE_EXTENSIONS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.go', '.rs', '.cs',
  '.cpp', '.cc', '.c', '.h', '.hpp', '.rb', '.php', '.swift', '.kt', '.kts', '.scala',
  '.sh', '.ps1', '.psm1', '.sql', '.html', '.css', '.scss', '.json', '.yaml', '.yml',
]);

const ONBOARD_DOC_EXTENSIONS = new Set([
  '.md', '.txt', '.rst', '.pdf', '.docx', '.pptx', '.csv', '.tsv', '.html', '.htm',
  '.json', '.yaml', '.yml',
]);

const ONBOARD_IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.idea', '.vscode', 'tmp', 'temp', 'out', 'target', 'bin', 'obj',
]);

function parseQuotedArgs(input: string): string[] {
  const matches = input.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) || [];
  return matches.map(token => {
    const trimmed = token.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  });
}

function isRepoUrl(value: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(value.trim());
}

function inferTargetName(target: string, provided?: string): string {
  if (provided && provided.trim()) return provided.trim();
  const normalized = target.replace(/[\\/]+$/, '');
  return basename(normalized) || 'project';
}

function scanLocalTarget(rootPath: string, maxFiles = 4000): LocalTargetProfile {
  if (!existsSync(rootPath)) {
    return { exists: false, isDirectory: false, codeFiles: 0, docFiles: 0, hasGit: false, scannedFiles: 0 };
  }

  let codeFiles = 0;
  let docFiles = 0;
  let scannedFiles = 0;
  let isDirectory = false;

  try {
    const initialEntries = readdirSync(rootPath, { withFileTypes: true });
    isDirectory = true;
    const hasGit = initialEntries.some(entry => entry.isDirectory() && entry.name === '.git');
    const queue = [rootPath];

    while (queue.length && scannedFiles < maxFiles) {
      const current = queue.pop()!;
      let entries: any[];
      try {
        entries = readdirSync(current, { withFileTypes: true }) as any[];
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (scannedFiles >= maxFiles) break;
        const name = entry.name as string;
        if (entry.isDirectory()) {
          if (!ONBOARD_IGNORED_DIRS.has(name)) {
            queue.push(join(current, name));
          }
          continue;
        }

        scannedFiles += 1;
        const dot = name.lastIndexOf('.');
        const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
        if (ONBOARD_CODE_EXTENSIONS.has(ext)) codeFiles += 1;
        if (ONBOARD_DOC_EXTENSIONS.has(ext)) docFiles += 1;
      }
    }

    return { exists: true, isDirectory, codeFiles, docFiles, hasGit, scannedFiles };
  } catch {
    return { exists: true, isDirectory: false, codeFiles: 0, docFiles: 0, hasGit: false, scannedFiles: 0 };
  }
}

function findRepresentativeCodeFile(rootPath: string, maxFiles = 2000): string | null {
  if (!existsSync(rootPath)) return null;

  const preferred = ['README.md', 'readme.md', 'package.json', 'pyproject.toml'];
  for (const name of preferred) {
    const candidate = join(rootPath, name);
    if (existsSync(candidate)) return candidate;
  }

  const queue = [rootPath];
  let scannedFiles = 0;

  while (queue.length && scannedFiles < maxFiles) {
    const current = queue.shift()!;
    let entries: any[];
    try {
      entries = readdirSync(current, { withFileTypes: true }) as any[];
    } catch {
      continue;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return String(a.name).localeCompare(String(b.name));
    });

    for (const entry of entries) {
      const name = String(entry.name);
      const fullPath = join(current, name);
      if (entry.isDirectory()) {
        if (!ONBOARD_IGNORED_DIRS.has(name)) queue.push(fullPath);
        continue;
      }

      scannedFiles += 1;
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      if (ONBOARD_CODE_EXTENSIONS.has(ext) || ONBOARD_DOC_EXTENSIONS.has(ext)) {
        return fullPath;
      }
    }
  }

  return null;
}

function colorRiskLevel(level: string): string {
  const normalized = (level || '').toLowerCase();
  if (normalized === 'high') return chalk.red(level || 'high');
  if (normalized === 'medium') return chalk.yellow(level || 'medium');
  return chalk.green(level || 'low');
}

async function printCodebaseIntelSummary(
  client: GenesisClient,
  repoRoot: string,
  displayName: string,
): Promise<void> {
  const representative = findRepresentativeCodeFile(repoRoot);
  const relativePath = representative ? relative(repoRoot, representative).replace(/\\/g, '/') : '';

  const overviewSpinner = ora('Summarizing architecture with Repowise...').start();
  const overview = await callMcpTool(client, 'repowise_get_overview', {});
  overviewSpinner.stop();

  let intel: any = null;
  if (relativePath) {
    const intelSpinner = ora(`Assessing ${relativePath} with unified codebase intel...`).start();
    intel = await callMcpTool(client, 'codebase_intel_assess', {
      file_path: relativePath,
      depth: 'quick',
    });
    intelSpinner.stop();
  }

  console.log(chalk.bold('\n  Codebase Intelligence\n'));
  console.log(`  ${chalk.dim('Project:')} ${displayName}`);
  if (relativePath) {
    console.log(`  ${chalk.dim('Focus:')}   ${relativePath}`);
  }

  if (overview && !overview.error) {
    const summary = overview.summary || overview.architecture_summary || overview.overview || overview.description;
    const techStack = overview.tech_stack || overview.stack || [];
    const entryPoints = overview.entry_points || overview.entryPoints || [];
    const hotspots = overview.hotspots || overview.key_hotspots || [];

    if (summary) console.log(`  ${chalk.dim('Overview:')} ${String(summary).slice(0, 220)}`);
    if (Array.isArray(techStack) && techStack.length) {
      console.log(`  ${chalk.dim('Stack:')}    ${techStack.slice(0, 6).join(', ')}`);
    }
    if (Array.isArray(entryPoints) && entryPoints.length) {
      console.log(`  ${chalk.dim('Entrypoints:')} ${entryPoints.slice(0, 3).map((v: any) => typeof v === 'string' ? v : (v.path || v.name || '?')).join(', ')}`);
    }
    if (Array.isArray(hotspots) && hotspots.length) {
      console.log(`  ${chalk.dim('Hotspots:')} ${hotspots.slice(0, 3).map((v: any) => typeof v === 'string' ? v : (v.file || v.name || '?')).join(', ')}`);
    }
  } else if (overview?.error) {
    console.log(chalk.yellow(`  Repowise overview unavailable: ${overview.error}`));
  }

  if (intel && !intel.error) {
    const riskLevel = intel.unified_risk_level || 'unknown';
    const signals = Array.isArray(intel.risk_signals) ? intel.risk_signals : [];
    const recommendations = Array.isArray(intel.recommendations) ? intel.recommendations : [];

    console.log(`  ${chalk.dim('Risk:')}     ${colorRiskLevel(riskLevel)}`);
    if (signals.length) {
      console.log(`  ${chalk.dim('Signals:')}  ${signals.slice(0, 3).join(' | ')}`);
    }
    if (recommendations.length) {
      console.log(`  ${chalk.dim('Advice:')}   ${recommendations[0]}`);
    }
  } else if (intel?.error) {
    console.log(chalk.yellow(`  Unified intel unavailable: ${intel.error}`));
  }

  console.log();
}

function parseToolResponse(payload: any): any {
  const raw = payload?.result ?? payload?.output ?? payload?.content ?? payload;

  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === 'object' && raw[0] && 'text' in raw[0]) {
    return parseToolResponse(raw[0].text);
  }

  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

/**
 * Invoke an MCP tool, routing to the right transport:
 *   - remote MCP gateway (config.mcpUrl, MCP protocol) when configured —
 *     so awnode tools work against a cloud workspace; else
 *   - the chat backend's REST /tools/call (local Genesis).
 * Returns the parsed tool output, or `{ error, status }` on failure.
 */
export async function invokeMcpTool(
  client: GenesisClient,
  tool: string,
  params: Record<string, any>,
): Promise<any> {
  const remote = getRemoteMcpClient(getActiveConfig());
  if (remote) {
    try {
      const result = await remote.callTool(tool, params);
      const parsed = parseToolResponse(result);
      if (result?.isError) {
        return { error: typeof parsed === 'string' ? parsed : JSON.stringify(parsed), status: 0 };
      }
      return parsed;
    } catch (err: any) {
      return { error: err?.message || 'MCP tool call failed', status: 0 };
    }
  }
  const response = await client.postDetailed('/tools/call', { tool, params });
  if (response?.error) {
    return { error: response.error, status: response.status || 0 };
  }
  return parseToolResponse(response);
}

async function callMcpTool(client: GenesisClient, tool: string, params: Record<string, any>): Promise<any> {
  return invokeMcpTool(client, tool, params);
}

/** Copy text to the OS clipboard (win32 clip / macOS pbcopy / Linux xclip|wl-copy). */
function copyToClipboard(text: string): void {
  const plat = process.platform;
  const cmd = plat === 'win32' ? 'clip'
    : plat === 'darwin' ? 'pbcopy'
      : 'xclip -selection clipboard';
  const p = spawn(cmd, { shell: true });
  p.on('error', () => {});  // don't crash if the clipboard tool is missing
  // `end(text)` writes then closes in one shot — avoids a stdin backpressure
  // hang on large/multiline content (a bare write+end can deadlock the pipe).
  p.stdin.on('error', () => {});
  p.stdin.end(text);
}

const COMMANDS: Record<string, Command> = {
  // ── Federation permission cards (A2A access requests) ──
  // The SAME cards the portal tray, the Awconnect popup and `adk approvals`
  // show: genesis reconciles them from the shared store, so deciding here
  // clears them everywhere. A blocked peer agent is waiting on this.
  'publish-preflight': {
    description: 'Check a package can actually publish, before anything is uploaded',
    usage: '/publish-preflight [dir] | /publish-preflight --diagnose "<error text>"',
    handler: async (_client, args, _config) => {
      // SHELLS OUT to `adk publish-preflight` rather than reimplementing it.
      // The logic lives in one place on purpose: this repo has already paid for
      // two copies of one rule drifting apart, and a preflight that disagrees
      // with the thing that actually publishes is worse than no preflight.
      const raw = args.trim();
      const argv = raw.startsWith('--diagnose')
        ? ['publish-preflight', '--diagnose', raw.slice('--diagnose'.length).trim()]
        : ['publish-preflight', raw || '.'];

      const run = (bin: string) => new Promise<number | null>((resolve) => {
        const child = spawn(bin, argv, { stdio: 'inherit', shell: false });
        child.on('error', () => resolve(null));   // not installed / not on PATH
        child.on('close', (code) => resolve(code ?? 1));
      });

      let code = await run('adk');
      if (code === null) code = await run('awdk');   // the uvx-shaped alias
      if (code === null) {
        console.log(chalk.yellow('  adk is not on PATH.'));
        console.log(chalk.dim('    pip install awdk    # then re-run'));
        return;
      }
      if (code === 0) {
        console.log(chalk.green('  preflight clean — the upload is the only irreversible step and was NOT performed'));
      } else {
        // A non-zero here is a VERDICT, not a crash. Say so, or someone goes
        // hunting a broken command instead of reading the finding above.
        console.log(chalk.red('  preflight found something — fix it before uploading (details above)'));
      }
    },
  },
  approvals: {
    description: 'Decide A2A permission cards blocking federated agents',
    usage: '/approvals | /approvals approve <id> | /approvals deny <id>',
    handler: async (client, args, _config) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] || '').toLowerCase();

      if (sub === 'approve' || sub === 'deny') {
        const id = parts[1];
        if (!id) { console.log(chalk.yellow(`  Usage: /approvals ${sub} <id>`)); return; }
        const r = await client.post(`/notifications/${id}/action`, { action: sub })
          .catch((e: any) => ({ error: String(e) }));
        // A 403 (not the owner) or 409 (already decided) is an ANSWER, not an
        // outage. Print it — "failed" would send someone hunting a broken service.
        if (r?.error || r?.detail) {
          console.log(chalk.red(`  ${r.detail || r.error}`));
          return;
        }
        if (r?.grant_token) {
          console.log(chalk.green(`  Approved. Shown ONCE — the requester replays it as:`));
          console.log(`    ${chalk.cyan('X-A2A-Grant')}: ${r.grant_token}`);
          if (r.ttl_minutes) console.log(chalk.dim(`    expires in ${r.ttl_minutes}m`));
        } else {
          console.log(chalk.green(`  Denied ${id}. No grant was minted.`));
        }
        return;
      }

      const data = await client.get('/notifications?limit=50')
        .catch((e: any) => ({ error: String(e) }));
      if (data?.error) { console.log(chalk.red(`  ${data.error}`)); return; }
      const cards = (data?.notifications || []).filter(
        (n: any) => n.access_request_id && n.status !== 'action' && !n.dismissed,
      );
      if (!cards.length) { console.log(chalk.dim('  No pending access requests.')); return; }

      console.log(chalk.bold(`\n  ${cards.length} pending access request(s):\n`));
      for (const c of cards) {
        console.log(`  ${chalk.yellow(c.id)}`);
        console.log(`    ${chalk.bold(c.requesting_agent || 'agent')} ${chalk.dim(`· ${c.requesting_tenant || 'unknown'}`)}`);
        console.log(`    wants ${chalk.cyan(c.requested_resource || '')}`);
        console.log('');
      }
      console.log(chalk.dim('  /approvals approve <id>   |   /approvals deny <id>\n'));
    },
  },

  // ── Human-actionable inbox (ActionHub) ──
  actions: {
    description: 'Show pending action cards; resolve or dismiss one',
    usage: '/actions [critical] | /actions dismiss <id> | /actions approve <id>',
    handler: async (client, args, _config) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] || '').toLowerCase();

      // Resolve path first: /actions <verb> <id>
      if (['dismiss', 'approve', 'reject'].includes(sub)) {
        const id = parts[1];
        if (!id) { console.log(chalk.yellow(`  Usage: /actions ${sub} <id>`)); return; }
        const r = await client.post(`/actions/${id}/resolve`, {
          action: sub, notes: 'resolved from AitherShell',
        }).catch((e: any) => ({ error: String(e) }));
        console.log(r && !r.error
          ? chalk.green(`  ${sub}ed ${id}`)
          : chalk.red(`  Could not ${sub} ${id}: ${r?.error || 'unknown error'}`));
        return;
      }

      // BOUNDED listing. Defaults to critical-only because the inbox reached
      // 18,087 pending cards on 2026-07-30 — dumping it into a terminal is how a
      // real escalation becomes invisible. `/actions all` widens it deliberately.
      const wantAll = sub === 'all';
      const priority = wantAll ? undefined : 'critical';
      const res = await client.getActions(wantAll ? 20 : 10, 'pending', priority)
        .catch(() => null);
      if (res === null) {
        console.log(chalk.dim('  Action inbox needs the Genesis backend (not available on ADK).'));
        return;
      }
      // getActions already normalised the envelope and applied the priority filter.
      const cards: any[] = res || [];
      if (!cards.length) {
        console.log(chalk.green(`\n  Nothing pending${wantAll ? '' : ' at critical'}.` +
          (wantAll ? '' : chalk.dim('  (/actions all for everything)')) + '\n'));
        return;
      }
      console.log(chalk.bold(`\n  ${cards.length} pending${wantAll ? '' : ' critical'} action${cards.length === 1 ? '' : 's'}\n`));
      const rows = cards.map((c: any) => [
        chalk.dim(String(c?.id || '').slice(0, 22)),
        (c?.priority === 'critical' ? chalk.red : chalk.yellow)(String(c?.priority || '?')),
        String(c?.title || 'untitled').slice(0, 52),
        chalk.dim(String(c?.created_at || '').slice(0, 16)),
      ]);
      console.log(formatTable(['  ID', 'Priority', 'Title', 'Created'], rows));
      console.log(chalk.dim('\n  Resolve: /actions dismiss <id>   |   /actions approve <id>\n'));
    },
  },

  help: {
    description: 'Show available commands',
    handler: async () => {
      console.log(chalk.bold('\n  Available Commands\n'));
      const rows = Object.entries(COMMANDS)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, cmd]) => [chalk.cyan(`/${name}`), cmd.description]);
      console.log(formatTable(['  Command', 'Description'], rows));
      console.log();
      console.log(chalk.dim('  Chat:   type a message to talk to the default agent'));
      console.log(chalk.dim('  Route:  @agent_name message — talk to a specific agent'));
      console.log(chalk.dim('  Exit:   type "exit" or press Ctrl+D'));
      console.log();
    },
  },

  // ── Installation & onboarding ──
  install: {
    description: 'One-click installer wizard (non-technical setup)',
    handler: async (client, _args, config) => {
      await runWizard(client, config);
    },
  },

  // ── Conversation QoL (transcript-backed) ──
  chats: {
    description: 'List, resume, or delete saved chat conversations',
    usage: '/chats [resume <id> | delete <id>]',
    handler: async (_client, args, config) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || '';
      if (sub === 'resume' && parts[1]) {
        const entry = loadSession(parts[1]);
        if (!entry) { console.log(chalk.yellow(`  Session ${parts[1]} not found locally.`)); return; }
        config.sessionId = entry.sessionId;
        console.log(chalk.green(`  ↩ Switched to ${entry.sessionId.slice(0, 8)} (${entry.messages.length} msgs) — continues via session id.`));
        console.log(chalk.dim(`  For a full replay, relaunch: aither --resume ${entry.sessionId}`));
        return;
      }
      if (sub === 'delete' && parts[1]) {
        console.log(deleteSession(parts[1]) ? chalk.green(`  Deleted ${parts[1]}.`) : chalk.yellow('  Not found.'));
        return;
      }
      const list = listSessions(20);
      if (!list.length) { console.log(chalk.dim('  No saved chats yet.')); return; }
      console.log();
      console.log(formatTable(['  Session', 'Agent', 'Msgs', 'Updated'],
        list.map(s => [chalk.cyan(s.sessionId.slice(0, 8)), s.agent, String(s.messageCount), new Date(s.updatedAt).toLocaleString()])));
      console.log(chalk.dim('\n  /chats resume <id>   ·   /chats delete <id>   ·   aither --continue'));
      console.log();
    },
  },

  export: {
    description: 'Export the current conversation transcript to a file',
    usage: '/export [path] [--json]',
    handler: async (_client, args, config) => {
      const entry = loadSession(config.sessionId);
      if (!entry || !entry.messages.length) { console.log(chalk.dim('  Nothing to export yet.')); return; }
      const json = /--json\b/.test(args);
      const pathArg = args.replace(/--json\b/, '').trim();
      const file = pathArg || join(homedir(), '.aither', 'exports', `${config.sessionId.slice(0, 8)}.${json ? 'json' : 'md'}`);
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, json ? JSON.stringify(entry, null, 2) : transcriptMarkdown(entry));
        console.log(chalk.green(`  ✓ Exported ${entry.messages.length} messages → ${file}`));
      } catch (e: any) { console.log(chalk.red(`  Export failed: ${e.message}`)); }
    },
  },

  copy: {
    description: 'Copy the last assistant answer to the clipboard',
    handler: async (_client, _args, config) => {
      const entry = loadSession(config.sessionId);
      const last = entry?.messages.slice().reverse().find(m => m.role === 'assistant');
      if (!last) { console.log(chalk.dim('  No answer to copy yet.')); return; }
      try { copyToClipboard(last.content); console.log(chalk.green(`  ✓ Copied ${last.content.length} chars to clipboard.`)); }
      catch (e: any) { console.log(chalk.yellow(`  Could not copy: ${e.message}`)); }
    },
  },

  tokens: {
    description: 'Show token usage for the current session',
    handler: async (_client, _args, config) => {
      const entry = loadSession(config.sessionId);
      if (!entry) { console.log(chalk.dim('  No usage recorded yet.')); return; }
      const turns = entry.messages.filter(m => m.role === 'assistant').length;
      console.log(chalk.bold(`\n  Session ${config.sessionId.slice(0, 8)}`));
      console.log(`  Turns: ${turns}   ·   Tokens: ${sessionTokens(entry)}   ·   Messages: ${entry.messages.length}\n`);
    },
  },

  rewind: {
    description: 'Drop the last N turns from the conversation context',
    usage: '/rewind [N]',
    handler: async (_client, args, config) => {
      const n = Math.max(1, Number(args.trim()) || 1);
      const entry = loadSession(config.sessionId);
      if (!entry || !entry.messages.length) { console.log(chalk.dim('  Nothing to rewind.')); return; }
      const removed = entry.messages.splice(-n * 2, n * 2);
      saveSession(entry);
      console.log(chalk.green(`  ↶ Rewound ${Math.floor(removed.length / 2)} turn(s). ${entry.messages.length} messages left.`));
    },
  },

  compact: {
    description: 'Summarize the conversation and compact the context',
    handler: async (client, _args, config) => {
      const entry = loadSession(config.sessionId);
      if (!entry || entry.messages.length < 2) { console.log(chalk.dim('  Not enough conversation to compact.')); return; }
      const spinner = ora('Summarizing conversation...').start();
      let summary = '';
      try {
        for await (const ev of client.streamChat(
          'Summarize our conversation so far into a concise brief I can use as context to continue — key facts, decisions, and open threads.',
          { sessionId: config.sessionId, agent: config.defaultAgent, model: config.model })) {
          const d: any = ev.data || {};
          if (ev.type === 'token') summary += (d.t || d.token || '');
          else if ((ev.type === 'message' || ev.type === 'answer' || ev.type === 'final_answer') && !summary) summary = String(d.answer || d.content || d.message || '');
        }
      } catch (e: any) { spinner.stop(); console.log(chalk.yellow(`  Compact failed: ${e.message} — transcript kept.`)); return; }
      spinner.stop();
      // Guard: never replace a real conversation with an empty/truncated summary.
      if (summary.trim().length < 40) { console.log(chalk.yellow('  Summary too short — transcript kept unchanged.')); return; }
      entry.messages = [{ role: 'assistant', content: `[Conversation summary]\n${summary.trim()}`, timestamp: new Date().toISOString() }];
      saveSession(entry);
      console.log(chalk.green(`  ✓ Compacted to a ${summary.length}-char summary (kept as context).`));
    },
  },

  trace: {
    description: 'Replay the live trace (events + timing) of a recent turn',
    usage: '/trace [N]   — show the last turn (or the N-th most recent)',
    handler: async (_client, args) => {
      const sessRoot = join(homedir(), '.aither', 'sessions');
      if (!existsSync(sessRoot)) {
        console.log(chalk.dim('  No traces recorded yet.'));
        return;
      }
      // Gather all persisted turn profiles; filename is an ISO timestamp so a
      // lexical sort gives recency without stat() calls.
      const files: { path: string; name: string }[] = [];
      for (const sid of readdirSync(sessRoot)) {
        const dir = join(sessRoot, sid);
        let entries: string[] = [];
        try { entries = readdirSync(dir); } catch { continue; }
        for (const f of entries) {
          if (f.endsWith('.json')) files.push({ path: join(dir, f), name: f });
        }
      }
      if (!files.length) {
        console.log(chalk.dim('  No traces recorded yet.'));
        return;
      }
      files.sort((a, b) => b.name.localeCompare(a.name));
      const idx = Math.min(Math.max(0, (parseInt(args.trim(), 10) || 1) - 1), files.length - 1);

      let profile: any;
      try {
        profile = JSON.parse(readFileSync(files[idx].path, 'utf8'));
      } catch (e) {
        console.log(chalk.red(`  Failed to read trace: ${e}`));
        return;
      }
      const events: any[] = profile.events || [];
      console.log(chalk.bold(
        `\n  Trace — ${(profile.prompt || profile.session_id || '').slice(0, 60)} ` +
        `(${events.length} events · ${((profile.duration_ms || 0) / 1000).toFixed(1)}s)\n`,
      ));
      const t0 = events.length ? (events[0].data?._ts || 0) : 0;
      let tokenRun = 0;
      const flushTokens = () => {
        if (tokenRun > 0) {
          console.log(chalk.dim(`           · ${tokenRun} token chunk(s) streamed`));
          tokenRun = 0;
        }
      };
      for (const ev of events) {
        if (ev.type === 'token') { tokenRun++; continue; }
        flushTokens();
        if (ev.type === 'heartbeat') continue;
        const ts = ev.data?._ts || 0;
        const rel = t0 ? ((ts - t0) / 1000).toFixed(2).padStart(6) : '   ?  ';
        const d = ev.data || {};
        const detail = d.detail || d.substage || d.summary || d.step ||
          d.message || d.status || d.model || d.stage || '';
        console.log(
          chalk.dim(`  +${rel}s `) + chalk.cyan(ev.type) +
          (detail ? chalk.dim(`  ${String(detail).slice(0, 90)}`) : ''),
        );
      }
      flushTokens();
      console.log(chalk.dim(`\n  (showing ${idx + 1}/${files.length} — /trace ${idx + 2} for older)\n`));
    },
  },

  status: {
    description: 'Show system status',
    handler: async (client) => {
      const spinner = ora('Fetching status...').start();

      // Fetch pool/queue from MicroScheduler + Genesis status in parallel
      const msUrls = [process.env.AITHER_LLM_URL, 'https://localhost:8150'].filter(Boolean) as string[];
      async function fetchMS(path: string): Promise<any> {
        for (const base of msUrls) {
          try {
            const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) });
            if (r.ok) return r.json();
          } catch {}
        }
        return null;
      }

      const [status, genesisHealth, pool, queue, agentsData, servicesData] = await Promise.all([
        client.getStatus(),
        client.get('/health').catch(() => null),
        fetchMS('/queue/vllm-pool'),
        fetchMS('/llm/queue'),
        client.getAgents(),
        client.getServices(),
      ]);
      spinner.stop();

      console.log();

      // Genesis health
      const health = status?.health || 'unknown';
      const version = status?.version || '';
      console.log(chalk.bold('  Genesis:  ') + (health === 'ok' || health === 'healthy'
        ? chalk.green(`healthy`) : chalk.yellow(health))
        + (version ? chalk.dim(` v${version}`) : ''));

      // Uptime
      if (status?.uptime_seconds) {
        const h = Math.floor(status.uptime_seconds / 3600);
        const m = Math.floor((status.uptime_seconds % 3600) / 60);
        console.log(chalk.bold('  Uptime:   ') + `${h}h ${m}m`);
      }

      // LLM Pool — the most important info
      if (pool) {
        const avail = pool.available_for_user ?? 0;
        const total = pool.total_slots ?? 0;
        const active = pool.active_total ?? 0;
        const color = avail === 0 ? chalk.red : avail < total / 4 ? chalk.yellow : chalk.green;
        console.log(chalk.bold('  Pool:     ') + color(`${avail}/${total} slots free`) + chalk.dim(` (${active} active)`));
        if (pool.active_by_priority && Object.keys(pool.active_by_priority).length > 0) {
          const parts = Object.entries(pool.active_by_priority).map(([k, v]) => `${k}:${v}`).join(' ');
          console.log(chalk.dim(`            ${parts}`));
        }
        if (pool.lifetime_timeouts > 0) {
          console.log(chalk.yellow(`            ${pool.lifetime_timeouts} timeouts (leak detection active)`));
        }
      }

      // Queue
      if (queue) {
        const queued = queue.queued ?? 0;
        const processing = queue.processing ?? 0;
        const completed = queue.completed_total ?? 0;
        const failed = queue.failed_total ?? 0;
        const avgExec = queue.avg_execution_ms ? `${(queue.avg_execution_ms / 1000).toFixed(1)}s avg` : '';
        console.log(chalk.bold('  Queue:    ') +
          `${queued} queued, ${processing} processing` +
          chalk.dim(` (${completed} done, ${failed} failed${avgExec ? ', ' + avgExec : ''})`));
      }

      // Generation readiness from Genesis health
      if (genesisHealth?.generation_ready === false) {
        console.log(chalk.bold('  LLM:      ') + chalk.red('BUSY — pool exhausted'));
      } else if (genesisHealth?.generation_warning) {
        console.log(chalk.bold('  LLM:      ') + chalk.yellow(genesisHealth.generation_warning));
      } else {
        console.log(chalk.bold('  LLM:      ') + chalk.green('ready'));
      }

      // Services
      const rawSvcs = servicesData?.services;
      const svcCount = servicesData?.count
        || (Array.isArray(rawSvcs) ? rawSvcs.length : Object.keys(rawSvcs || {}).length);
      const trackedCount = status?.tracked_services ?? svcCount;
      if (trackedCount > 0) {
        console.log(chalk.bold('  Services: ') + `${trackedCount} tracked`);
      }

      // Agents
      const agentList = agentsData?.agents || [];
      if (agentList.length > 0) {
        console.log(chalk.bold('  Agents:   ') + `${agentList.length} registered`);
      }

      // VRAM
      if (queue?.vram_available_mb) {
        const usedMB = queue.vram_used_mb || 0;
        const totalMB = queue.vram_available_mb || 0;
        if (totalMB > 0) {
          const pct = Math.round((usedMB / totalMB) * 100);
          console.log(chalk.bold('  VRAM:     ') + `${(usedMB / 1024).toFixed(1)}/${(totalMB / 1024).toFixed(1)} GB (${pct}%)`);
        }
      }

      console.log();
    },
  },

  agents: {
    description: 'List registered agents',
    handler: async (client) => {
      const spinner = ora('Fetching agents...').start();
      const result = await client.getAgents();
      spinner.stop();

      const agents = result?.agents || [];
      if (!agents.length) {
        console.log(chalk.dim('  No agents registered'));
        return;
      }

      console.log();
      const rows = agents.map((a: any) => [
        chalk.cyan(a.name || a.id || 'unknown'),
        a.role || a.description || '',
        a.status === 'online' || a.status === 'active'
          ? chalk.green('\u25cf ' + (a.status || 'online'))
          : chalk.dim('\u25cb ' + (a.status || 'offline')),
      ]);
      console.log(formatTable(['  Agent', 'Role', 'Status'], rows));
      console.log();
      console.log(chalk.dim('  Want more? 43 agents available — /explore agents'));
      console.log(chalk.dim('  Try premium: @demiurge, @hydra, @athena, @lyra'));
      console.log();
    },
  },

  services: {
    description: 'List running services with health',
    handler: async (client) => {
      const spinner = ora('Fetching services...').start();
      const result = await client.getServices();
      spinner.stop();

      // /services returns {count, services} — services can be {} (dict) or [] (list)
      const raw = result?.services;
      let services: any[] = [];
      if (Array.isArray(raw)) {
        services = raw;
      } else if (raw && typeof raw === 'object') {
        // Dict format: {ServiceName: {port, status, ...}, ...}
        services = Object.entries(raw).map(([name, info]: [string, any]) => ({
          name,
          ...(typeof info === 'object' ? info : {}),
        }));
      }

      if (!services.length) {
        // Try /monitoring/dashboard as fallback for richer data
        const dash = await client.get('/monitoring/dashboard');
        const dashSvcs = dash?.services;
        if (Array.isArray(dashSvcs) && dashSvcs.length) {
          services = dashSvcs;
        }
      }

      if (!services.length) {
        console.log(chalk.dim('  No services discovered yet (proactive monitor may still be starting)'));
        console.log(chalk.dim('  Tip: /status shows basic system info'));
        return;
      }

      console.log();
      const rows = services.slice(0, 40).map((s: any) => [
        chalk.cyan(s.name || s.service || '?'),
        String(s.port || ''),
        s.status === 'healthy' || s.healthy
          ? chalk.green('\u25cf healthy')
          : s.status === 'degraded'
            ? chalk.yellow('\u25cf degraded')
            : chalk.red('\u25cf ' + (s.status || 'down')),
        s.group || s.layer || '',
      ]);
      console.log(formatTable(['  Service', 'Port', 'Health', 'Group'], rows));
      if (services.length > 40) {
        console.log(chalk.dim(`\n  ... and ${services.length - 40} more`));
      }
      console.log();
    },
  },

  forge: {
    description: 'Dispatch a task to an agent via Forge',
    usage: '/forge "task" [--agent name] [--effort N]',
    handler: async (client: GenesisClient, args: string) => {
      let task = args;
      let agent: string | undefined;
      let effort: number | undefined;

      const agentMatch = args.match(/--agent\s+(\S+)/);
      if (agentMatch) { agent = agentMatch[1]; task = task.replace(agentMatch[0], ''); }

      const effortMatch = args.match(/--effort\s+(\d+)/);
      if (effortMatch) { effort = Number(effortMatch[1]); task = task.replace(effortMatch[0], ''); }

      task = task.replace(/^["']|["']$/g, '').trim();

      if (!task) {
        console.log(chalk.yellow('  Usage: /forge "task description" [--agent name] [--effort N]'));
        return;
      }

      const label = agent ? `Dispatching to ${agent}` : 'Dispatching via Forge';
      const spinner = ora(`${label} (effort ${effort ?? 5})...`).start();
      let result: any;
      try {
        result = await client.forgeDispatch(task, { agent, effort });
      } catch (err: any) {
        spinner.stop();
        console.log(chalk.red(`  Error: ${err.message}`));
        return;
      }
      spinner.stop();

      if (result?.error) {
        console.log(chalk.red(`  Error: ${result.error}`));
        return;
      }

      console.log();
      const output = result?.response || result?.result || result?.output;
      if (output) {
        console.log(output);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      console.log();
    },
  },

  lyra: {
    description: 'Ask Lyra (the Research Librarian) to research a question',
    usage: '/lyra "question" [--effort quick_glance|library_session|deep_dive|leave_no_stone|N]',
    handler: async (client: GenesisClient, args: string) => {
      // Effort tiers map onto the platform 1-10 effort scale.
      const TIERS: Record<string, number> = {
        quick_glance: 3, library_session: 5, deep_dive: 7, leave_no_stone: 9,
      };
      let question = args;
      let effort = TIERS.library_session;

      const effortMatch = args.match(/--effort\s+(\S+)/);
      if (effortMatch) {
        const raw = effortMatch[1].toLowerCase();
        effort = TIERS[raw] ?? (Number(raw) || effort);
        question = question.replace(effortMatch[0], '');
      }
      question = question.replace(/^["']|["']$/g, '').trim();

      if (!question) {
        console.log(chalk.yellow(`  Usage: ${COMMANDS.lyra.usage}`));
        return;
      }

      const tierName = Object.entries(TIERS).find(([, v]) => v === effort)?.[0] || `effort ${effort}`;
      const spinner = ora(`Lyra is researching (${tierName})...`).start();
      let result: any;
      try {
        result = await client.forgeDispatch(question, { agent: 'lyra', effort });
      } catch (err: any) {
        spinner.stop();
        console.log(chalk.red(`  Error: ${err.message}`));
        return;
      }
      spinner.stop();

      if (result?.error) {
        console.log(chalk.red(`  Error: ${result.error}`));
        return;
      }

      console.log();
      const output = result?.response || result?.result || result?.output;
      console.log(output || JSON.stringify(result, null, 2));
      const sources = result?.sources || result?.citations;
      if (Array.isArray(sources) && sources.length) {
        console.log(chalk.dim('\n  Sources:'));
        for (const s of sources.slice(0, 8)) {
          console.log(chalk.dim(`   - ${typeof s === 'string' ? s : s.url || s.title || JSON.stringify(s)}`));
        }
      }
      console.log();
    },
  },

  spec: {
    description: "Spec Ledger — list/inspect specs, ingest a PRD, publish issues, reasoner",
    usage: '/spec [list | status <id> | ingest <path|url> [--pack x] | publish <id> [--repo o/n] [--new "Title"|--board o/n|--no-board] [--go] | reasoner [mode] | settings [--repo o/n] [--board o/n]]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'list').toLowerCase();
      const flag = (name: string) => {
        const m = args.match(new RegExp(`--${name}\\s+("[^"]+"|\\S+)`));
        return m ? m[1].replace(/^"|"$/g, '') : '';
      };

      if (sub === 'list' || sub === '') {
        const spinner = ora('Loading specs...').start();
        const r = await client.get('/spec/list?limit=100');
        spinner.stop();
        const specs = r?.specs || [];
        if (!specs.length) { console.log(chalk.dim('  No specs ingested yet — /spec ingest <path|url>')); return; }
        console.log();
        for (const s of specs) {
          console.log(`  ${chalk.cyan(s.id)}  ${chalk.bold(s.title)}`);
          console.log(chalk.dim(`     ${s.requirement_count} reqs · ${s.conformance_pct}% conformant${s.target_pack ? ` · pack ${s.target_pack}` : ''}`));
        }
        console.log();
        return;
      }

      if (sub === 'status') {
        const id = parts[1];
        if (!id) { console.log(chalk.dim('  Usage: /spec status <spec_id>')); return; }
        const spinner = ora('Loading...').start();
        const r = await client.get(`/spec/${encodeURIComponent(id)}/status`);
        spinner.stop();
        if (!r || r.error || r.detail) { console.log(chalk.red(`  ${r?.error || r?.detail || 'not found'}`)); return; }
        const ov = r.coverage?.overall || {};
        console.log();
        console.log(`  ${chalk.bold(r.title)} ${chalk.dim(`(${r.target_pack || 'untriaged'})`)}`);
        console.log(`  ${ov.pct ?? 0}% conformant — ${ov.satisfied ?? 0}/${ov.total ?? 0} satisfied, ${(r.gaps || []).length} gaps`);
        for (const [cat, c] of Object.entries<any>(r.coverage?.by_category || {})) {
          console.log(chalk.dim(`     ${cat}: ${c.satisfied}/${c.total} (${c.pct}%)`));
        }
        console.log();
        return;
      }

      if (sub === 'ingest') {
        const src = parts[1];
        if (!src) { console.log(chalk.dim('  Usage: /spec ingest <path|url> [--pack x]')); return; }
        const body: Record<string, any> = { background: false };
        body[src.startsWith('http') ? 'url' : 'path'] = src;
        const pack = flag('pack'); if (pack) body.target_pack = pack;
        const spinner = ora('Ingesting + extracting (reasoner)...').start();
        const r = await client.post('/spec/ingest', body);
        spinner.stop();
        if (!r || r.error) { console.log(chalk.red(`  ${r?.error || 'ingest failed'}`)); return; }
        console.log(chalk.green(`  Ingested ${chalk.cyan(r.spec_doc_id)} — ${r.requirement_count ?? 0} requirements`));
        if (r.by_category) console.log(chalk.dim(`     ${Object.entries(r.by_category).map(([k, v]) => `${k}:${v}`).join(', ')}`));
        return;
      }

      if (sub === 'reasoner') {
        const mode = parts[1];
        const r = mode
          ? await client.post('/spec/reasoner', { mode })
          : await client.get('/spec/reasoner');
        if (!r || r.error) { console.log(chalk.red(`  ${r?.error || 'reasoner call failed'}`)); return; }
        console.log(`  Reasoner: ${chalk.cyan(r.effective)}  ${chalk.dim(`(available: ${(r.available_modes || []).join(', ')})`)}`);
        return;
      }

      if (sub === 'settings') {
        const repo = flag('repo'), board = flag('board');
        let r;
        if (repo || board) {
          const body: Record<string, any> = {};
          if (repo) body.publish_repo = repo;
          if (board) body.publish_project = board;
          r = await client.post('/spec/settings', body);
        } else {
          r = await client.get('/spec/settings');
        }
        if (!r || r.error) { console.log(chalk.red(`  ${r?.error || 'settings failed'}`)); return; }
        console.log(`  Reasoner: ${chalk.cyan(r.reasoner_mode)} · publish_repo: ${chalk.cyan(r.publish_repo || '(unset)')} · board: ${chalk.cyan(r.publish_project || '(unset)')}`);
        return;
      }

      if (sub === 'publish') {
        const id = parts[1];
        if (!id) { console.log(chalk.dim('  Usage: /spec publish <id> [--repo o/n] [--new "Title"|--board o/n|--no-board] [--go]')); return; }
        const go = /--go\b/.test(args);
        const body: Record<string, any> = { dry_run: !go };
        const repo = flag('repo'); if (repo) body.repo = repo;            // else server uses spec_settings default
        const newTitle = flag('new'); const board = flag('board');
        if (newTitle) body.create_project_title = newTitle;
        else if (board) body.project = board;
        // --no-board: leave both unset → issues only
        const spinner = ora(go ? 'Publishing issues...' : 'Dry-run preview...').start();
        const r = await client.post(`/spec/${encodeURIComponent(id)}/publish-issues`, body);
        spinner.stop();
        if (!r || (r.error && !r.created)) { console.log(chalk.red(`  ${r?.error || 'publish failed'}`)); return; }
        const created = r.created?.length ?? 0, skipped = r.skipped_existing?.length ?? 0, errs = r.errors?.length ?? 0;
        console.log();
        console.log(`  ${go ? chalk.green(`Published ${created}`) : chalk.yellow(`Would create ${created}`)} issue(s) on ${chalk.cyan(r.repo)}` +
          (skipped ? `, skipped ${skipped}` : '') + (errs ? chalk.red(`, ${errs} errors`) : '') + (r.project ? ` → board ${chalk.cyan(r.project)}` : ''));
        if (errs) console.log(chalk.red(`     ${r.errors[0]}`));
        if (!go) console.log(chalk.dim('     (dry-run — add --go to actually publish)'));
        console.log();
        return;
      }

      console.log(chalk.dim('  Usage: /spec [list | status <id> | ingest <path|url> | publish <id> | reasoner [mode] | settings]'));
    },
  },

  atlas: {
    description: "Atlas PM board — latest cycle, in-flight items, or run a cycle",
    usage: '/atlas [board|tick] [--items N] [--sync]',
    handler: async (client: GenesisClient, args: string) => {
      const sub = (args.trim().split(/\s+/)[0] || 'board').toLowerCase();

      if (sub === 'tick') {
        const itemsMatch = args.match(/--items\s+(\d+)/);
        const sync = /--sync\b/.test(args);
        const body: Record<string, any> = { max_items: itemsMatch ? Number(itemsMatch[1]) : 1 };
        if (sync) body.sync = true;
        const spinner = ora(sync ? 'Running one Atlas PM cycle (sync)...' : 'Queuing an Atlas PM cycle...').start();
        const result = await client.post('/spec/factory/pm-tick', body);
        spinner.stop();
        if (!result || result.error) {
          console.log(chalk.red(`  Error: ${result?.error || 'pm-tick failed (is Genesis up?)'}`));
          return;
        }
        console.log();
        if (result.job_id) {
          console.log(`  Cycle queued: ${chalk.cyan(result.job_id)}`);
          console.log(chalk.dim('  Poll with /atlas board (or /spec status APIs) for results.'));
        } else {
          const picked = result.picked || [];
          console.log(`  Cycle ${chalk.cyan(result.cycle_id || '?')} — backlog ${result.backlog_size ?? '?'}, picked ${picked.length}`);
          for (const p of picked) {
            const pr = p.pr_number ? chalk.green(`PR #${p.pr_number}`) : chalk.dim(p.status || 'no PR');
            console.log(`   - ${p.title || p.item}: ${pr}`);
          }
        }
        console.log();
        return;
      }

      // Default: the board — latest PM cycle summary + in-flight items.
      const spinner = ora('Fetching the Atlas board...').start();
      const result = await client.get('/spec/factory/pm-latest');
      spinner.stop();
      if (!result) {
        console.log(chalk.red('  Could not reach the PM board (is Genesis up?)'));
        return;
      }
      console.log();
      const cycle = result.latest_cycle;
      if (cycle) {
        const summary = cycle.summary || cycle;
        console.log(`  Latest cycle: ${chalk.cyan(cycle.cycle_id || summary.cycle_id || '?')} (${cycle.status || '?'})`);
        const picked = summary.picked || [];
        for (const p of picked) {
          const pr = p.pr_number ? chalk.green(`PR #${p.pr_number}`) : chalk.dim(p.status || '');
          console.log(`   - ${p.title || p.item}: ${pr} ${p.review ? chalk.dim(`[review: ${p.review}]`) : ''}`);
        }
      } else {
        console.log(chalk.dim('  No PM cycle has run yet — try /atlas tick'));
      }
      const inflight = result.in_flight || [];
      if (inflight.length) {
        console.log();
        const rows = inflight.slice(0, 20).map((it: any) => [
          chalk.cyan((it.key || it.item || '?').slice(0, 28)),
          (it.title || '').slice(0, 44),
          it.status || '?',
          it.pr_number ? `#${it.pr_number}` : '',
        ]);
        console.log(formatTable(['  Item', 'Title', 'Status', 'PR'], rows));
        if (inflight.length > 20) console.log(chalk.dim(`\n  ... and ${inflight.length - 20} more`));
      }
      console.log();
    },
  },

  logs: {
    description: 'Show recent log entries from Chronicle',
    usage: '/logs [--level error] [--limit 20] [--service name]',
    handler: async (client: GenesisClient, args: string) => {
      let limit = 20;
      let level: string | undefined;
      let service: string | undefined;

      const limitMatch = args.match(/--limit\s+(\d+)/);
      if (limitMatch) limit = Number(limitMatch[1]);

      const levelMatch = args.match(/--level\s+(\S+)/);
      if (levelMatch) level = levelMatch[1];

      const svcMatch = args.match(/--service\s+(\S+)/);
      if (svcMatch) service = svcMatch[1];

      const spinner = ora('Fetching logs...').start();
      const result = await client.getLogs(limit, level, service);
      spinner.stop();

      const logs = result?.logs || [];
      if (!logs.length) {
        console.log(chalk.dim('  No logs found'));
        return;
      }

      console.log();
      for (const log of logs) {
        const lvl = (log.level || 'INFO').toUpperCase();
        const color =
          lvl === 'ERROR' || lvl === 'CRITICAL' ? chalk.red
          : lvl === 'WARNING' ? chalk.yellow
          : chalk.dim;
        const ts = log.timestamp
          ? new Date(log.timestamp).toLocaleTimeString()
          : '';
        const svc = log.service ? chalk.cyan(`[${log.service}]`) : '';
        console.log(`  ${chalk.dim(ts)} ${color(lvl.padEnd(8))} ${svc} ${log.message || ''}`);
      }
      console.log();
    },
  },

  model: {
    description: 'Show or set the LLM model',
    usage: '/model [model_name]',
    handler: async (client, args, config) => {
      if (args.trim()) {
        config.model = args.trim();
        console.log(chalk.green(`  Model set to: ${config.model}`));
      } else {
        console.log(chalk.bold(`  Current: `) + (config.model || 'auto'));
        const result = await client.getLLMModels();
        const models = result?.models || [];
        if (models.length) {
          console.log(chalk.bold('  Available:'));
          for (const m of models) {
            console.log(`    ${chalk.cyan(m.id || m.name || m)}`);
          }
        }
      }
    },
  },

  sessions: {
    description: 'List recent forge sessions',
    usage: '/sessions [--limit N]',
    handler: async (client) => {
      const spinner = ora('Fetching sessions...').start();
      const result = await client.get('/forge/sessions');
      spinner.stop();

      const sessions = result?.sessions || [];
      if (!sessions.length) {
        console.log(chalk.dim('  No sessions found'));
        return;
      }

      console.log();
      const rows = sessions.slice(0, 20).map((s: any) => [
        chalk.cyan(s.session_id?.slice(0, 12) || s.id?.slice(0, 12) || '?'),
        s.agent_type || s.agent || '',
        s.status || '',
        String(s.turn_count || 0),
        s.completed_at
          ? new Date(s.completed_at * 1000).toLocaleString()
          : chalk.dim('active'),
      ]);
      console.log(formatTable(['  Session', 'Agent', 'Status', 'Turns', 'Completed'], rows));
      console.log();
    },
  },

  resume: {
    description: 'Resume a previous forge session',
    usage: '/resume <session_id> [prompt]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sessionId = parts[0];
      const prompt = parts.slice(1).join(' ') || 'Continue from where you left off.';

      if (!sessionId) {
        console.log(chalk.yellow('  Usage: /resume <session_id> [continuation prompt]'));
        return;
      }

      const spinner = ora(`Resuming session ${sessionId}...`).start();
      try {
        const res = await fetch(`${client.baseUrl}/forge/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, prompt }),
        });
        const result = await res.json();
        spinner.stop();

        if (result?.error) {
          console.log(chalk.red(`  Error: ${result.error}`));
          return;
        }

        const output = result?.response || result?.result || result?.output;
        if (output) {
          console.log();
          console.log(output);
          console.log();
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (err: any) {
        spinner.stop();
        console.log(chalk.red(`  Error: ${err.message}`));
      }
    },
  },

  apps: {
    description: 'Manage AitherOS apps (status, install, start, stop)',
    usage: '/apps [install|start|stop] [desktop|node|veil|connect|shell]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().toLowerCase().split(/\s+/);
      const action = parts[0] || 'status';
      const app = parts[1];

      // Resolve repo root (5 levels up from cli/dist/ or cli/src/)
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');

      /* ── App definitions ──────────────────────────────────── */
      interface AppDef {
        name: string;
        type: string;
        checkCmd?: string;
        healthUrl?: string;
        installCmd?: string;
        startCmd?: string;
        stopCmd?: string;
        note?: string;
      }

      const apps: Record<string, AppDef> = {
        desktop: {
          name: 'AitherDesktop',
          type: 'PyQt6 native app',
          checkCmd: 'pip show aither-desktop',
          installCmd: `pip install -e "${join(repoRoot, 'AitherOS', 'apps', 'AitherDesktop')}"`,
          startCmd: 'aither-desktop',
          note: 'Native desktop app (PyQt6 + WebView). Win+A hotkey.',
        },
        node: {
          name: 'awnode',
          type: 'MCP server',
          checkCmd: 'pip show awnode',
          healthUrl: 'http://localhost:8090/health',
          installCmd: `pip install -e "${join(repoRoot, 'awnode')}"`,
          startCmd: 'awnode start',
          stopCmd: 'docker compose -f docker-compose.aitheros.yml stop aither-node',
          note: 'MCP tool server (100+ tools). Port 8090.',
        },
        veil: {
          name: 'AitherVeil',
          type: 'Next.js dashboard',
          healthUrl: 'http://localhost:3000',
          startCmd: `docker compose -f "${join(repoRoot, 'docker-compose.aitheros.yml')}" up -d aither-veil`,
          stopCmd: `docker compose -f "${join(repoRoot, 'docker-compose.aitheros.yml')}" stop aither-veil`,
          note: 'Web dashboard at localhost:3000. Always runs in Docker.',
        },
        connect: {
          name: 'Awconnect',
          type: 'Chrome extension',
          note: 'Browser extension. Install from awconnect/ folder via chrome://extensions (Developer mode, Load unpacked).',
        },
        shell: {
          name: 'AitherShell',
          type: 'CLI terminal',
          checkCmd: 'aither --version',
          installCmd: `cd "${join(repoRoot, 'AitherOS', 'apps', 'AitherShell', 'cli')}" && npm run build && npm link`,
          startCmd: 'aither',
          note: 'This CLI. Already running.',
        },
        genesis: {
          name: 'AitherGenesis',
          type: 'System orchestrator',
          healthUrl: 'https://localhost:8001/health',
          startCmd: `docker compose -f "${join(repoRoot, 'docker-compose.aitheros.yml')}" up -d aither-genesis`,
          stopCmd: `docker compose -f "${join(repoRoot, 'docker-compose.aitheros.yml')}" stop aither-genesis`,
          note: 'Core orchestrator. Port 8001. Required for everything.',
        },
        aitherzero: {
          name: 'AitherZero',
          type: 'PowerShell module (187 functions)',
          checkCmd: 'pwsh -NoProfile -c "Import-Module AitherZero -ErrorAction Stop; Get-AitherVersion"',
          installCmd: (() => {
            const moduleDir = join(repoRoot, 'AitherZero');
            // Install to user PSModulePath and import
            return `pwsh -NoProfile -c "${[
              `$dest = Join-Path ($env:PSModulePath -split ';')[0] 'AitherZero'`,
              `if (!(Test-Path $dest)) { New-Item -ItemType SymbolicLink -Path $dest -Target '${moduleDir.replace(/\\/g, '\\\\')}' -Force | Out-Null }`,
              `Import-Module AitherZero -Force`,
              `Write-Host ('AitherZero v' + (Get-AitherVersion) + ' installed to PSModulePath')`,
            ].join('; ')}"`;
          })(),
          note: 'PowerShell 7 automation module. 187 functions, 393 scripts. Use /run to execute.',
        },
      };

      /* ── Helper: check if app is available ────────────────── */
      function checkInstalled(def: AppDef): boolean {
        if (!def.checkCmd) return true; // no check = assume available
        try {
          execSync(def.checkCmd, { stdio: 'pipe', timeout: 5000 });
          return true;
        } catch { return false; }
      }

      async function checkRunning(def: AppDef): Promise<boolean> {
        if (!def.healthUrl) return false;
        try {
          const r = await fetch(def.healthUrl, { signal: AbortSignal.timeout(3000) });
          return r.ok;
        } catch { return false; }
      }

      /* ── Status (default) ─────────────────────────────────── */
      if (action === 'status' || (!app && action !== 'install' && action !== 'start' && action !== 'stop')) {
        const spinner = ora('Checking apps...').start();
        const rows: string[][] = [];

        for (const [key, def] of Object.entries(apps)) {
          const installed = checkInstalled(def);
          const running = await checkRunning(def);
          const status = running
            ? chalk.green('running')
            : installed
              ? chalk.yellow('installed')
              : chalk.dim('not installed');
          rows.push([
            chalk.cyan(key.padEnd(10)),
            def.name,
            def.type,
            status,
          ]);
        }
        spinner.stop();

        console.log();
        console.log(formatTable(['  App', 'Name', 'Type', 'Status'], rows));
        console.log();
        console.log(chalk.dim('  Usage: /apps install <app>  |  /apps start <app>  |  /apps stop <app>'));
        console.log();
        return;
      }

      /* ── Validate app name ────────────────────────────────── */
      if (!app || !apps[app]) {
        const valid = Object.keys(apps).join(', ');
        console.log(chalk.yellow(`  Unknown app "${app || ''}". Available: ${valid}`));
        return;
      }

      const def = apps[app];

      /* ── Install ──────────────────────────────────────────── */
      if (action === 'install') {
        if (!def.installCmd) {
          console.log(chalk.yellow(`  ${def.name} doesn't have an automated installer.`));
          if (def.note) console.log(chalk.dim(`  ${def.note}`));
          return;
        }

        if (checkInstalled(def)) {
          console.log(chalk.green(`  ${def.name} is already installed.`));
          return;
        }

        console.log(chalk.cyan(`  Installing ${def.name}...`));
        console.log(chalk.dim(`  > ${def.installCmd}`));
        try {
          execSync(def.installCmd, { stdio: 'inherit', timeout: 120000 });
          console.log(chalk.green(`\n  ${def.name} installed successfully.`));
        } catch (err: any) {
          console.log(chalk.red(`\n  Install failed: ${err.message}`));
        }
        return;
      }

      /* ── Start ────────────────────────────────────────────── */
      if (action === 'start') {
        if (!def.startCmd) {
          console.log(chalk.yellow(`  ${def.name} can't be started from here.`));
          if (def.note) console.log(chalk.dim(`  ${def.note}`));
          return;
        }

        // Check if already running
        if (await checkRunning(def)) {
          console.log(chalk.green(`  ${def.name} is already running.`));
          return;
        }

        // Docker compose commands run in foreground; native apps in background
        const isDocker = def.startCmd.includes('docker compose');
        console.log(chalk.cyan(`  Starting ${def.name}...`));
        console.log(chalk.dim(`  > ${def.startCmd}`));

        if (isDocker) {
          try {
            execSync(def.startCmd, { stdio: 'inherit', timeout: 120000, cwd: repoRoot });
            console.log(chalk.green(`\n  ${def.name} started.`));
          } catch (err: any) {
            console.log(chalk.red(`\n  Start failed: ${err.message}`));
          }
        } else {
          // Spawn detached for native apps
          const parts = def.startCmd.split(/\s+/);
          const child = spawn(parts[0], parts.slice(1), {
            detached: true,
            stdio: 'ignore',
            shell: true,
          });
          child.unref();
          console.log(chalk.green(`  ${def.name} launched (PID ${child.pid}).`));
        }
        return;
      }

      /* ── Stop ─────────────────────────────────────────────── */
      if (action === 'stop') {
        if (!def.stopCmd) {
          console.log(chalk.yellow(`  ${def.name} can't be stopped from here.`));
          if (def.note) console.log(chalk.dim(`  ${def.note}`));
          return;
        }

        console.log(chalk.cyan(`  Stopping ${def.name}...`));
        console.log(chalk.dim(`  > ${def.stopCmd}`));
        try {
          execSync(def.stopCmd, { stdio: 'inherit', timeout: 60000, cwd: repoRoot });
          console.log(chalk.green(`\n  ${def.name} stopped.`));
        } catch (err: any) {
          console.log(chalk.red(`\n  Stop failed: ${err.message}`));
        }
        return;
      }

      console.log(chalk.yellow(`  Unknown action "${action}". Use: status, install, start, stop`));
    },
  },

  gaming: {
    description: 'Turn AitherOS services on/off (free GPU for gaming)',
    usage: '/gaming [on|off|status|pause]',
    handler: async (client: GenesisClient, args: string) => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
      const script = join(repoRoot, 'scripts', 'Switch-GamingMode.ps1');
      const sub = args.trim().toLowerCase().split(/\s+/)[0] || '';

      // ── Quick status check (no script needed) ──────────
      if (sub === 'status') {
        try {
          const gpu = execSync('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits', {
            encoding: 'utf-8', timeout: 5000,
          }).trim();
          const [used, total] = gpu.split(',').map(s => parseInt(s.trim()));
          const free = total - used;
          const pct = Math.round((used / total) * 100);
          console.log();
          console.log(chalk.bold('  GPU Status'));
          console.log(`  Used:  ${used} MB / ${total} MB (${pct}%)`);
          console.log(`  Free:  ${chalk[free > 20000 ? 'green' : free > 10000 ? 'yellow' : 'red'](`${free} MB`)}`);
          try {
            const containers = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf-8', timeout: 5000 }).trim();
            const count = containers ? containers.split('\n').length : 0;
            console.log(`  Docker: ${count > 0 ? chalk.yellow(`${count} containers running`) : chalk.green('stopped')}`);
          } catch {
            console.log(`  Docker: ${chalk.green('not running')}`);
          }
        } catch {
          console.log(chalk.dim('  nvidia-smi not available'));
        }
        console.log();
        return;
      }

      // ── Lightweight pause (via Genesis API, keeps Docker running) ──
      if (sub === 'light' || sub === 'lite' || sub === 'pause') {
        const spinner = ora('Pausing GPU services via Genesis...').start();
        const result = await client.post('/gaming-mode/on', { reason: 'aither-shell' }) as any;
        spinner.stop();
        if (result?.gaming_mode) {
          console.log(chalk.green.bold('\n  🎮 GPU services paused'));
          console.log(chalk.dim(`  vLLM containers paused — VRAM freed, Docker still running`));
          console.log(chalk.dim(`  Use /gaming on to restore\n`));
        } else {
          console.log(chalk.red('  Could not reach Genesis. Use /gaming off for full shutdown.'));
        }
        return;
      }

      // ── Helper: detect current state ──────────────────────
      const stateFile = join(repoRoot, '.gaming-mode-state.json');
      const isDockerRunning = (): boolean => {
        try {
          const count = execSync('docker ps -q', { encoding: 'utf-8', timeout: 5000 }).trim();
          return count.length > 0;
        } catch {
          return false;
        }
      };
      const servicesDown = existsSync(stateFile) && !isDockerRunning();

      // ── /gaming on [Full|Demo|Core] — Start services ───────
      if (existsSync(script)) {
        if (sub === 'on' || sub === 'start' || sub === 'resume' || sub === 'up') {
          if (isDockerRunning()) {
            console.log(chalk.green.bold('\n  ✅ Services are already running!\n'));
            try {
              const count = execSync('docker ps -q', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n').length;
              console.log(chalk.dim(`  ${count} containers active. Use /gaming status for details.\n`));
            } catch {}
            return;
          }
          const profileArg = args.trim().split(/\s+/).slice(1).join(' ').trim();
          const resumeArgs = ['-NoProfile', '-File', script, '-Resume'];
          if (profileArg) {
            const validStacks = ['full', 'demo', 'core'];
            if (validStacks.includes(profileArg.toLowerCase())) {
              resumeArgs.push('-Stack', profileArg);
              console.log(chalk.cyan(`\n  🚀 Starting ${profileArg} stack...\n`));
            } else {
              console.log(chalk.red(`\n  Unknown stack "${profileArg}". Valid options: Full, Demo, Core\n`));
              return;
            }
          } else {
            console.log(chalk.cyan('\n  🚀 Starting services...\n'));
          }
          const child = spawn('pwsh', resumeArgs, {
            cwd: repoRoot, stdio: 'inherit',
          });
          await new Promise<void>((resolve) => child.on('close', () => resolve()));
          return;
        }

        // ── /gaming off — Shut down for gaming ──────────────────
        if (sub === 'off' || sub === 'stop' || sub === 'down') {
          if (servicesDown) {
            console.log(chalk.yellow.bold('\n  🎮 Services are already stopped!\n'));
            console.log(`  To bring everything back online:`);
            console.log(`    ${chalk.cyan('/gaming on')}             Start previous stack (auto-detected)`);
            console.log(`    ${chalk.cyan('/gaming on Full')}        Start full AitherOS stack`);
            console.log(`    ${chalk.cyan('/gaming on Demo')}        Start demo stack only`);
            console.log(`    ${chalk.cyan('/gaming on Core')}        Start core services only`);
            console.log();
            return;
          }

          console.log(chalk.yellow('\n  🎮 Shutting down for gaming — releasing ALL GPU + RAM...\n'));
          console.log(chalk.dim('  This stops Docker Desktop, WSL, and frees GPU completely.'));
          console.log(chalk.dim('  Bring back with: /gaming on\n'));
          const child = spawn('pwsh', ['-NoProfile', '-File', script, '-SkipCompact'], {
            cwd: repoRoot, stdio: 'inherit',
          });
          await new Promise<void>((resolve) => child.on('close', () => resolve()));
          return;
        }

        // ── /gaming (no args) — smart toggle ─────────────────
        if (sub === '') {
          if (servicesDown) {
            console.log(chalk.yellow.bold('\n  🎮 Services are currently stopped.\n'));
            console.log(`  ${chalk.cyan('/gaming on')}             Start previous stack (auto-detected)`);
            console.log(`  ${chalk.cyan('/gaming on Full')}        Start full AitherOS stack`);
            console.log(`  ${chalk.cyan('/gaming on Demo')}        Start demo stack only`);
            console.log(`  ${chalk.cyan('/gaming on Core')}        Start core services only`);
            console.log();
            console.log(`  ${chalk.cyan('/gaming status')}         Check GPU + Docker status`);
            console.log();
          } else if (isDockerRunning()) {
            console.log(chalk.green.bold('\n  ✅ Services are running.\n'));
            try {
              const count = execSync('docker ps -q', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n').length;
              console.log(chalk.dim(`  ${count} containers active.\n`));
            } catch {}
            console.log(`  ${chalk.cyan('/gaming off')}            Shut down everything for gaming`);
            console.log(`  ${chalk.cyan('/gaming pause')}          Pause GPU services only (keep Docker)`);
            console.log(`  ${chalk.cyan('/gaming status')}         Show GPU + Docker details`);
            console.log();
          } else {
            // Docker not running, no state file
            console.log(chalk.yellow('\n  Services appear to be stopped.\n'));
            console.log(`  ${chalk.cyan('/gaming on')}             Start full stack`);
            console.log(`  ${chalk.cyan('/gaming on Demo')}        Start demo stack`);
            console.log();
          }
          return;
        }
      } else if (sub === 'off' || sub === 'stop' || sub === '') {
        // Fallback to Genesis API if script not found
        const spinner = ora('Stopping GPU services via Genesis...').start();
        const result = await client.post('/gaming-mode/on', { reason: 'aither-shell' }) as any;
        spinner.stop();
        if (result?.gaming_mode) {
          console.log(chalk.green.bold('\n  🎮 Gaming Mode: ON (via Genesis)'));
          console.log(chalk.dim(`  For full GPU release, run: pwsh -File ./scripts/Switch-GamingMode.ps1\n`));
        }
        return;
      }

      // Help
      console.log(chalk.bold('\n  /gaming — Manage AitherOS services\n'));
      console.log(chalk.dim('  Start services:'));
      console.log(`  ${chalk.cyan('/gaming on')}             Start previous stack (auto-detected)`);
      console.log(`  ${chalk.cyan('/gaming on Full')}        Start full AitherOS stack`);
      console.log(`  ${chalk.cyan('/gaming on Demo')}        Start demo stack only`);
      console.log(`  ${chalk.cyan('/gaming on Core')}        Start core services only`);
      console.log();
      console.log(chalk.dim('  Stop services:'));
      console.log(`  ${chalk.cyan('/gaming off')}            Full shutdown (Docker + WSL + GPU freed)`);
      console.log(`  ${chalk.cyan('/gaming pause')}          Pause GPU only (keep Docker running)`);
      console.log();
      console.log(chalk.dim('  Info:'));
      console.log(`  ${chalk.cyan('/gaming status')}         Show GPU + Docker status`);
      console.log();
    },
  },

  // ── Lockbox ───────────────────────────────────────────────────────────

  lockbox: {
    description: 'Manage private content lockbox',
    usage: '/lockbox [status|activate|lock|prompts|models]',
    handler: async (client: GenesisClient, args: string) => {
      const sub = args.trim().toLowerCase().split(/\s+/)[0] || 'status';

      if (sub === 'status' || sub === '') {
        const spinner = ora('Checking lockbox...').start();
        const result = await client.get('/safety/config/lockbox') as any;
        spinner.stop();

        if (result?.success) {
          const icon = result.active ? '🔓' : '🔒';
          console.log();
          console.log(chalk.bold(`  ${icon} Lockbox: ${result.active ? 'Active' : 'Inactive'}`));
          console.log(chalk.dim(`  Safety level: ${result.safety_level || 'unknown'}`));
          console.log(chalk.dim(`  Eligible: ${result.lockbox_eligible ? 'yes' : 'no'}`));
          if (result.prompt_count > 0) {
            console.log(chalk.green(`  Prompts: ${result.prompt_count}`));
            if (result.categories?.length) {
              console.log(chalk.dim(`  Categories: ${result.categories.join(', ')}`));
            }
          }
          console.log();
          if (!result.active && result.lockbox_eligible) {
            console.log(chalk.dim('  Activate: /lockbox activate'));
          } else if (!result.lockbox_eligible) {
            // Naming the tier that would unlock this is itself the disclosure —
            // only spell it out for accounts that have already opted in.
            const adultVisible = await isAdultContentVisible(client);
            console.log(chalk.dim(adultVisible
              ? '  Set unrestricted first: /safety set unrestricted'
              : '  Not available at your current content policy.'));
          }
          console.log();
        } else {
          console.log(chalk.red('  Could not fetch lockbox status'));
        }
        return;
      }

      if (sub === 'activate' || sub === 'unlock' || sub === 'open') {
        const spinner = ora('Activating lockbox...').start();
        const result = await client.post('/safety/config/lockbox/activate') as any;
        spinner.stop();

        if (result?.success) {
          console.log(chalk.green(`\n  🔓 ${result.message}\n`));
        } else {
          console.log(chalk.red(`\n  ❌ ${result?.detail || 'Activation failed'}\n`));
        }
        return;
      }

      if (sub === 'lock' || sub === 'close') {
        const spinner = ora('Locking lockbox...').start();
        const result = await client.put('/safety/config/user', { level: 'professional' }) as any;
        spinner.stop();

        if (result?.success !== false) {
          console.log(chalk.yellow('\n  🔒 Lockbox locked — safety set to professional\n'));
        } else {
          console.log(chalk.red(`\n  Failed: ${result?.detail || 'unknown error'}\n`));
        }
        return;
      }

      if (sub === 'prompts') {
        const spinner = ora('Loading prompts...').start();
        const result = await client.get('/safety/config/lockbox/prompts') as any;
        spinner.stop();

        if (result?.success) {
          console.log();
          console.log(chalk.bold(`  Lockbox Prompts (${result.prompt_count})`));
          console.log(chalk.dim(`  Safety level: ${result.safety_level}`));
          console.log();
          for (const p of (result.prompts || [])) {
            const icon = p.has_content ? '✅' : '🔒';
            const cat = p.category ? chalk.dim(` [${p.category}]`) : '';
            console.log(`  ${icon} ${p.id || p.name || 'unnamed'}${cat}`);
          }
          console.log();
        } else {
          console.log(chalk.red('  Could not load prompts'));
        }
        return;
      }

      if (sub === 'models') {
        const spinner = ora('Loading private models...').start();
        const result = await client.get('/safety/config/lockbox/models') as any;
        spinner.stop();

        if (result?.success) {
          const models = result.models || [];
          const loras = result.loras || [];
          console.log();
          console.log(chalk.bold(`  Private Models (${result.safety_level})`));
          console.log(chalk.dim(`  Checkpoints: ${models.length} | LoRAs: ${loras.length}`));
          console.log();
          for (const m of models) {
            const name = typeof m === 'string' ? m : (m.name || m.id || 'unnamed');
            console.log(chalk.green(`  🎨 ${name}`));
          }
          for (const l of loras) {
            const name = typeof l === 'string' ? l : (l.name || l.id || 'unnamed');
            console.log(chalk.magenta(`  ✨ ${name}`));
          }
          console.log();
        } else {
          console.log(chalk.red('  Could not load private models'));
        }
        return;
      }

      console.log(chalk.bold('\n  /lockbox — Private content lockbox\n'));
      console.log(`  ${chalk.cyan('/lockbox')}              Show lockbox status`);
      console.log(`  ${chalk.cyan('/lockbox activate')}     Activate & seed private prompts`);
      console.log(`  ${chalk.cyan('/lockbox lock')}         Lock (revert to professional)`);
      console.log(`  ${chalk.cyan('/lockbox prompts')}      List available private prompts`);
      console.log(`  ${chalk.cyan('/lockbox models')}       List private models & LoRAs`);
      console.log();
    },
  },

  // ── Safety Management ─────────────────────────────────────────────────

  safety: {
    description: 'Manage safety levels and age verification',
    usage: '/safety [set <level> [--context <ctx>] | levels | adult [on|off] | verify-age <YYYY-MM-DD> | age-status]',
    handler: async (client, args, config) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || '';

      // Helper: colorize a safety level string
      const colorLevel = (level: string): string => {
        const l = level.toLowerCase();
        if (l === 'unrestricted') return chalk.green(level);
        if (l === 'casual') return chalk.yellow(level);
        if (l === 'professional') return chalk.red(level);
        return chalk.white(level);
      };

      // /safety (no args) — show current config
      if (!sub || sub === 'status') {
        const spinner = ora('Fetching safety config...').start();
        const result = await client.get('/safety/config') as any;
        spinner.stop();

        if (result?.success === false && result?.detail) {
          console.log(chalk.red(`\n  Error: ${result.detail}\n`));
          return;
        }

        const level = result?.effective_level || result?.level || 'unknown';
        const baseLevel = result?.base_level || result?.user_level || level;
        const ageVerified = result?.age_verified ?? false;
        const humanVerified = result?.humanity_verified ?? false;

        console.log();
        console.log(chalk.bold('  Safety Configuration'));
        console.log();
        console.log(chalk.bold('  Level:          ') + colorLevel(level));
        if (baseLevel !== level) {
          console.log(chalk.bold('  Base level:     ') + colorLevel(baseLevel));
        }
        console.log(chalk.bold('  Age verified:   ') + (ageVerified
          ? chalk.green('yes') : chalk.dim('no')));
        console.log(chalk.bold('  Human verified: ') + (humanVerified
          ? chalk.green('yes') : chalk.dim('no')));

        // Context overrides
        const overrides = result?.context_overrides || result?.overrides;
        if (overrides && typeof overrides === 'object' && Object.keys(overrides).length > 0) {
          console.log();
          console.log(chalk.bold('  Context Overrides'));
          for (const [ctx, lvl] of Object.entries(overrides)) {
            console.log(`    ${chalk.dim(ctx + ':')} ${colorLevel(String(lvl))}`);
          }
        }

        console.log();
        console.log(chalk.dim('  /safety set <level>              Change safety level'));
        console.log(chalk.dim('  /safety levels                   List available levels'));
        console.log(chalk.dim('  /safety verify-age <YYYY-MM-DD>  Age verification'));
        console.log(chalk.dim('  /safety age-status               Check age verification'));
        console.log();
        return;
      }

      // /safety set <level> [--context <ctx>]
      if (sub === 'set') {
        const level = parts[1];
        if (!level) {
          console.log(chalk.yellow('\n  Usage: /safety set <level> [--context <context>]\n'));
          return;
        }

        // Parse optional --context flag
        let context: string | undefined;
        const ctxIdx = parts.indexOf('--context');
        if (ctxIdx !== -1 && parts[ctxIdx + 1]) {
          context = parts[ctxIdx + 1];
        }

        const body: Record<string, string> = { level };
        if (context) {
          body.context = context;
        }

        const label = context
          ? `Setting safety to ${level} for context "${context}"...`
          : `Setting safety to ${level}...`;
        const spinner = ora(label).start();
        const result = await client.put('/safety/config/user', body) as any;
        spinner.stop();

        if (result?.success === false || result?.detail) {
          console.log(chalk.red(`\n  Error: ${result?.detail || 'Failed to update safety level'}\n`));
          return;
        }

        const effective = result?.effective_level || result?.level || level;
        // Persist into in-memory config so the rest of this session sees it
        if (!context) {
          config.safetyLevel = effective;
        }
        console.log();
        if (context) {
          console.log(chalk.green(`  Safety level set to ${colorLevel(effective)} for context "${context}"`));
        } else {
          console.log(chalk.green(`  Safety level set to `) + colorLevel(effective));
        }
        console.log();
        return;
      }

      // /safety verify-age <YYYY-MM-DD>
      if (sub === 'verify-age') {
        const dob = parts[1];
        if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
          console.log(chalk.yellow('\n  Usage: /safety verify-age <YYYY-MM-DD>\n'));
          console.log(chalk.dim('  Example: /safety verify-age 1990-05-15'));
          console.log();
          return;
        }

        const spinner = ora('Verifying age...').start();
        const result = await client.post('/safety/config/user/verify-age', {
          date_of_birth: dob,
        }) as any;
        spinner.stop();

        if (result?.success === false || result?.error) {
          console.log(chalk.red(`\n  Error: ${result?.detail || result?.error || 'Age verification failed'}\n`));
          return;
        }

        const verified = result?.age_verified ?? result?.verified ?? false;
        console.log();
        if (verified) {
          console.log(chalk.green('  Age verified successfully'));
        } else {
          console.log(chalk.yellow(`  Age verification: ${result?.message || result?.reason || 'not verified'}`));
        }
        console.log();
        return;
      }

      // /safety age-status
      if (sub === 'age-status') {
        const spinner = ora('Checking age status...').start();
        const result = await client.get('/safety/config/user/age-status') as any;
        spinner.stop();

        if (result?.success === false && result?.detail) {
          console.log(chalk.red(`\n  Error: ${result.detail}\n`));
          return;
        }

        const verified = result?.age_verified ?? false;
        const tier = result?.age_tier || result?.tier || '';

        console.log();
        console.log(chalk.bold('  Age Verification Status'));
        console.log();
        console.log(chalk.bold('  Verified: ') + (verified
          ? chalk.green('yes') : chalk.red('no')));
        if (tier) {
          console.log(chalk.bold('  Tier:     ') + chalk.white(tier));
        }
        if (result?.verified_at) {
          console.log(chalk.bold('  Date:     ') + chalk.dim(result.verified_at));
        }
        console.log();
        if (!verified) {
          console.log(chalk.dim('  Verify: /safety verify-age <YYYY-MM-DD>'));
          console.log();
        }
        return;
      }

      // /safety adult [on|off] — the disclosure switch. Nothing else in the
      // shell names an adult tier or model until this is on AND age is verified.
      if (sub === 'adult') {
        const verb = (parts[1] || '').toLowerCase();

        if (!verb || verb === 'status') {
          const result = await client.get('/safety/config/user/adult-content') as any;
          const optIn = result?.adult_content_opt_in === true;
          const visible = result?.adult_content_visible === true;
          const ageOk = result?.age_verified === true;
          console.log();
          console.log(chalk.bold('  Adult content: ') + (visible
            ? chalk.yellow('on') : chalk.dim('off')));
          if (optIn && !ageOk) {
            console.log(chalk.dim('  Waiting on age verification — /safety verify-age <YYYY-MM-DD>'));
          }
          console.log(chalk.dim(`  Turn ${visible ? 'off' : 'on'}: /safety adult ${visible ? 'off' : 'on'}`));
          console.log();
          return;
        }

        if (verb !== 'on' && verb !== 'off') {
          console.log(chalk.yellow('\n  Usage: /safety adult [on|off]\n'));
          return;
        }

        const enabled = verb === 'on';
        const spinner = ora(`Turning adult content ${verb}...`).start();
        const result = await client.put('/safety/config/user/adult-content', { enabled }) as any;
        spinner.stop();
        invalidateAdultGate();

        if (result?.success !== true) {
          console.log(chalk.red(`\n  ${result?.detail || 'Could not update adult content setting'}`));
          if (result?.detail && /age/i.test(String(result.detail))) {
            console.log(chalk.dim('  Verify first: /safety verify-age <YYYY-MM-DD>'));
          }
          console.log();
          return;
        }

        console.log(chalk.green(`\n  Adult content ${result.adult_content_visible ? 'enabled' : 'turned off'}`));
        if (!enabled) {
          console.log(chalk.dim(`  Content policy reset to ${result.default_level}.`));
        }
        console.log();
        return;
      }

      // /safety levels
      if (sub === 'levels') {
        const spinner = ora('Fetching safety levels...').start();
        const result = await client.get('/safety/config/levels') as any;
        spinner.stop();

        if (result?.success === false && result?.detail) {
          console.log(chalk.red(`\n  Error: ${result.detail}\n`));
          return;
        }

        const levels = result?.levels || result;

        console.log();
        console.log(chalk.bold('  Available Safety Levels'));
        console.log();

        if (Array.isArray(levels)) {
          for (const lv of levels) {
            const name = typeof lv === 'string' ? lv : (lv.name || lv.id || 'unknown');
            const desc = typeof lv === 'object' ? (lv.description || '') : '';
            console.log(`  ${colorLevel(name)}${desc ? chalk.dim(' — ' + desc) : ''}`);
          }
        } else if (typeof levels === 'object') {
          for (const [name, info] of Object.entries(levels)) {
            const desc = typeof info === 'object' && info !== null
              ? ((info as any).description || '') : String(info || '');
            console.log(`  ${colorLevel(name)}${desc ? chalk.dim(' — ' + desc) : ''}`);
          }
        }
        console.log();
        return;
      }

      // Unknown subcommand — show usage
      console.log(chalk.bold('\n  /safety — Safety management\n'));
      console.log(`  ${chalk.cyan('/safety')}                          Show current safety config`);
      console.log(`  ${chalk.cyan('/safety set <level>')}              Set safety level`);
      console.log(`  ${chalk.cyan('/safety set <level> --context <c>')} Set per-context override`);
      console.log(`  ${chalk.cyan('/safety levels')}                   List available levels`);
      console.log(`  ${chalk.cyan('/safety adult [on|off]')}           Show or hide adult content`);
      console.log(`  ${chalk.cyan('/safety verify-age <YYYY-MM-DD>')} Verify age`);
      console.log(`  ${chalk.cyan('/safety age-status')}               Check age verification`);
      console.log();
    },
  },

  profile: {
    description: 'Show user profile summary',
    handler: async (client) => {
      const spinner = ora('Fetching profile...').start();

      const [safetyResult, ageResult] = await Promise.all([
        client.get('/safety/config') as Promise<any>,
        client.get('/safety/config/user/age-status') as Promise<any>,
      ]);
      spinner.stop();

      // Helper: colorize a safety level string
      const colorLevel = (level: string): string => {
        const l = level.toLowerCase();
        if (l === 'unrestricted') return chalk.green(level);
        if (l === 'casual') return chalk.yellow(level);
        if (l === 'professional') return chalk.red(level);
        return chalk.white(level);
      };

      const level = safetyResult?.effective_level || safetyResult?.level || 'unknown';
      const ageVerified = ageResult?.age_verified ?? safetyResult?.age_verified ?? false;
      const humanVerified = safetyResult?.humanity_verified ?? false;
      const ageTier = ageResult?.age_tier || ageResult?.tier || '';

      console.log();
      console.log(chalk.bold('  User Profile'));
      console.log();
      console.log(chalk.bold('  Safety level:   ') + colorLevel(level));
      console.log(chalk.bold('  Age verified:   ') + (ageVerified
        ? chalk.green('yes') + (ageTier ? chalk.dim(` (${ageTier})`) : '')
        : chalk.red('no')));
      console.log(chalk.bold('  Human verified: ') + (humanVerified
        ? chalk.green('yes') : chalk.dim('no')));

      // Context overrides summary
      const overrides = safetyResult?.context_overrides || safetyResult?.overrides;
      if (overrides && typeof overrides === 'object') {
        const count = Object.keys(overrides).length;
        if (count > 0) {
          console.log(chalk.bold('  Overrides:      ') + chalk.dim(`${count} context-specific`));
        }
      }

      console.log();
      console.log(chalk.dim('  /safety           Full safety configuration'));
      console.log(chalk.dim('  /safety set ...   Change safety level'));
      console.log(chalk.dim('  /lockbox          Private content lockbox'));
      console.log();
    },
  },

  run: {
    description: 'Run an AitherZero PowerShell function',
    usage: '/run <Function-Name> [args...]  or  /run list [filter]',
    handler: async (_client, args) => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
      const moduleFile = join(repoRoot, 'AitherZero', 'AitherZero.psd1');

      if (!existsSync(moduleFile)) {
        console.log(chalk.red('  AitherZero module not found at expected path.'));
        console.log(chalk.dim(`  Expected: ${moduleFile}`));
        return;
      }

      const parts = args.trim().split(/\s+/);
      const sub = parts[0];

      if (!sub) {
        console.log(chalk.bold('\n  /run — Execute AitherZero PowerShell functions\n'));
        console.log(chalk.dim('  Usage:'));
        console.log(`    ${chalk.cyan('/run list')}                  List all available functions`);
        console.log(`    ${chalk.cyan('/run list scale')}            Filter functions by keyword`);
        console.log(`    ${chalk.cyan('/run Get-AitherStatus')}      Run a function`);
        console.log(`    ${chalk.cyan('/run Get-AitherContainer')}   Run with default params`);
        console.log(`    ${chalk.cyan('/run Invoke-AitherScript 0850_Switch-GpuProfile -Profile gaming')}`);
        console.log();
        return;
      }

      /* ── List functions ─────────────────────────────────── */
      if (sub === 'list' || sub === 'ls') {
        const filter = parts[1] || '';
        const spinner = ora('Loading AitherZero functions...').start();
        try {
          const cmd = filter
            ? `pwsh -NoProfile -c "Import-Module '${moduleFile}' -Force; (Get-Command -Module AitherZero).Name | Where-Object { $_ -match '${filter}' } | Sort-Object"`
            : `pwsh -NoProfile -c "Import-Module '${moduleFile}' -Force; (Get-Command -Module AitherZero).Name | Sort-Object"`;
          const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim();
          spinner.stop();

          if (!output) {
            console.log(chalk.dim(`  No functions matching "${filter}"`));
            return;
          }

          const funcs = output.split(/\r?\n/);
          console.log(chalk.bold(`\n  AitherZero Functions${filter ? ` (matching "${filter}")` : ''}: ${funcs.length}\n`));

          // Group by verb
          const groups: Record<string, string[]> = {};
          for (const f of funcs) {
            const verb = f.split('-')[0] || 'Other';
            (groups[verb] ??= []).push(f);
          }

          for (const [verb, names] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
            console.log(chalk.bold(`  ${verb}-*`));
            for (const name of names) {
              console.log(`    ${chalk.cyan(name)}`);
            }
          }
          console.log();
        } catch (err: any) {
          spinner.stop();
          console.log(chalk.red(`  Failed to list functions: ${err.message}`));
          console.log(chalk.dim('  Is PowerShell 7 (pwsh) installed?'));
        }
        return;
      }

      /* ── Run function ───────────────────────────────────── */
      const funcName = sub;
      const funcArgs = parts.slice(1).join(' ');

      console.log(chalk.cyan(`  > ${funcName} ${funcArgs}`));
      console.log();

      try {
        const pwshCmd = funcArgs
          ? `Import-Module '${moduleFile}' -Force; ${funcName} ${funcArgs}`
          : `Import-Module '${moduleFile}' -Force; ${funcName}`;

        execSync(`pwsh -NoProfile -c "${pwshCmd}"`, {
          stdio: 'inherit',
          timeout: 300000, // 5 min for long-running scripts
          cwd: repoRoot,
        });
      } catch (err: any) {
        if (err.status) {
          console.log(chalk.yellow(`\n  Exited with code ${err.status}`));
        } else {
          console.log(chalk.red(`\n  Error: ${err.message}`));
        }
      }
    },
  },

  script: {
    description: 'Run a numbered AitherZero automation script',
    usage: '/script <number_or_name> [args...]  or  /script list [filter]',
    handler: async (_client, args) => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
      const scriptsDir = join(repoRoot, 'AitherZero', 'library', 'automation-scripts');

      if (!existsSync(scriptsDir)) {
        console.log(chalk.red('  AitherZero scripts directory not found.'));
        return;
      }

      const parts = args.trim().split(/\s+/);
      const sub = parts[0];

      if (!sub || sub === 'list' || sub === 'ls') {
        const filter = (sub === 'list' || sub === 'ls') ? (parts[1] || '') : '';
        const spinner = ora('Scanning scripts...').start();
        try {
          // Find all .ps1 scripts recursively, excluding _archive and _init
          const findCmd = `pwsh -NoProfile -c "Get-ChildItem '${scriptsDir}' -Recurse -Filter '*.ps1' | Where-Object { $_.Name -notmatch '^_' -and $_.Directory.Name -ne '_archive' ${filter ? `-and $_.Name -match '${filter}'` : ''} } | Sort-Object Name | ForEach-Object { '{0,-50} {1}' -f $_.Name, $_.Directory.Name }"`;
          const output = execSync(findCmd, { encoding: 'utf-8', timeout: 10000 }).trim();
          spinner.stop();

          if (!output) {
            console.log(chalk.dim(`  No scripts found${filter ? ` matching "${filter}"` : ''}`));
            return;
          }

          const lines = output.split(/\r?\n/);
          console.log(chalk.bold(`\n  AitherZero Scripts${filter ? ` (matching "${filter}")` : ''}: ${lines.length}\n`));
          for (const line of lines) {
            const [name, ...rest] = line.trim().split(/\s{2,}/);
            const dir = rest.join(' ') || '';
            console.log(`  ${chalk.cyan(name?.trim() || '')}  ${chalk.dim(dir)}`);
          }
          console.log();
          console.log(chalk.dim('  Usage: /script 0850_Switch-GpuProfile -Profile gaming'));
          console.log();
        } catch (err: any) {
          spinner.stop();
          console.log(chalk.red(`  Error: ${err.message}`));
        }
        return;
      }

      /* ── Run script by number or name ───────────────────── */
      const scriptPattern = sub;
      const scriptArgs = parts.slice(1).join(' ');

      const spinner = ora(`Finding script "${scriptPattern}"...`).start();
      try {
        // Find the script file
        const findCmd = `pwsh -NoProfile -c "Get-ChildItem '${scriptsDir}' -Recurse -Filter '*.ps1' | Where-Object { $_.Name -match '${scriptPattern}' -and $_.Name -notmatch '^_' } | Select-Object -First 1 -ExpandProperty FullName"`;
        const scriptPath = execSync(findCmd, { encoding: 'utf-8', timeout: 5000 }).trim();
        spinner.stop();

        if (!scriptPath) {
          console.log(chalk.red(`  No script matching "${scriptPattern}" found.`));
          return;
        }

        const scriptName = scriptPath.split(/[/\\]/).pop() || scriptPattern;
        console.log(chalk.cyan(`  > ${scriptName} ${scriptArgs}`));
        console.log();

        execSync(`pwsh -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" ${scriptArgs}`, {
          stdio: 'inherit',
          timeout: 300000,
          cwd: repoRoot,
        });
      } catch (err: any) {
        spinner.stop();
        if (err.status) {
          console.log(chalk.yellow(`\n  Exited with code ${err.status}`));
        } else {
          console.log(chalk.red(`\n  Error: ${err.message}`));
        }
      }
    },
  },

  /* ────────────────────────────────────────────────────────────────────
   * NEW COMMANDS — wired to actual Genesis endpoints
   * ──────────────────────────────────────────────────────────────────── */

  memory: {
    description: 'Recall, store, or forget a memory',
    usage: '/memory recall <query>  |  /memory remember <text>  |  /memory forget <text>',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || '').toLowerCase();
      const text = parts.slice(1).join(' ');

      if (sub === 'remember' && text) {
        const spinner = ora('Storing memory...').start();
        const result = await client.post('/memory/remember', { text, source: 'aither-shell' });
        spinner.stop();
        console.log(result?.stored ? chalk.green('  Memory stored.') : chalk.yellow('  ' + (result?.message || 'Could not store.')));
      } else if (sub === 'recall' && text) {
        const spinner = ora('Recalling...').start();
        const result = await client.post('/memory/recall', { query: text, limit: 5 });
        spinner.stop();
        const memories = result?.memories || result?.results || [];
        if (!memories.length) { console.log(chalk.dim('  No memories found.')); return; }
        console.log();
        for (const m of memories) {
          const score = m.score ? chalk.dim(` (${(m.score * 100).toFixed(0)}%)`) : '';
          console.log(`  ${chalk.cyan('\u2022')} ${m.content || m.text || m.memory || JSON.stringify(m)}${score}`);
        }
        console.log();
      } else if (sub === 'forget' && text) {
        // Cross-tier hard-delete: removes every copy of memories CONTAINING this
        // phrase (Spirit, Nexus, WorkingMemory, graph). Be specific.
        const spinner = ora('Forgetting...').start();
        const result = await client.post('/external/memory/forget', { content_match: text });
        spinner.stop();
        if (result?.error || result?.detail) {
          console.log(chalk.yellow('  ' + (result.error || result.detail)));
          return;
        }
        const total = result?.total ?? 0;
        console.log(total > 0
          ? chalk.green(`  Forgot ${total} ${total === 1 ? 'memory' : 'memories'} matching "${text}".`)
          : chalk.dim(`  No memories matched "${text}".`));
        const tiers = ['spirit', 'nexus', 'workingmemory', 'graph']
          .filter((t) => result?.[t]).map((t) => `${t}:${result[t]}`);
        if (tiers.length) console.log(chalk.dim('  ' + tiers.join('  ')));
      } else {
        console.log(chalk.dim('  Usage: /memory recall <query>  |  /memory remember <text>  |  /memory forget <text>'));
      }
    },
  },

  search: {
    description: 'Search code, docs, and web',
    usage: '/search <query>',
    handler: async (client: GenesisClient, args: string) => {
      if (!args.trim()) { console.log(chalk.dim('  Usage: /search <query>')); return; }
      const spinner = ora('Searching...').start();
      const result = await client.post('/v2/intelligent-route', {
        query: args.trim(),
        search_type: 'unified',
      });
      spinner.stop();
      const results = result?.results || result?.items || [];
      if (!results.length) { console.log(chalk.dim('  No results.')); return; }
      console.log();
      for (const r of results.slice(0, 10)) {
        const title = r.title || r.name || r.path || '';
        const snippet = r.snippet || r.content || r.description || '';
        console.log(`  ${chalk.cyan(title)}`);
        if (snippet) console.log(`  ${chalk.dim(snippet.slice(0, 120))}`);
        console.log();
      }
    },
  },

  context: {
    description: 'Show context pipeline layers',
    usage: '/context [dashboard|layers|snapshot]',
    handler: async (client: GenesisClient, args: string) => {
      const sub = args.trim().toLowerCase() || 'layers';
      const endpoint = sub === 'dashboard' ? '/context/dashboard'
        : sub === 'snapshot' ? '/context/snapshot/latest'
        : '/context/layers';
      const spinner = ora('Fetching context...').start();
      const result = await client.get(endpoint);
      spinner.stop();
      if (!result) { console.log(chalk.dim('  No context data.')); return; }
      console.log();
      if (result.layers) {
        for (const l of result.layers) {
          const name = l.name || l.layer || '?';
          const tokens = l.tokens || l.token_count || 0;
          console.log(`  ${chalk.cyan(name.padEnd(20))} ${tokens} tokens`);
        }
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      console.log();
    },
  },

  tools: {
    description: 'List available MCP tools',
    usage: '/tools [filter]',
    handler: async (client: GenesisClient, args: string) => {
      const spinner = ora('Fetching tools...').start();
      const result = await client.get('/tools');
      spinner.stop();
      let tools = result?.tools || [];
      if (args.trim()) {
        const filter = args.trim().toLowerCase();
        tools = tools.filter((t: any) => {
          const name = typeof t === 'string' ? t : (t.name || '');
          return name.toLowerCase().includes(filter);
        });
      }
      if (!tools.length) { console.log(chalk.dim('  No tools found.')); return; }
      console.log(chalk.bold(`\n  MCP Tools: ${tools.length}\n`));
      for (const t of tools.slice(0, 40)) {
        const name = typeof t === 'string' ? t : (t.name || '?');
        const desc = typeof t === 'object' ? (t.description || '') : '';
        console.log(`  ${chalk.cyan(name)}${desc ? chalk.dim(' — ' + desc.slice(0, 60)) : ''}`);
      }
      if (tools.length > 40) console.log(chalk.dim(`\n  ... and ${tools.length - 40} more`));
      console.log();
    },
  },

  codegraph: {
    description: 'Search code via CodeGraph',
    usage: '/codegraph <query>',
    handler: async (client: GenesisClient, args: string) => {
      if (!args.trim()) { console.log(chalk.dim('  Usage: /codegraph <query>')); return; }
      const spinner = ora('Searching CodeGraph...').start();
      const result = await client.get(`/codegraph/search?q=${encodeURIComponent(args.trim())}&limit=10`);
      spinner.stop();
      const results = result?.results || [];
      if (!results.length) { console.log(chalk.dim('  No results.')); return; }
      console.log();
      for (const r of results) {
        const file = r.file || r.path || '';
        const line = r.line ? `:${r.line}` : '';
        const snippet = r.content || r.snippet || '';
        console.log(`  ${chalk.cyan(file + line)}`);
        if (snippet) console.log(`  ${chalk.dim(snippet.slice(0, 120))}`);
        console.log();
      }
    },
  },

  soul: {
    description: 'Load or list personality souls',
    usage: '/soul [list|load <name>|active]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().toLowerCase().split(/\s+/);
      const sub = parts[0] || 'active';

      if (sub === 'list') {
        const spinner = ora('Fetching souls...').start();
        const result = await client.get('/soul');
        spinner.stop();
        const souls = result?.souls || result?.available || [];
        if (!souls.length) { console.log(chalk.dim('  No souls available.')); return; }
        console.log();
        for (const s of souls) {
          const name = typeof s === 'string' ? s : (s.name || s.id || '?');
          const active = (typeof s === 'object' && s.active) ? chalk.green(' (active)') : '';
          console.log(`  ${chalk.cyan(name)}${active}`);
        }
        console.log();
      } else if (sub === 'load' && parts[1]) {
        const spinner = ora(`Loading soul "${parts[1]}"...`).start();
        const result = await client.post('/soul/load', { name: parts[1] });
        spinner.stop();
        console.log(result?.loaded ? chalk.green(`  Soul "${parts[1]}" loaded.`) : chalk.yellow('  ' + (result?.error || 'Could not load.')));
      } else {
        const result = await client.get('/soul/active');
        const active = result?.soul || result?.active || result?.name || 'none';
        console.log(chalk.bold('  Active soul: ') + chalk.cyan(typeof active === 'string' ? active : active.name || 'none'));
      }
    },
  },

  inbox: {
    description: 'Check agent inbox and delegations',
    usage: '/inbox [agent_name]',
    handler: async (client: GenesisClient, args: string) => {
      const agent = args.trim() || 'admin';
      const spinner = ora('Checking inbox...').start();
      const endpoint = agent === 'admin' ? '/inbox/admin' : `/inbox/${agent}`;
      const result = await client.get(endpoint);
      spinner.stop();
      const messages = result?.messages || result?.items || result?.inbox || [];
      if (!messages.length) { console.log(chalk.dim(`  Inbox empty for ${agent}.`)); return; }
      console.log(chalk.bold(`\n  Inbox (${agent}): ${messages.length} messages\n`));
      for (const m of messages.slice(0, 15)) {
        const from = m.from || m.sender || '?';
        const subject = m.subject || m.task || m.message || '';
        const status = m.status ? chalk.dim(` [${m.status}]`) : '';
        console.log(`  ${chalk.cyan(from)} ${subject}${status}`);
      }
      console.log();
    },
  },

  metrics: {
    description: 'Show system metrics summary',
    handler: async (client) => {
      const spinner = ora('Fetching metrics...').start();
      const result = await client.get('/monitoring/dashboard');
      spinner.stop();
      if (!result) { console.log(chalk.dim('  No metrics available.')); return; }

      console.log();
      const host = result.host || {};
      if (host.cpu_percent != null) console.log(chalk.bold('  CPU:     ') + `${host.cpu_percent}%`);
      if (host.memory_percent != null) console.log(chalk.bold('  Memory:  ') + `${host.memory_percent}%`);
      if (host.disk_percent != null) console.log(chalk.bold('  Disk:    ') + `${host.disk_percent}%`);
      if (host.gpu_memory_percent != null) console.log(chalk.bold('  GPU:     ') + `${host.gpu_memory_percent}%`);

      const status = result.status || {};
      if (status.metrics_tracked) console.log(chalk.bold('  Tracked: ') + `${status.metrics_tracked} metrics`);

      const insights = result.insights || [];
      if (insights.length) {
        console.log(chalk.bold(`\n  Insights (${insights.length}):`));
        for (const i of insights.slice(0, 5)) {
          console.log(`  ${chalk.dim('\u2022')} ${i.message || i.text || i}`);
        }
      }
      console.log();
    },
  },

  swarm: {
    description: 'Dispatch task to swarm coding engine',
    usage: '/swarm <task description> [--mode forge|llm|plan_only]',
    handler: async (client: GenesisClient, args: string) => {
      let task = args;
      let mode = 'llm';
      const modeMatch = args.match(/--mode\s+(\S+)/);
      if (modeMatch) { mode = modeMatch[1]; task = task.replace(modeMatch[0], ''); }
      task = task.replace(/^["']|["']$/g, '').trim();

      if (!task) { console.log(chalk.dim('  Usage: /swarm <task> [--mode forge|llm|plan_only]')); return; }

      const spinner = ora(`Swarm coding (${mode})...`).start();
      const result = await client.post('/swarm/code/sync', { problem: task, mode });
      spinner.stop();

      if (result?.error) { console.log(chalk.red(`  Error: ${result.error}`)); return; }
      const output = result?.result || result?.plan || result?.response;
      if (output) { console.log(); console.log(typeof output === 'string' ? output : JSON.stringify(output, null, 2)); console.log(); }
      else { console.log(JSON.stringify(result, null, 2)); }
    },
  },

  fleet: {
    description: 'Manage GPU fleet',
    usage: '/fleet [status|launch|drain <id>]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'status').toLowerCase();

      if (sub === 'status') {
        const spinner = ora('Fetching fleet status...').start();
        const result = await client.get('/fleet/pool/status');
        spinner.stop();
        if (!result) { console.log(chalk.dim('  Fleet service not available.')); return; }
        console.log();
        console.log(chalk.bold('  GPU Fleet'));
        const pool = result.pool || result;
        if (pool.total_workers != null) console.log(`  Workers: ${pool.active_workers || 0}/${pool.total_workers} active`);
        if (pool.pending_tasks != null) console.log(`  Pending: ${pool.pending_tasks} tasks`);
        if (pool.gpu_memory_gb != null) console.log(`  VRAM:    ${pool.gpu_memory_gb} GB`);
        console.log();
      } else if (sub === 'launch') {
        const task = parts.slice(1).join(' ') || 'default';
        const spinner = ora('Launching fleet session...').start();
        const result = await client.post('/fleet/launch', { task, mode: 'auto' });
        spinner.stop();
        console.log(result?.session_id ? chalk.green(`  Launched: ${result.session_id}`) : chalk.yellow('  ' + (result?.error || 'Launch failed.')));
      } else if (sub === 'drain' && parts[1]) {
        const spinner = ora(`Draining ${parts[1]}...`).start();
        const result = await client.post('/fleet/drain', { session_id: parts[1] });
        spinner.stop();
        console.log(result?.drained ? chalk.green('  Drained.') : chalk.yellow('  ' + (result?.error || 'Drain failed.')));
      } else {
        console.log(chalk.dim('  Usage: /fleet [status|launch|drain <id>]'));
      }
    },
  },

  node: {
    description: 'Onboard and manage mesh compute nodes',
    usage: '/node [ls|enroll [--tenant <t>] [--ttl <hours>] [--label <l>]|rm <id>]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = parseQuotedArgs(args.trim());
      const sub = (parts[0] || 'ls').toLowerCase();
      const flag = (...names: string[]): string | undefined => {
        for (const n of names) { const i = parts.indexOf(n); if (i >= 0 && parts[i + 1]) return parts[i + 1]; }
        return undefined;
      };

      // The gateway node registry is reachable through the public Cloudflare
      // tunnel; GET /nodes is open (no auth), so `ls` always works. Minting and
      // removal are internal-key gated → routed server-side via the MCP tools.
      const clusterUrl = (process.env.AITHER_CLUSTER_URL || 'https://cluster.aitherium.com').replace(/\/+$/, '');

      if (sub === 'ls' || sub === 'list') {
        const tenant = flag('--tenant', '-t') || '';
        const spinner = ora('Listing mesh nodes...').start();
        let nodes: any[] = [];
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 12000);
        try {
          const r = await fetch(`${clusterUrl}/nodes${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`,
            { signal: ac.signal });
          if (r.ok) nodes = (await r.json())?.nodes || [];
          else { spinner.stop(); console.log(chalk.red(`  Gateway returned ${r.status}`)); return; }
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Gateway unreachable: ${e?.message || e}`)); return; }
        finally { clearTimeout(t); }
        spinner.stop();
        if (!nodes.length) { console.log(chalk.dim('  No mesh nodes registered.')); return; }
        console.log();
        console.log(chalk.bold('  Mesh Nodes'));
        for (const n of nodes) {
          const hw = n.hardware || {};
          const dot = n.status === 'online' ? chalk.green('●') : chalk.red('●');
          const gpu = hw.gpu || n.gpu || '—';
          const memVal = typeof hw.memory_gb === 'number' ? hw.memory_gb : n.memory_gb;
          const mem = typeof memVal === 'number' ? `${Math.round(memVal)}GB` : '—';
          const ctr = (n.services?.length ?? n.containers?.length ?? n.containers ?? 0);
          const ten = (n.tenant || n.labels?.tenant) ? chalk.dim(` tenant=${n.tenant || n.labels?.tenant}`) : '';
          console.log(`  ${dot} ${chalk.cyan(n.name || n.node_id)}  ${chalk.dim(gpu)}  ${mem}  ${ctr} ctr${ten}`);
        }
        console.log();
      } else if (sub === 'enroll' || sub === 'mint') {
        const tenant = flag('--tenant', '-t') || '';
        const ttlH = parseFloat(flag('--ttl') || '1') || 1;
        const label = flag('--label', '-l') || '';
        const spinner = ora('Minting enrollment token...').start();
        const out = await invokeMcpTool(client, 'mint_node_token', {
          ttl_seconds: Math.round(ttlH * 3600), label, tenant,
        });
        spinner.stop();
        if (out?.error || out?.success === false) { console.log(chalk.red('  ' + (out?.error || 'mint failed'))); return; }
        console.log();
        console.log(chalk.green('  ✓ Enrollment token minted') + chalk.dim(`  (single-use${tenant ? `, tenant=${tenant}` : ''})`));
        console.log(chalk.bold('\n  Run this on the target node:'));
        console.log('  ' + chalk.cyan(out.install_command || out.install || ''));
        console.log(chalk.dim('\n  It registers through the tunnel, installs a reboot-safe service, and starts heartbeating.'));
        console.log();
      } else if (sub === 'rm' || sub === 'remove') {
        const id = parts[1];
        if (!id) { console.log(chalk.dim('  Usage: /node rm <id|name>')); return; }
        const spinner = ora(`Removing ${id}...`).start();
        const out = await invokeMcpTool(client, 'remove_cluster_node', { node_id: id });
        spinner.stop();
        if (out?.error || out?.success === false) { console.log(chalk.yellow('  ' + (out?.error || 'remove failed'))); return; }
        console.log(chalk.green(`  ✓ Removed ${out.name || id}`) + chalk.dim(`  (${out.remaining ?? '?'} remaining)`));
      } else {
        console.log(chalk.dim('  Usage: /node [ls | enroll [--tenant <t>] [--ttl <hours>] | rm <id>]'));
      }
    },
  },

  workflow: {
    description: 'List or run workflows',
    usage: '/workflow [list|run <id>|create <yaml_path>]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'list').toLowerCase();

      if (sub === 'list') {
        const spinner = ora('Fetching workflows...').start();
        const result = await client.get('/workflows');
        spinner.stop();
        const workflows = result?.workflows || [];
        if (!workflows.length) { console.log(chalk.dim('  No workflows.')); return; }
        console.log();
        for (const w of workflows) {
          const name = w.name || w.id || '?';
          const status = w.status ? chalk.dim(` [${w.status}]`) : '';
          console.log(`  ${chalk.cyan(name)}${status}  ${chalk.dim(w.description || '')}`);
        }
        console.log();
      } else if (sub === 'run' && parts[1]) {
        const spinner = ora(`Running workflow ${parts[1]}...`).start();
        const result = await client.post(`/workflows/${parts[1]}/execute`, {});
        spinner.stop();
        console.log(result?.run_id ? chalk.green(`  Started: ${result.run_id}`) : chalk.yellow('  ' + (result?.error || 'Run failed.')));
      } else {
        console.log(chalk.dim('  Usage: /workflow [list|run <id>]'));
      }
    },
  },

  benchmark: {
    description: 'Run or view model benchmarks',
    usage: '/benchmark [run|history]',
    handler: async (client: GenesisClient, args: string) => {
      const sub = (args.trim() || 'history').toLowerCase();
      if (sub === 'run') {
        const spinner = ora('Starting benchmark...').start();
        const result = await client.post('/benchmark/standard/run', {});
        spinner.stop();
        console.log(result?.benchmark_id ? chalk.green(`  Benchmark started: ${result.benchmark_id}`) : chalk.yellow('  ' + (result?.error || 'Could not start.')));
      } else {
        const spinner = ora('Fetching benchmark history...').start();
        const result = await client.get('/benchmark/standard/history');
        spinner.stop();
        const runs = result?.benchmarks || result?.history || [];
        if (!runs.length) { console.log(chalk.dim('  No benchmark history.')); return; }
        console.log();
        for (const r of runs.slice(0, 10)) {
          const date = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';
          const model = r.model || '?';
          const score = r.score != null ? chalk.cyan(`${r.score}`) : '';
          console.log(`  ${chalk.dim(date)} ${model} ${score}`);
        }
        console.log();
      }
    },
  },

  review: {
    description: 'Submit code for review',
    usage: '/review [diff|file <path>]',
    handler: async (client: GenesisClient, args: string) => {
      const sub = args.trim() || 'diff';
      const spinner = ora('Submitting for review...').start();
      const result = await client.post('/reviews', { type: sub.startsWith('file') ? 'file' : 'diff', target: sub });
      spinner.stop();
      if (result?.review_id) {
        console.log(chalk.green(`  Review created: ${result.review_id}`));
        if (result.summary) console.log(`\n${result.summary}`);
      } else {
        console.log(chalk.yellow('  ' + (result?.error || 'Review service not available.')));
      }
    },
  },

  backup: {
    description: 'Create or list backups',
    usage: '/backup [list|now]',
    handler: async (client: GenesisClient, args: string) => {
      const sub = (args.trim() || 'list').toLowerCase();
      if (sub === 'now') {
        const spinner = ora('Creating backup...').start();
        const result = await client.post('/backup/now', {});
        spinner.stop();
        console.log(result?.backup_id ? chalk.green(`  Backup created: ${result.backup_id}`) : chalk.yellow('  ' + (result?.error || 'Backup failed.')));
      } else {
        const spinner = ora('Fetching backups...').start();
        const result = await client.get('/backup/schedule');
        spinner.stop();
        const backups = result?.backups || result?.schedules || [];
        if (!backups.length) { console.log(chalk.dim('  No backups found.')); return; }
        console.log();
        for (const b of backups.slice(0, 10)) {
          console.log(`  ${chalk.cyan(b.id || b.name || '?')} ${chalk.dim(b.timestamp || b.created || '')} ${b.status || ''}`);
        }
        console.log();
      }
    },
  },

  grid: {
    description: 'Manage grid distributed inference nodes',
    usage: '/grid [status|add|remove|test|sync|pull]',
    handler: async (client: GenesisClient, args: string, config: ShellConfig) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || 'status';
      const configPath = join(homedir(), '.aither', 'config.json');

      // Read shared ADK config
      function readGridConfig(): Record<string, any> {
        try {
          if (existsSync(configPath)) {
            return JSON.parse(readFileSync(configPath, 'utf-8'));
          }
        } catch {}
        return {};
      }

      function writeGridConfig(data: Record<string, any>): void {
        const existing = readGridConfig();
        Object.assign(existing, data);
        const dir = join(homedir(), '.aither');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');
      }

      async function testNode(host: string, port: number): Promise<boolean> {
        try {
          const r = await fetch(`http://${host}:${port}/v1/models`, {
            signal: AbortSignal.timeout(5000),
          });
          if (r.ok) {
            const data = await r.json() as any;
            const models = (data?.data || []).map((m: any) => m.id).slice(0, 3);
            console.log(chalk.green(`  [+] ${host}:${port}`) + chalk.dim(` — models: ${models.join(', ') || 'default'}`));
            return true;
          }
        } catch {}
        // Try /health as fallback
        try {
          const r = await fetch(`http://${host}:${port}/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (r.ok) {
            console.log(chalk.yellow(`  [!] ${host}:${port}`) + chalk.dim(' — healthy but no /v1 API (missing --api-oai?)'));
            return false;
          }
        } catch {}
        console.log(chalk.red(`  [x] ${host}:${port}`) + chalk.dim(' — unreachable'));
        return false;
      }

      if (sub === 'status') {
        const cfg = readGridConfig();
        const nodes = cfg.grid_nodes || {};

        console.log(chalk.bold('\n  Grid Topology'));
        console.log('  ' + '='.repeat(55));

        // GPU
        if (cfg.backend) {
          console.log(`  ${chalk.cyan('[GPU]')}     ${(cfg.base_url || 'auto').padEnd(30)}  ${cfg.model || 'auto'}`);
        } else {
          console.log(`  ${chalk.dim('[GPU]     not configured (run: adk deploy grid)')}`);
        }

        // Reasoning
        const rNode = nodes.reasoning;
        if (rNode) {
          const display = `${rNode.host}:${rNode.port || 8121}`;
          console.log(`  ${chalk.magenta('[reason]')}  ${display.padEnd(30)}  ${rNode.model || cfg.reasoning_model || 'auto'}`);
        } else if (cfg.reasoning_url) {
          console.log(`  ${chalk.magenta('[reason]')}  ${cfg.reasoning_url.padEnd(30)}  ${cfg.reasoning_model || 'auto'}`);
        } else {
          console.log(`  ${chalk.dim('[reason]  not configured — /grid add reasoning <ip>')}`);
        }

        // Cluster
        const cNodes = nodes.cluster || [];
        if (cNodes.length > 0) {
          for (let i = 0; i < cNodes.length; i++) {
            const n = cNodes[i];
            const display = `${n.host}:${n.port || 8121}`;
            console.log(`  ${chalk.blue(`[cpu.${i}]`)}   ${display.padEnd(30)}  ${n.model || cfg.cluster_model || 'auto'}`);
          }
        } else if (cfg.cluster_url) {
          console.log(`  ${chalk.blue('[cpu.0]')}   ${cfg.cluster_url.padEnd(30)}  ${cfg.cluster_model || 'auto'}`);
        } else {
          console.log(`  ${chalk.dim('[cpu]     not configured — /grid add cluster <ip>')}`);
        }

        // Auth
        console.log();
        const token = config.authToken || cfg.api_key;
        if (token) {
          console.log(chalk.dim(`  Auth: logged in — /grid sync to push config to workspace`));
        } else {
          console.log(chalk.dim('  Auth: not logged in — /login to enable cloud sync'));
        }

        // Health
        console.log(chalk.bold('\n  Health'));
        console.log('  ' + '-'.repeat(55));
        let checked = false;
        if (rNode) { await testNode(rNode.host, rNode.port || 8121); checked = true; }
        for (const n of cNodes) { await testNode(n.host, n.port || 8121); checked = true; }
        if (!checked) console.log(chalk.dim('  No remote nodes configured'));
        console.log();

      } else if (sub === 'add') {
        const role = parts[1]?.toLowerCase();
        const host = parts[2];
        const portStr = parts.find(p => p.startsWith('--port='))?.split('=')[1];
        const port = portStr ? parseInt(portStr) : 8121;
        const modelStr = parts.find(p => p.startsWith('--model='))?.split('=')[1];

        if (!role || !host || !['reasoning', 'cluster'].includes(role)) {
          console.log(chalk.dim('  Usage: /grid add reasoning <ip> [--port=8121] [--model=name]'));
          console.log(chalk.dim('         /grid add cluster <ip> [--port=8121] [--model=name]'));
          return;
        }

        const cfg = readGridConfig();
        const nodes = cfg.grid_nodes || {};
        const entry: Record<string, any> = { host, port };
        if (modelStr) entry.model = modelStr;

        if (role === 'reasoning') {
          nodes.reasoning = entry;
          writeGridConfig({
            reasoning_backend: 'openai',
            reasoning_url: `http://${host}:${port}/v1`,
            reasoning_model: modelStr || 'deepseek-r1-8b',
            grid_nodes: nodes,
          });
        } else {
          const cluster = (nodes.cluster || []).filter((n: any) => n.host !== host);
          cluster.push(entry);
          nodes.cluster = cluster;
          const first = cluster[0];
          writeGridConfig({
            cluster_backend: 'openai',
            cluster_url: `http://${first.host}:${first.port || 8121}/v1`,
            cluster_model: modelStr || 'qwen2.5-32b',
            grid_nodes: nodes,
          });
        }

        console.log(chalk.green(`  Added ${role} node: ${host}:${port}`));
        await testNode(host, port);
        console.log(chalk.dim('  Sync to cloud: /grid sync'));

      } else if (sub === 'remove') {
        const host = parts[1];
        if (!host) { console.log(chalk.dim('  Usage: /grid remove <ip>')); return; }

        const cfg = readGridConfig();
        const nodes = cfg.grid_nodes || {};
        let removed = false;

        if (nodes.reasoning?.host === host) {
          delete nodes.reasoning;
          writeGridConfig({ reasoning_backend: '', reasoning_url: '', reasoning_model: '', grid_nodes: nodes });
          removed = true;
        }

        if (nodes.cluster) {
          const before = nodes.cluster.length;
          nodes.cluster = nodes.cluster.filter((n: any) => n.host !== host);
          if (nodes.cluster.length < before) {
            const update: Record<string, any> = { grid_nodes: nodes };
            if (nodes.cluster.length === 0) {
              update.cluster_backend = '';
              update.cluster_url = '';
              update.cluster_model = '';
            } else {
              const first = nodes.cluster[0];
              update.cluster_url = `http://${first.host}:${first.port || 8121}/v1`;
            }
            writeGridConfig(update);
            removed = true;
          }
        }

        console.log(removed ? chalk.green(`  Removed: ${host}`) : chalk.yellow(`  No node found: ${host}`));

      } else if (sub === 'test') {
        const target = parts[1];
        const cfg = readGridConfig();
        const nodes = cfg.grid_nodes || {};

        console.log(chalk.bold('\n  Grid Node Tests'));
        console.log('  ' + '='.repeat(50));

        let checked = false;
        const rNode = nodes.reasoning;
        if (rNode && (!target || target === rNode.host)) { await testNode(rNode.host, rNode.port || 8121); checked = true; }
        for (const n of (nodes.cluster || [])) {
          if (!target || target === n.host) { await testNode(n.host, n.port || 8121); checked = true; }
        }
        if (!checked) console.log(chalk.dim(target ? `  No node found: ${target}` : '  No nodes configured'));
        console.log();

      } else if (sub === 'sync') {
        const cfg = readGridConfig();
        const token = config.authToken || cfg.api_key;
        if (!token) {
          console.log(chalk.yellow('  Not logged in. Run: /login'));
          return;
        }

        const spinner = ora('Syncing grid config to workspace...').start();
        try {
          // Try Genesis Strata endpoint first
          const result = await client.post('/strata/write', {
            path: 'grid/config.json',
            data: JSON.stringify({
              profile: cfg.profile, backend: cfg.backend, base_url: cfg.base_url,
              model: cfg.model, reasoning_backend: cfg.reasoning_backend,
              reasoning_url: cfg.reasoning_url, reasoning_model: cfg.reasoning_model,
              cluster_backend: cfg.cluster_backend, cluster_url: cfg.cluster_url,
              cluster_model: cfg.cluster_model, grid_nodes: cfg.grid_nodes,
            }, null, 2),
          });
          spinner.stop();
          if (result?.success) {
            console.log(chalk.green('  Grid config synced to workspace'));
            console.log(chalk.dim('  Pull on another machine: /grid pull'));
          } else {
            // Fallback: try gateway directly
            const gateway = cfg.gateway_url || 'https://gateway.aitherium.com';
            const r = await fetch(`${gateway}/api/v1/config/grid`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify(cfg.grid_nodes || {}),
              signal: AbortSignal.timeout(10000),
            });
            spinner.stop();
            if (r.ok) {
              console.log(chalk.green('  Grid config synced via gateway'));
            } else {
              console.log(chalk.yellow('  Sync failed — config saved locally only'));
            }
          }
        } catch (e: any) {
          spinner.stop();
          console.log(chalk.yellow(`  Sync failed: ${e.message || e}`));
          console.log(chalk.dim('  Config is saved locally at ~/.aither/config.json'));
        }

      } else if (sub === 'pull') {
        const cfg = readGridConfig();
        const token = config.authToken || cfg.api_key;
        if (!token) {
          console.log(chalk.yellow('  Not logged in. Run: /login'));
          return;
        }

        const spinner = ora('Pulling grid config from workspace...').start();
        try {
          const result = await client.get('/strata/read?path=grid/config.json') as any;
          spinner.stop();
          if (result?.data) {
            const gridData = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
            writeGridConfig(gridData);
            console.log(chalk.green('  Grid config pulled and saved locally'));
            console.log(chalk.dim('  Run: /grid status'));
          } else {
            // Fallback: gateway
            const gateway = cfg.gateway_url || 'https://gateway.aitherium.com';
            const r = await fetch(`${gateway}/api/v1/config/grid`, {
              headers: { 'Authorization': `Bearer ${token}` },
              signal: AbortSignal.timeout(10000),
            });
            spinner.stop();
            if (r.ok) {
              const gridData = await r.json();
              writeGridConfig(gridData);
              console.log(chalk.green('  Grid config pulled from gateway'));
            } else {
              console.log(chalk.yellow('  No grid config found in workspace'));
              console.log(chalk.dim('  Run /grid sync from your configured machine first'));
            }
          }
        } catch (e: any) {
          spinner.stop();
          console.log(chalk.yellow(`  Pull failed: ${e.message || e}`));
        }

      } else {
        console.log(chalk.bold('\n  /grid — Manage distributed inference nodes\n'));
        console.log('  Commands:');
        console.log(chalk.dim('    /grid status              Show topology + health'));
        console.log(chalk.dim('    /grid add reasoning <ip>  Add Mac reasoning node'));
        console.log(chalk.dim('    /grid add cluster <ip>    Add CPU cluster node'));
        console.log(chalk.dim('    /grid remove <ip>         Remove a node'));
        console.log(chalk.dim('    /grid test                Test all nodes'));
        console.log(chalk.dim('    /grid test <ip>           Test specific node'));
        console.log(chalk.dim('    /grid sync                Push config to workspace'));
        console.log(chalk.dim('    /grid pull                Pull config from workspace'));
        console.log();
      }
    },
  },

  explore: {
    description: 'Browse packs, agents, and skills available for your setup',
    usage: '/explore [agents|tools|skills|grid|all] [--free]',
    handler: async (client: GenesisClient, args: string, config: ShellConfig) => {
      const filter = args.trim().toLowerCase() || 'all';
      const freeOnly = filter.includes('--free') || filter.includes('free');
      const category = filter.replace('--free', '').replace('free', '').trim() || 'all';

      // Fetch catalog from Genesis, fall back to local
      let catalog: any[] = [];
      try {
        const result = await client.get('/api/v1/catalog/packs') as any;
        if (result?.packs) catalog = result.packs;
      } catch {}

      // Fallback: try bundled catalog
      if (catalog.length === 0) {
        try {
          const catalogPath = join(homedir(), '.aitheros', 'packs_catalog.json');
          if (existsSync(catalogPath)) {
            catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')).packs || [];
          }
        } catch {}
      }

      // Second fallback: ADK package data
      if (catalog.length === 0) {
        try {
          // Try common ADK install locations
          const paths = [
            join(homedir(), '.local', 'lib', 'python3.12', 'site-packages', 'adk', 'data', 'packs_catalog.json'),
            join(homedir(), '.local', 'lib', 'python3.11', 'site-packages', 'adk', 'data', 'packs_catalog.json'),
          ];
          for (const p of paths) {
            if (existsSync(p)) {
              catalog = JSON.parse(readFileSync(p, 'utf-8')).packs || [];
              break;
            }
          }
        } catch {}
      }

      if (catalog.length === 0) {
        console.log(chalk.yellow('\n  No catalog available. Install awdk or connect to Genesis.\n'));
        return;
      }

      // Filter
      let filtered = catalog;
      if (category === 'agents') filtered = catalog.filter((p: any) => p.type === 'agent_pack');
      else if (category === 'tools') filtered = catalog.filter((p: any) => p.type === 'tool_pack');
      else if (category === 'grid') filtered = catalog.filter((p: any) => (p.tags || []).some((t: string) => t === 'grid' || t === 'distributed'));
      else if (category === 'skills') filtered = catalog.filter((p: any) => p.type === 'skill_pack');

      if (freeOnly) filtered = filtered.filter((p: any) => p.tier === 'free');

      // Check installed
      const packsDir = join(homedir(), '.aitheros', 'packs');
      const installedIds = new Set<string>();
      try {
        if (existsSync(packsDir)) {
          for (const d of readdirSync(packsDir)) {
            if (existsSync(join(packsDir, d, '.toolpack.yaml'))) installedIds.add(d);
          }
        }
      } catch {}

      // Group by type
      const groups: Record<string, any[]> = {};
      for (const p of filtered) {
        const type = (p.type || 'other').replace('_pack', '').replace('_', ' ');
        if (!groups[type]) groups[type] = [];
        groups[type].push(p);
      }

      console.log(chalk.bold('\n  Aitherium Marketplace'));
      console.log('  ' + '='.repeat(60));

      for (const [type, packs] of Object.entries(groups).sort()) {
        console.log(chalk.bold(`\n  ${type.charAt(0).toUpperCase() + type.slice(1)} Packs`));
        for (const p of packs) {
          const installed = installedIds.has(p.id);
          const icon = installed ? chalk.green('✓') : chalk.dim('○');
          const tier = p.tier === 'free' ? chalk.green('free') : chalk.yellow(p.tier);
          const pricing = p.pricing || {};
          let price = '';
          if (pricing.subscription_cents) price = `$${(pricing.subscription_cents / 100).toFixed(0)}/mo`;
          else if (pricing.one_time_cents) price = `$${(pricing.one_time_cents / 100).toFixed(0)}`;
          else price = 'free';

          console.log(`  ${icon} ${p.name || p.id}`);
          console.log(chalk.dim(`    ${p.description || ''}`));
          console.log(chalk.dim(`    ${tier} ${price !== 'free' ? '· ' + price : ''}${installed ? ' · installed' : ''}`));
        }
      }

      console.log(chalk.bold('\n  Quick Actions'));
      console.log('  ' + '-'.repeat(60));
      console.log(chalk.dim('    /explore agents              Browse agent packs'));
      console.log(chalk.dim('    /explore tools --free         Free tool packs only'));
      console.log(chalk.dim('    /explore grid                 Grid infrastructure'));
      console.log();

      const token = config.authToken;
      if (token) {
        console.log(chalk.dim('  Full catalog: https://portal.aitherium.com/marketplace'));
      } else {
        console.log(chalk.dim('  Full catalog: https://portal.aitherium.com/marketplace'));
        console.log(chalk.dim('  Sign up free: https://portal.aitherium.com/signup'));
      }
      console.log();
    },
  },

  upgrade: {
    description: 'Open upgrade/checkout page for a pack or plan',
    usage: '/upgrade [pack-id|managed|setup]',
    handler: async (_client: GenesisClient, args: string) => {
      const target = args.trim().toLowerCase();

      const URLS: Record<string, { url: string; label: string }> = {
        'managed': { url: 'https://portal.aitherium.com/marketplace/grid?sku=grid_managed_monthly', label: 'Grid Managed ($49/mo)' },
        'setup': { url: 'https://portal.aitherium.com/marketplace/grid?sku=grid_setup_onetime', label: 'Grid Setup Call ($199)' },
        'grid': { url: 'https://portal.aitherium.com/marketplace/grid', label: 'Grid Distributed Inference' },
        'demiurge': { url: 'https://portal.aitherium.com/marketplace/agent.demiurge', label: 'Demiurge — Code Architect' },
        'hydra': { url: 'https://portal.aitherium.com/marketplace/agent.hydra', label: 'Hydra — Code Guardian' },
        'athena': { url: 'https://portal.aitherium.com/marketplace/agent.athena', label: 'Athena — Security Oracle' },
        'lyra': { url: 'https://portal.aitherium.com/marketplace/agent.lyra', label: 'Lyra — Research Muse' },
        'pro': { url: 'https://portal.aitherium.com/pricing', label: 'Professional Plan' },
      };

      if (!target) {
        console.log(chalk.bold('\n  Upgrade Options\n'));
        for (const [key, info] of Object.entries(URLS)) {
          console.log(`  ${chalk.cyan(key.padEnd(15))} ${info.label}`);
        }
        console.log();
        console.log(chalk.dim('  Usage: /upgrade managed'));
        console.log(chalk.dim('         /upgrade demiurge'));
        console.log(chalk.dim('         /upgrade pro'));
        console.log();
        return;
      }

      const match = URLS[target];
      if (match) {
        console.log(`\n  Opening: ${match.label}`);
        console.log(chalk.cyan(`  ${match.url}\n`));
        try {
          const { execSync } = await import('node:child_process');
          const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
          execSync(`${cmd} "${match.url}"`, { stdio: 'ignore' });
        } catch {
          console.log(chalk.dim('  (Could not open browser — copy the URL above)'));
        }
      } else {
        // Try as a generic pack/agent ID
        const url = `https://portal.aitherium.com/marketplace/${target}`;
        console.log(`\n  Opening: ${url}\n`);
        try {
          const { execSync } = await import('node:child_process');
          const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
          execSync(`${cmd} "${url}"`, { stdio: 'ignore' });
        } catch {
          console.log(chalk.dim('  (Could not open browser — copy the URL above)'));
        }
      }
    },
  },

  deploy: {
    description: 'Deploy a service',
    usage: '/deploy <service_name>',
    handler: async (client: GenesisClient, args: string) => {
      const svc = args.trim();
      if (!svc) { console.log(chalk.dim('  Usage: /deploy <service_name>')); return; }
      const spinner = ora(`Deploying ${svc}...`).start();
      const result = await client.post('/deploy', { service: svc });
      spinner.stop();
      if (result?.status === 'deployed' || result?.success) {
        console.log(chalk.green(`  ${svc} deployed.`));
      } else {
        console.log(chalk.yellow('  ' + (result?.error || result?.message || 'Deploy service not available.')));
      }
    },
  },

  security: {
    description: 'Run security scan',
    usage: '/security [scan|status]',
    handler: async (client: GenesisClient, args: string) => {
      const sub = (args.trim() || 'status').toLowerCase();
      if (sub === 'scan') {
        const spinner = ora('Running security scan...').start();
        const result = await client.post('/chaos/health', {});
        spinner.stop();
        console.log(result ? chalk.green('  Scan complete.') : chalk.yellow('  Security service not available.'));
        if (result) console.log(JSON.stringify(result, null, 2));
      } else {
        const result = await client.get('/chaos/statistics');
        if (!result) { console.log(chalk.dim('  Security service not available.')); return; }
        console.log();
        console.log(JSON.stringify(result, null, 2));
        console.log();
      }
    },
  },

  train: {
    description: 'Training status and management',
    usage: '/train [status|start]',
    handler: async (client: GenesisClient, args: string) => {
      const sub = (args.trim() || 'status').toLowerCase();
      const spinner = ora('Fetching training status...').start();
      const result = sub === 'start'
        ? await client.post('/agent-training/train', {})
        : await client.get('/agent-training/status');
      spinner.stop();
      if (!result) { console.log(chalk.dim('  Training service not available.')); return; }
      console.log();
      console.log(JSON.stringify(result, null, 2));
      console.log();
    },
  },

  think: {
    description: 'Deep reasoning on a problem (effort 8+)',
    usage: '/think <problem>  [--effort 7-10]',
    handler: async (client, args, config) => {
      let problem = args;
      let effort = 8;
      const effortMatch = args.match(/--effort\s+(\d+)/);
      if (effortMatch) { effort = Math.max(7, Math.min(10, Number(effortMatch[1]))); problem = problem.replace(effortMatch[0], ''); }
      problem = problem.replace(/^["']|["']$/g, '').trim();

      if (!problem) { console.log(chalk.dim('  Usage: /think <problem> [--effort 7-10]')); return; }

      console.log(chalk.dim(`  Reasoning at effort ${effort} (${effort >= 9 ? 'exhaustive' : 'deep'})...\n`));
      const renderer = (await import('./renderer.js')).createStreamRenderer();
      try {
        for await (const event of client.streamChat(problem, {
          agent: config.defaultAgent,
          sessionId: config.sessionId,
          model: config.model,
        })) {
          renderer.onEvent(event);
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') console.log(chalk.red(`  Error: ${err.message}`));
      } finally {
        renderer.finish();
      }
    },
  },

  research: {
    description: 'Deep research via Lyra (agent-led)',
    usage: '/research <topic>  [--depth quick|standard|deep|exhaustive]',
    handler: async (client, args, config) => {
      let topic = args;
      let depth = 'deep';
      const depthMatch = args.match(/--depth\s+(\S+)/);
      if (depthMatch) { depth = depthMatch[1]; topic = topic.replace(depthMatch[0], ''); }
      topic = topic.replace(/^["']|["']$/g, '').trim();

      if (!topic) { console.log(chalk.dim('  Usage: /research <topic> [--depth quick|standard|deep|exhaustive]')); return; }

      const effort = depth === 'exhaustive' ? 10 : depth === 'deep' ? 8 : depth === 'standard' ? 6 : 4;
      console.log(chalk.dim(`  @lyra researching (${depth}, effort ${effort})...\n`));

      const renderer = (await import('./renderer.js')).createStreamRenderer();
      try {
        for await (const event of client.streamChat(topic, {
          agent: 'lyra',
          sessionId: config.sessionId,
          model: config.model,
        })) {
          renderer.onEvent(event);
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') console.log(chalk.red(`  Error: ${err.message}`));
      } finally {
        renderer.finish();
      }
    },
  },

  login: {
    description: 'Log in to AitherOS (password, OTP, browser SSO, or API key)',
    usage: '/login [--key <token> | --otp | --browser | --sso]',
    handler: async (_client, args, config) => {
      const mode = args.includes('--otp') ? 'otp'
        : args.includes('--browser') || args.includes('--sso') ? 'device'
        : args.includes('--key') ? 'key'
        : 'interactive';
      let activeMode = mode;

      // ── API key / PAT mode ──
      const keyMatch = args.match(/--key\s+(\S+)/);
      if (keyMatch) {
        const token = keyMatch[1];
        const spinner = ora('Validating API key...').start();
        const user = await validateToken(config.identityUrl, token);
        spinner.stop();
        if (user) {
          const profile = buildProfile(config.identityUrl, config.genesisUrl, {
            access_token: token,
            token_type: 'api_key',
            user,
          });
          setProfile('local', profile);
          config.authToken = token;
          config.authUser = profile.user;
          _client.setAuthToken(token, profile.user.tenant_id || null, profile.user.id || null);
          return;
        } else {
          console.log(chalk.red('  Invalid API key or token.'));
          return;
        }
      }

      // ── Browser SSO / Device Code mode ──
      if (mode === 'device') {
        const spinner = ora('Requesting device code...').start();
        try {
          const dc = await requestDeviceCode(config.identityUrl, 'AitherShell');
          spinner.stop();
          console.log();
          console.log(chalk.bold('  🔐 Browser Authentication'));
          console.log();
          console.log(`  Open this URL in your browser:`);
          console.log(`  ${osc8Link(dc.verification_uri_complete)}`);
          console.log();
          console.log(`  Or go to ${osc8Link(dc.verification_uri)} and enter code:`);
          console.log(chalk.bold.yellow(`  ${dc.user_code}`));
          console.log();
          console.log(chalk.dim(`  Waiting for authorization (expires in ${Math.round(dc.expires_in / 60)}m)...`));

          // Try to open browser automatically
          try { execSync(`start "" "${dc.verification_uri_complete}"`, { stdio: 'ignore' }); } catch { /* ignore */ }

          // Poll for authorization
          const pollSpinner = ora({ text: 'Waiting for browser authorization...', color: 'yellow' }).start();
          const deadline = Date.now() + dc.expires_in * 1000;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, (dc.interval || 5) * 1000));
            try {
              const result = await pollDeviceToken(config.identityUrl, dc.device_code);
              if (result.status === 'complete' && result.access_token) {
                pollSpinner.stop();
                const profile = buildProfile(config.identityUrl, config.genesisUrl, result);
                setProfile('local', profile);
                config.authToken = profile.access_token;
                config.authUser = profile.user;
                _client.setAuthToken(profile.access_token, profile.user.tenant_id || null, profile.user.id || null);
                console.log(chalk.green(`  ✓ Logged in as ${chalk.bold(profile.user.display_name || profile.user.username)} (${profile.user.email})`));
                return;
              }
              // Still pending — continue polling
            } catch (err: any) {
              if (err.message.includes('expired')) {
                pollSpinner.stop();
                console.log(chalk.red('  Device code expired. Run /login --browser to try again.'));
                return;
              }
              // Other errors — continue polling
            }
          }
          pollSpinner.stop();
          console.log(chalk.red('  Timed out waiting for authorization.'));
        } catch (err: any) {
          spinner.stop();
          const cause = err.cause ? ` (${err.cause?.code || err.cause?.message || err.cause})` : '';
          console.log(chalk.red(`  Device code error: ${err.message}${cause}`));
          console.log(chalk.dim(`  Identity URL: ${config.identityUrl}`));
        }
        return;
      }

      // ── Email OTP mode ──
      if (mode === 'otp') {
        // Use raw stdin — see rawAsk below for why
        const otpAsk = (prompt: string): Promise<string> => {
          return new Promise(resolve => {
            process.stdout.write(prompt);
            let buf = '';
            const stdin = process.stdin;
            const wasRaw = stdin.isRaw;
            if (stdin.isTTY) stdin.setRawMode(true);
            const onData = (ch: Buffer) => {
              const c = ch.toString();
              if (c === '\n' || c === '\r') {
                stdin.removeListener('data', onData);
                if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
                process.stdout.write('\n');
                resolve(buf);
              } else if (c === '\x03') {
                stdin.removeListener('data', onData);
                if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
                process.stdout.write('\n');
                resolve('');
              } else if (c === '\x7f' || c === '\b') {
                if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
              } else if (c.charCodeAt(0) >= 32) {
                buf += c;
                process.stdout.write(c);
              }
            };
            stdin.on('data', onData);
          });
        };
        try {
          const id = await otpAsk(chalk.cyan('  Email or username: '));
          if (!id) { console.log(chalk.yellow('  Cancelled')); return; }
          const spinner = ora('Sending login code...').start();
          const otpResult = await requestEmailOTP(config.identityUrl, id);
          spinner.stop();
          console.log(chalk.dim(`  ${otpResult.message}`));
          if (!otpResult.otp_token) {
            console.log(chalk.dim('  Check your email for the login code.'));
            return;
          }
          const code = await otpAsk(chalk.cyan('  Enter 6-digit code: '));
          if (!code) { console.log(chalk.yellow('  Cancelled')); return; }
          const spinner2 = ora('Verifying code...').start();
          const result = await verifyEmailOTP(config.identityUrl, otpResult.otp_token, code);
          spinner2.stop();
          const profile = buildProfile(config.identityUrl, config.genesisUrl, result);
          setProfile('local', profile);
          config.authToken = profile.access_token;
          config.authUser = profile.user;
          _client.setAuthToken(profile.access_token, profile.user.tenant_id || null, profile.user.id || null);
          console.log(chalk.green(`  ✓ Logged in as ${chalk.bold(profile.user.display_name || profile.user.username)}`));
        } catch (err: any) {
          console.log(chalk.red(`  ${err.message}`));
        }
        return;
      }

      // ── Raw stdin prompt — avoids creating a competing readline ──
      // The REPL already has a readline on process.stdin; creating another
      // causes double-input bugs. Use raw stdin reads instead.
      const rawAsk = (prompt: string): Promise<string> => {
        return new Promise(resolve => {
          process.stdout.write(prompt);
          let buf = '';
          const stdin = process.stdin;
          const wasRaw = stdin.isRaw;
          if (stdin.isTTY) stdin.setRawMode(true);
          const onData = (ch: Buffer) => {
            const c = ch.toString();
            if (c === '\n' || c === '\r') {
              stdin.removeListener('data', onData);
              if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
              process.stdout.write('\n');
              resolve(buf);
            } else if (c === '\x03') {
              stdin.removeListener('data', onData);
              if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
              process.stdout.write('\n');
              resolve('');
            } else if (c === '\x7f' || c === '\b') {
              if (buf.length > 0) {
                buf = buf.slice(0, -1);
                process.stdout.write('\b \b');
              }
            } else if (c.charCodeAt(0) >= 32) {
              buf += c;
              process.stdout.write(c);
            }
          };
          stdin.on('data', onData);
        });
      };

      const rawAskHidden = (prompt: string): Promise<string> => {
        return new Promise(resolve => {
          process.stdout.write(prompt);
          let buf = '';
          const stdin = process.stdin;
          const wasRaw = stdin.isRaw;
          if (stdin.isTTY) stdin.setRawMode(true);
          const onData = (ch: Buffer) => {
            const c = ch.toString();
            if (c === '\n' || c === '\r') {
              stdin.removeListener('data', onData);
              if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
              process.stdout.write('\n');
              resolve(buf);
            } else if (c === '\x03') {
              stdin.removeListener('data', onData);
              if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
              process.stdout.write('\n');
              resolve('');
            } else if (c === '\x7f' || c === '\b') {
              if (buf.length > 0) buf = buf.slice(0, -1);
            } else if (c.charCodeAt(0) >= 32) {
              buf += c;
            }
          };
          stdin.on('data', onData);
        });
      };

      // ── Interactive: show method picker ──
      if (activeMode === 'interactive') {
        console.log(chalk.bold('\n  Login Methods:\n'));
        console.log(`  ${chalk.cyan('1')} Password      — Enter username + password`);
        console.log(`  ${chalk.cyan('2')} Email OTP     — Get a one-time code via email`);
        console.log(`  ${chalk.cyan('3')} Browser SSO   — Authenticate in your browser (like Claude Code)`);
        console.log(`  ${chalk.cyan('4')} API Key       — Paste an API key or PAT`);
        console.log();

        const choice = await rawAsk(chalk.cyan('  Choose (1-4): '));
        const modeMap: Record<string, string> = { '1': 'password', '2': 'otp', '3': 'device', '4': 'key' };
        activeMode = modeMap[choice.trim()] || 'password';

        // Dispatch to non-password modes
        if (activeMode === 'device') {
          return await COMMANDS.login.handler(_client, '--browser', config);
        }
        if (activeMode === 'otp') {
          return await COMMANDS.login.handler(_client, '--otp', config);
        }
        if (activeMode === 'key') {
          const key = await rawAsk(chalk.cyan('  API Key / PAT: '));
          if (!key) { console.log(chalk.yellow('  Login cancelled')); return; }
          return await COMMANDS.login.handler(_client, `--key ${key}`, config);
        }
        // Fall through to password mode
      }

      // ── Password login ──
      const username = await rawAsk(chalk.cyan('  Username: '));
      const password = await rawAskHidden(chalk.cyan('  Password: '));

      if (!username || !password) {
        console.log(chalk.yellow('  Login cancelled'));
        return;
      }

      const spinner = ora('Authenticating...').start();
      let result: any;
      try {
        result = await loginWithPassword(config.identityUrl, username, password);
      } catch (err: any) {
        spinner.stop();
        console.log(chalk.red(`  ${err.message}`));
        return;
      }
      spinner.stop();

      // Handle 2FA
      if (result.requires_2fa) {
        const code = await rawAsk(chalk.cyan('  2FA Code: '));
        if (!code) { console.log(chalk.yellow('  Login cancelled')); return; }
        const spinner2 = ora('Verifying 2FA...').start();
        try {
          result = await verify2FA(config.identityUrl, result.temp_token, code);
        } catch (err: any) {
          spinner2.stop();
          console.log(chalk.red(`  ${err.message}`));
          return;
        }
        spinner2.stop();
      }

      const profile = buildProfile(config.identityUrl, config.genesisUrl, result);
      setProfile('local', profile);
      config.authToken = profile.access_token;
      config.authUser = profile.user;
      _client.setAuthToken(profile.access_token, profile.user.tenant_id || null, profile.user.id || null);
      console.log(chalk.green(`  ✓ Logged in as ${chalk.bold(profile.user.display_name || profile.user.username)}`));
    },
  },

  register: {
    description: 'Register a new AitherOS account',
    handler: async (_client, _args, config) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> =>
        new Promise(resolve => rl.question(q, resolve));

      try {
        const username = await ask(chalk.cyan('  Username: '));
        const email = await ask(chalk.cyan('  Email: '));
        const password = await ask(chalk.cyan('  Password: '));
        const inviteCode = await ask(chalk.cyan('  Invite code (optional): '));

        if (!username || !email || !password) {
          console.log(chalk.yellow('  Registration cancelled'));
          return;
        }

        const spinner = ora('Registering...').start();
        try {
          const result = await register(config.identityUrl, username, password, email, inviteCode);
          spinner.stop();
          if (result.access_token) {
            const profile = buildProfile(config.identityUrl, config.genesisUrl, result);
            setProfile('local', profile);
            config.authToken = profile.access_token;
            config.authUser = profile.user;
            _client.setAuthToken(profile.access_token, profile.user.tenant_id || null, profile.user.id || null);
          } else {
            console.log(chalk.green('  Registration successful. Check your email for verification.'));
          }
        } catch (err: any) {
          spinner.stop();
          console.log(chalk.red(`  ${err.message}`));
        }
      } finally {
        rl.close();
      }
    },
  },

  logout: {
    description: 'Log out of AitherOS',
    handler: async (_client, _args, config) => {
      const profile = getActiveProfile();
      if (!profile) {
        console.log(chalk.dim('  Not logged in'));
        return;
      }

      const spinner = ora('Logging out...').start();
      if (profile.access_token && profile.endpoint) {
        await logoutSession(profile.endpoint, profile.access_token);
      }
      clearProfile('local');
      config.authToken = null;
      config.authUser = null;
      _client.setAuthToken(null);
      spinner.stop();

      // Notify Genesis session end
      await _client.post('/shell/session/end', { session_id: config.sessionId }).catch(() => {});

      console.log(chalk.green('  Logged out'));
    },
  },

  whoami: {
    description: 'Show current user info',
    handler: async (_client, _args, config) => {
      const user = config.authUser || getActiveUser();
      const profile = getActiveProfile();

      if (!user || !profile?.access_token) {
        console.log(chalk.dim('  Not logged in. Use /login to authenticate.'));
        return;
      }

      console.log();
      console.log(chalk.bold('  User:     ') + chalk.cyan(user.display_name || user.username));
      if (user.email) console.log(chalk.bold('  Email:    ') + user.email);
      if (user.roles?.length) console.log(chalk.bold('  Roles:    ') + user.roles.join(', '));
      if (user.tenant_id) console.log(chalk.bold('  Tenant:   ') + (user.tenant_slug || user.tenant_id));
      if (profile.endpoint) console.log(chalk.bold('  Endpoint: ') + chalk.dim(profile.endpoint));
      if (profile.token_type) console.log(chalk.bold('  Auth:     ') + profile.token_type);
      if (profile.expires_at) {
        const exp = new Date(profile.expires_at);
        const remaining = Math.max(0, Math.floor((exp.getTime() - Date.now()) / 60000));
        console.log(chalk.bold('  Expires:  ') + (remaining > 0
          ? chalk.dim(`${remaining}m remaining`)
          : chalk.red('expired')));
      }
      console.log();
    },
  },

  demo: {
    description: 'Manage the minimal demo stack (demo.aitherium.com)',
    usage: '/demo [start|stop|status|logs]',
    handler: async (_client, args) => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
      const composeFile = join(repoRoot, '.DEPLOYMENT', 'compose', 'docker-compose.demo.yml');
      const fullCompose = join(repoRoot, '.DEPLOYMENT', 'compose', 'docker-compose.aitheros.yml');
      const target = existsSync(composeFile) ? composeFile : fullCompose;
      // Compose files live under .DEPLOYMENT/; --project-directory keeps their
      // relative build contexts / volume mounts resolving against the repo root.
      const pd = `--project-directory "${repoRoot}"`;

      const sub = args.trim().toLowerCase().split(/\s+/)[0] || 'status';

      const cmdMap: Record<string, string> = {
        start:  `docker compose -f "${target}" ${pd} up -d`,
        up:     `docker compose -f "${target}" ${pd} up -d`,
        stop:   `docker compose -f "${target}" ${pd} down --timeout 10`,
        down:   `docker compose -f "${target}" ${pd} down --timeout 10`,
        status: `docker compose -f "${target}" ${pd} ps`,
        ps:     `docker compose -f "${target}" ${pd} ps`,
        logs:   `docker compose -f "${target}" ${pd} logs --tail 30`,
      };

      if (!cmdMap[sub]) {
        console.log(chalk.bold('\n  /demo — Manage the minimal demo stack\n'));
        console.log(`  ${chalk.cyan('/demo start')}    Start demo containers`);
        console.log(`  ${chalk.cyan('/demo stop')}     Stop demo containers`);
        console.log(`  ${chalk.cyan('/demo status')}   Show container status`);
        console.log(`  ${chalk.cyan('/demo logs')}     Tail recent logs`);
        console.log();
        console.log(chalk.dim(`  Compose file: ${target}`));
        console.log();
        return;
      }

      const spinner = ora(`demo ${sub}...`).start();
      try {
        const output = execSync(cmdMap[sub], {
          encoding: 'utf-8',
          cwd: repoRoot,
          timeout: 60000,
          env: { ...process.env },
        });
        spinner.stop();
        if (output.trim()) console.log(output);
        if (sub === 'start' || sub === 'up') {
          console.log(chalk.green('  ✅ Demo stack started'));
          console.log(chalk.dim('     Dashboard: http://localhost:3000'));
          console.log(chalk.dim('     Public:    https://demo.aitherium.com'));
        } else if (sub === 'stop' || sub === 'down') {
          console.log(chalk.green('  ✅ Demo stack stopped'));
        }
      } catch (err: any) {
        spinner.stop();
        console.log(chalk.red(`  Failed: ${err.message}`));
        if (err.stdout) console.log(err.stdout);
      }
      console.log();
    },
  },

  repowise: {
    description: 'Ask codebase questions via Repowise',
    usage: '/repowise <question>',
    handler: async (client: GenesisClient, args: string) => {
      const question = args.trim();
      if (!question) { console.log(chalk.dim('  Usage: /repowise <question>')); return; }
      const spinner = ora('Querying Repowise...').start();
      try {
        const result = await client.post('/repowise/answer', { question }) as any;
        spinner.stop();
        const answer = result?.answer || result?.response || '';
        if (answer) {
          console.log(); console.log(answer); console.log();
          const refs = result?.references || result?.sources || [];
          if (refs.length) {
            console.log(chalk.dim('  Sources:'));
            for (const r of refs.slice(0, 5)) { console.log(chalk.dim(`    - ${r.file || r.path || r}`)); }
          }
        } else { console.log(chalk.dim('  No answer returned.')); }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    },
  },

  expedition: {
    description: 'Manage expeditions — full autonomous agent orchestration',
    usage: '/expedition [list|create <name>|status <id>|gate <id> approve|reject|run "<goal>"|stream <id>|cancel <id>]',
    handler: async (client: GenesisClient, args: string) => {
      const parsed = parseQuotedArgs(args.trim());
      const sub = (parsed[0] || 'list').toLowerCase();
      if (sub === 'list') {
        const spinner = ora('Loading expeditions...').start();
        try {
          const result = await client.get('/expeditions') as any;
          spinner.stop();
          const exps = result?.expeditions || result?.items || [];
          if (!exps.length) { console.log(chalk.dim('  No active expeditions.')); return; }
          console.log();
          for (const e of exps) {
            const status = e.status === 'active' ? chalk.green('active') : e.status === 'paused' ? chalk.yellow('paused') : chalk.dim(e.status);
            console.log(`  ${status}  ${chalk.bold(e.name || e.id)}  ${chalk.dim(e.id?.slice(0, 8) || '')}`);
          }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'create' && parsed[1]) {
        const name = parsed.slice(1).join(' ');
        const spinner = ora(`Creating expedition "${name}"...`).start();
        try {
          const result = await client.post('/expeditions', { name, description: name }) as any;
          spinner.stop();
          console.log(chalk.green(`  Created: ${result?.id || result?.expedition_id || 'OK'}`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'status' && parsed[1]) {
        const spinner = ora('Loading...').start();
        try {
          const result = await client.get(`/expeditions/${parsed[1]}`);
          spinner.stop();
          console.log(); console.log(JSON.stringify(result, null, 2)); console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'gate' && parsed[1] && parsed[2]) {
        const action = parsed[2].toLowerCase();
        const spinner = ora(`${action === 'approve' ? 'Approving' : 'Rejecting'} gate...`).start();
        try {
          await client.post(`/expeditions/${parsed[1]}/gate`, { action });
          spinner.stop();
          console.log(chalk.green(`  Gate ${action}d.`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'run' && parsed[1]) {
        const goal = parsed.slice(1).join(' ');
        console.log(chalk.bold(`\n  Launching expedition: "${goal}"\n`));
        console.log(chalk.dim('  Pipeline: Atlas (plan) → Lyra (research) → Demiurge (implement) → Council (review) → Vera (publish)'));
        console.log(chalk.dim('  Human gates enforced — you will be asked to approve each phase.\n'));
        const spinner = ora('Submitting intake...').start();
        try {
          const intake = await client.post('/expedition/intake', {
            goal,
            orchestration: {
              planner: 'atlas',
              researcher: 'lyra',
              implementer: 'demiurge',
              reviewer: 'council',
              publisher: 'vera',
            },
            auto_approve: false,
            escalation: 'deepseek',
          }) as any;
          spinner.stop();
          const expId = intake?.expedition_id || intake?.id;
          if (!expId) { console.log(chalk.red('  Failed to create expedition.')); return; }
          console.log(chalk.green(`  Expedition created: ${expId}`));

          // Kick off planning phase
          const planSpinner = ora('Generating plan (Atlas)...').start();
          const plan = await client.post(`/expedition/${expId}/plan`, {}) as any;
          planSpinner.stop();
          if (plan?.error) {
            console.log(chalk.yellow(`  Planning deferred: ${plan.error}`));
          } else {
            console.log(chalk.green('  Plan generated.'));
            if (plan?.phases) {
              for (const phase of plan.phases.slice(0, 5)) {
                console.log(chalk.dim(`    → ${phase.name || phase.title || phase}`));
              }
            }
          }

          // Kick off execution with human gates
          const execSpinner = ora('Starting execution (human gates active)...').start();
          const exec = await client.post(`/expedition/${expId}/execute`, { auto_approve: false }) as any;
          execSpinner.stop();
          if (exec?.error) {
            console.log(chalk.yellow(`  Execution queued: ${exec.error}`));
          } else {
            console.log(chalk.green('  Execution started.'));
          }

          console.log();
          console.log(chalk.cyan(`  Monitor: /expedition status ${expId}`));
          console.log(chalk.cyan(`  Stream:  /expedition stream ${expId}`));
          console.log(chalk.cyan(`  Cancel:  /expedition cancel ${expId}`));
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'stream' && parsed[1]) {
        const expId = parsed[1];
        console.log(chalk.dim(`  Streaming events for expedition ${expId} (Ctrl+C to stop)...\n`));
        try {
          const response = await fetch(`${client.baseUrl}/expedition/${expId}/stream`, {
            headers: { 'Accept': 'text/event-stream' },
            signal: AbortSignal.timeout(300000),
          });
          if (!response.ok) { console.log(chalk.red(`  HTTP ${response.status}`)); return; }
          const body = response.body as ReadableStream<Uint8Array> | null;
          if (!body) { console.log(chalk.red('  No stream body')); return; }
          const reader = body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const parts = buffer.split('\n\n');
              buffer = parts.pop() || '';
              for (const part of parts) {
                if (!part.trim()) continue;
                const dataLine = part.split('\n').find(l => l.startsWith('data: '));
                if (dataLine) {
                  try {
                    const evt = JSON.parse(dataLine.slice(6));
                    const phase = evt.phase ? chalk.cyan(`[${evt.phase}]`) : '';
                    const msg = evt.message || evt.event || JSON.stringify(evt);
                    console.log(`  ${phase} ${msg}`);
                  } catch { console.log(chalk.dim(`  ${dataLine.slice(6)}`)); }
                }
              }
            }
          } finally { reader.releaseLock(); }
          console.log(chalk.dim('\n  Stream ended.'));
        } catch (e: any) {
          if (e.name !== 'AbortError') console.log(chalk.red(`  Error: ${e.message}`));
        }
      } else if (sub === 'cancel' && parsed[1]) {
        const spinner = ora('Cancelling expedition...').start();
        try {
          await client.post(`/expedition/${parsed[1]}/cancel`, {});
          spinner.stop();
          console.log(chalk.green(`  Expedition ${parsed[1]} cancelled.`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else {
        console.log(chalk.dim('  Usage: /expedition [list|create <name>|status <id>|gate <id> approve|reject|run "<goal>"|stream <id>|cancel <id>]'));
      }
    },
  },

  routines: {
    description: 'Manage automation routines (full CRUD)',
    usage: '/routines [list|run <id>|create <json>|enable <id>|disable <id>|edit <id> <json>|history|pause|resume|status]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'list').toLowerCase();
      if (sub === 'list') {
        const spinner = ora('Loading routines...').start();
        try {
          const result = await client.get('/scheduler/routines') || await client.get('/routines') as any;
          spinner.stop();
          const routines = result?.routines || result?.items || [];
          if (!routines.length) { console.log(chalk.dim('  No routines found.')); return; }
          console.log();
          for (const r of routines) {
            const enabled = r.enabled ? chalk.green('on') : chalk.dim('off');
            console.log(`  ${enabled}  ${chalk.bold(r.name || r.id)}  ${chalk.dim(r.schedule || r.cron || '')}`);
          }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'run' && parts[1]) {
        const spinner = ora(`Running routine ${parts[1]}...`).start();
        try {
          const result = await client.post(`/scheduler/routines/${parts[1]}/run`, {}) || await client.post(`/routines/${parts[1]}/run`, {}) as any;
          spinner.stop();
          console.log(chalk.green(`  Routine triggered: ${result?.status || 'OK'}`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'create') {
        const jsonStr = parts.slice(1).join(' ');
        if (!jsonStr) { console.log(chalk.dim('  Usage: /routines create {"name":"...", "cron":"...", "task":"..."}')); return; }
        let payload: any;
        try { payload = JSON.parse(jsonStr); } catch { console.log(chalk.red('  Invalid JSON.')); return; }
        const spinner = ora('Creating routine...').start();
        try {
          const result = await client.post('/scheduler/routines/create', payload) as any;
          spinner.stop();
          console.log(chalk.green(`  Created: ${result?.id || result?.routine_id || 'OK'}`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'enable' && parts[1]) {
        const spinner = ora(`Enabling routine ${parts[1]}...`).start();
        try {
          await client.post(`/scheduler/routines/${parts[1]}/enable`, {});
          spinner.stop();
          console.log(chalk.green(`  Routine ${parts[1]} enabled.`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'disable' && parts[1]) {
        const spinner = ora(`Disabling routine ${parts[1]}...`).start();
        try {
          await client.post(`/scheduler/routines/${parts[1]}/disable`, {});
          spinner.stop();
          console.log(chalk.yellow(`  Routine ${parts[1]} disabled.`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'edit' && parts[1]) {
        const jsonStr = parts.slice(2).join(' ');
        if (!jsonStr) { console.log(chalk.dim('  Usage: /routines edit <id> {"cron":"...", ...}')); return; }
        let payload: any;
        try { payload = JSON.parse(jsonStr); } catch { console.log(chalk.red('  Invalid JSON.')); return; }
        const spinner = ora(`Updating routine ${parts[1]}...`).start();
        try {
          const result = await client.patch(`/scheduler/routines/${parts[1]}`, payload) as any;
          spinner.stop();
          if (result?.error) { console.log(chalk.red(`  Error: ${result.error}`)); }
          else { console.log(chalk.green(`  Routine ${parts[1]} updated.`)); }
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'history') {
        const spinner = ora('Loading routine history...').start();
        try {
          const result = await client.get('/scheduler/routines/history') as any;
          spinner.stop();
          const runs = result?.runs || result?.history || result?.items || [];
          if (!runs.length) { console.log(chalk.dim('  No history.')); return; }
          console.log();
          for (const r of runs.slice(0, 20)) {
            const ok = r.status === 'success' ? chalk.green('✓') : r.status === 'failed' ? chalk.red('✗') : chalk.dim('●');
            const ts = r.timestamp || r.started_at || '';
            console.log(`  ${ok}  ${chalk.bold(r.routine_name || r.routine_id || r.id)}  ${chalk.dim(ts)}`);
          }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'pause') {
        const spinner = ora('Pausing all routines...').start();
        try {
          await client.post('/scheduler/routines/pause', {});
          spinner.stop();
          console.log(chalk.yellow('  All routines paused.'));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'resume') {
        const spinner = ora('Resuming routines...').start();
        try {
          await client.post('/scheduler/routines/resume', {});
          spinner.stop();
          console.log(chalk.green('  Routines resumed.'));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'status') {
        const spinner = ora('Loading scheduler status...').start();
        try {
          const result = await client.get('/scheduler/routines/status') as any;
          spinner.stop();
          if (!result) { console.log(chalk.dim('  Scheduler unreachable.')); return; }
          console.log();
          console.log(`  State:    ${result.paused ? chalk.yellow('paused') : chalk.green('running')}`);
          console.log(`  Active:   ${result.active_count ?? result.active ?? '?'}`);
          console.log(`  Pending:  ${result.pending_count ?? result.pending ?? '?'}`);
          if (result.last_run) console.log(`  Last run: ${chalk.dim(result.last_run)}`);
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else {
        console.log(chalk.dim('  Usage: /routines [list|run <id>|create <json>|enable <id>|disable <id>|edit <id> <json>|history|pause|resume|status]'));
      }
    },
  },

  github: {
    description: 'GitHub operations',
    usage: '/github [prs|issues|releases|ci|merge <pr>]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'prs').toLowerCase();
      const listEndpoints: Record<string, string> = { prs: '/github/prs', issues: '/github/issues', releases: '/github/releases', ci: '/github/ci/status' };
      const endpoint = listEndpoints[sub];
      if (endpoint) {
        const spinner = ora(`Loading ${sub}...`).start();
        try {
          const result = await client.get(endpoint) as any;
          spinner.stop();
          const items = result?.items || result?.prs || result?.issues || result?.releases || result?.workflows || [];
          if (!items.length) { console.log(chalk.dim(`  No ${sub} found.`)); return; }
          console.log();
          for (const item of items.slice(0, 15)) {
            const title = item.title || item.name || item.tag_name || item.workflow || '';
            const num = item.number ? chalk.cyan(`#${item.number}`) : '';
            const state = item.state === 'open' ? chalk.green('open') : item.state === 'closed' ? chalk.red('closed') : chalk.dim(item.state || item.status || '');
            console.log(`  ${num} ${chalk.bold(title)}  ${state}`);
          }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'merge' && parts[1]) {
        const spinner = ora(`Merging PR #${parts[1]}...`).start();
        try {
          const result = await client.post(`/github/prs/${parts[1]}/merge`, {}) as any;
          spinner.stop();
          console.log(chalk.green(`  PR #${parts[1]} merged: ${result?.sha?.slice(0, 8) || 'OK'}`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else {
        console.log(chalk.dim('  Usage: /github [prs|issues|releases|ci|merge <pr_number>]'));
      }
    },
  },

  secrets: {
    description: 'Manage secrets vault',
    usage: '/secrets [list|get <key>|set <key> <value>|delete <key>]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'list').toLowerCase();
      if (sub === 'list') {
        const spinner = ora('Loading secrets...').start();
        try {
          const result = await client.get('/secrets') as any;
          spinner.stop();
          const keys = result?.keys || result?.secrets || [];
          if (!keys.length) { console.log(chalk.dim('  Vault is empty.')); return; }
          console.log();
          for (const k of keys) { console.log(`  ${chalk.cyan('-')} ${typeof k === 'string' ? k : k.key || k.name}`); }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'get' && parts[1]) {
        const spinner = ora(`Reading ${parts[1]}...`).start();
        try {
          const result = await client.get(`/secrets/${parts[1]}`) as any;
          spinner.stop();
          const val = result?.value ?? result?.secret ?? '';
          console.log(`  ${chalk.cyan(parts[1])} = ${val ? chalk.green(val) : chalk.dim('(empty)')}`);
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'set' && parts[1] && parts[2]) {
        const value = parts.slice(2).join(' ');
        const spinner = ora(`Storing ${parts[1]}...`).start();
        try {
          await client.post('/secrets', { key: parts[1], value });
          spinner.stop();
          console.log(chalk.green(`  ${parts[1]} stored.`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'delete' && parts[1]) {
        const spinner = ora(`Deleting ${parts[1]}...`).start();
        try {
          await client.post(`/secrets/${parts[1]}/delete`, {});
          spinner.stop();
          console.log(chalk.green(`  ${parts[1]} deleted.`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else {
        console.log(chalk.dim('  Usage: /secrets [list|get <key>|set <key> <value>|delete <key>]'));
      }
    },
  },

  generate: {
    description: 'Generate an image via Canvas/Iris',
    usage: '/generate [prompt] [--style <style>] [--size WxH] [--model <name>]',
    handler: async (_client, args, config) => {
      const canvasUrl = process.env.AITHER_CANVAS_URL || 'https://127.0.0.1:8108';
      const modelsQs = config?.safetyLevel ? `?safety_level=${config.safetyLevel}` : '';

      async function fetchModels(): Promise<string[]> {
        const resp = await fetch(`${canvasUrl}/models${modelsQs}`, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return [];
        const data = await resp.json() as any;
        return data?.checkpoints || [];
      }

      function fuzzyMatch(checkpoints: string[], hint: string): string | undefined {
        const h = hint.toLowerCase();
        return checkpoints.find(m => m.toLowerCase() === h)
          || checkpoints.find(m => m.toLowerCase().includes(h))
          || checkpoints.find(m => m.toLowerCase().startsWith(h));
      }

      // Parse inline flags from args
      let prompt = args;
      let style: string | undefined;
      let modelHint: string | undefined;
      let tier: string = 'auto';
      let width = 1024, height = 1024;
      const styleMatch = args.match(/-{1,2}style\s+(\S+)/);
      if (styleMatch) { style = styleMatch[1]; prompt = prompt.replace(styleMatch[0], ''); }
      const sizeMatch = args.match(/-{1,2}size\s+(\d+)x(\d+)/);
      if (sizeMatch) { width = Number(sizeMatch[1]); height = Number(sizeMatch[2]); prompt = prompt.replace(sizeMatch[0], ''); }
      const modelMatch = args.match(/-{1,2}model\s+(\S+)/);
      if (modelMatch) { modelHint = modelMatch[1]; prompt = prompt.replace(modelMatch[0], ''); }
      prompt = prompt.replace(/^["']|["']$/g, '').trim();

      // ── Interactive mode: walk through each step ──
      // REPL kills stdin keypress emitter before handlers, so inquirer is broken.
      // All interactive I/O uses raw stdin directly.
      const interactive = !prompt;
      if (interactive) {
        if (process.stdin.isTTY) process.stdin.setRawMode(true);

        // Raw text input — handles typing, backspace, Enter, Ctrl+C
        function rawInput(label: string): Promise<string> {
          process.stdout.write(label);
          return new Promise<string>((resolve, reject) => {
            let buf = '';
            const onKey = (key: Buffer) => {
              for (const byte of key) {
                if (byte === 0x0d || byte === 0x0a) {
                  process.stdin.removeListener('data', onKey);
                  process.stdout.write('\n');
                  resolve(buf); return;
                }
                if (byte === 0x03) {
                  process.stdin.removeListener('data', onKey);
                  process.stdout.write('\n');
                  reject(new Error('cancelled')); return;
                }
                if (byte === 0x7f || byte === 0x08) {
                  if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
                } else if (byte >= 0x20) {
                  buf += String.fromCharCode(byte);
                  process.stdout.write(String.fromCharCode(byte));
                }
              }
            };
            process.stdin.on('data', onKey);
          });
        }

        // Raw list picker — arrow keys to navigate, Enter to select, Ctrl+C to cancel
        // Also supports typing to filter, backspace to clear filter
        function rawPicker<T>(label: string, items: { name: string; value: T }[]): Promise<T> {
          return new Promise<T>((resolve, reject) => {
            let cursor = 0;
            let filter = '';
            let filtered = items;
            const maxVisible = Math.min(12, process.stdout.rows - 4);

            function getFiltered() {
              if (!filter) return items;
              const q = filter.toLowerCase();
              return items.filter(i => i.name.toLowerCase().includes(q));
            }

            function render() {
              // Clear previous render
              const clearLines = maxVisible + 2;
              for (let i = 0; i < clearLines; i++) {
                process.stdout.write('\x1b[2K'); // clear line
                if (i < clearLines - 1) process.stdout.write('\x1b[1A'); // move up
              }
              process.stdout.write('\r');

              // Header
              const filterDisplay = filter ? chalk.cyan(filter) : chalk.dim('type to filter');
              process.stdout.write(`  ${chalk.bold(label)} [${filterDisplay}]\n`);

              // Items
              const scrollStart = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), filtered.length - maxVisible));
              for (let i = 0; i < maxVisible; i++) {
                const idx = scrollStart + i;
                if (idx >= filtered.length) {
                  process.stdout.write('\x1b[2K\n');
                } else {
                  const marker = idx === cursor ? chalk.cyan('> ') : '  ';
                  const text = idx === cursor ? chalk.bold(filtered[idx].name) : filtered[idx].name;
                  process.stdout.write(`\x1b[2K  ${marker}${text}\n`);
                }
              }
              // Footer
              process.stdout.write(chalk.dim('  ↑↓ navigate · ⏎ select · type to filter'));
            }

            // Initial render: write blank lines first so we have space to clear
            for (let i = 0; i < maxVisible + 2; i++) process.stdout.write('\n');
            render();

            const onKey = (key: Buffer) => {
              // Handle escape sequences (arrow keys)
              const seq = key.toString();
              if (seq === '\x1b[A' || seq === '\x1bOA') { // Up
                cursor = Math.max(0, cursor - 1);
                render(); return;
              }
              if (seq === '\x1b[B' || seq === '\x1bOB') { // Down
                cursor = Math.min(filtered.length - 1, cursor + 1);
                render(); return;
              }
              for (const byte of key) {
                if (byte === 0x0d || byte === 0x0a) { // Enter
                  process.stdin.removeListener('data', onKey);
                  process.stdout.write('\n');
                  if (filtered[cursor]) resolve(filtered[cursor].value);
                  else reject(new Error('cancelled'));
                  return;
                }
                if (byte === 0x03 || byte === 0x1b) { // Ctrl+C or Esc
                  process.stdin.removeListener('data', onKey);
                  process.stdout.write('\n');
                  reject(new Error('cancelled'));
                  return;
                }
                if (byte === 0x7f || byte === 0x08) { // Backspace
                  if (filter.length > 0) {
                    filter = filter.slice(0, -1);
                    filtered = getFiltered();
                    cursor = Math.min(cursor, Math.max(0, filtered.length - 1));
                    render();
                  }
                } else if (byte >= 0x20 && byte < 0x7f) { // Printable
                  filter += String.fromCharCode(byte);
                  filtered = getFiltered();
                  cursor = 0;
                  render();
                }
              }
            };
            process.stdin.on('data', onKey);
          });
        }

        try {
          // Step 1: Prompt
          prompt = await rawInput(chalk.bold('  Prompt: '));
          if (!prompt.trim()) return;

          // Step 2: Model
          let checkpoints: string[] = [];
          try { checkpoints = await fetchModels(); } catch { /* Canvas offline */ }
          if (checkpoints.length > 0) {
            const modelItems = [
              { name: chalk.dim('auto') + ' (let Canvas decide)', value: '__auto__' },
              ...checkpoints.map(m => ({ name: m, value: m })),
            ];
            const modelChoice = await rawPicker('Model', modelItems);
            if (modelChoice !== '__auto__') modelHint = modelChoice;
          }

          // Step 3: Style
          style = await rawPicker('Style', [
            { name: 'anime', value: 'anime' },
            { name: 'realistic', value: 'realistic' },
            { name: 'illustration', value: 'illustration' },
            { name: 'cinematic', value: 'cinematic' },
            { name: 'concept art', value: 'concept_art' },
            { name: 'auto (default)', value: '' },
          ]) || undefined;

          // Step 4: Tier
          tier = await rawPicker('Tier', [
            { name: 'auto (server decides)', value: 'auto' },
            { name: 'lightning (instant, ~1s)', value: 'lightning' },
            { name: 'turbo (fast, ~3s)', value: 'turbo' },
            { name: 'quality (detailed, ~15s)', value: 'quality' },
            { name: 'ultra (publication, ~45s)', value: 'ultra' },
          ]);

          // Step 5: Size
          const sizeChoice = await rawPicker('Size', [
            { name: '1024x1024 (square)', value: '1024x1024' },
            { name: '1280x720 (landscape)', value: '1280x720' },
            { name: '720x1280 (portrait)', value: '720x1280' },
            { name: '1536x1024 (wide)', value: '1536x1024' },
            { name: '512x512 (fast)', value: '512x512' },
          ]);
          if (sizeChoice) {
            const [w, h] = sizeChoice.split('x').map(Number);
            width = w; height = h;
          }
        } catch { return; /* Ctrl+C / Esc cancels */ }
      }

      if (!prompt) return;

      // Fuzzy-resolve model hint
      let resolvedModel: string | undefined;
      if (modelHint && !interactive) {
        // Only fuzzy-resolve in non-interactive mode; interactive already picked exact name
        let checkpoints: string[];
        try { checkpoints = await fetchModels(); } catch { checkpoints = []; }
        if (checkpoints.length) {
          resolvedModel = fuzzyMatch(checkpoints, modelHint);
          if (resolvedModel) {
            console.log(chalk.dim(`  Model: ${modelHint} → ${resolvedModel}`));
          } else {
            console.log(chalk.yellow(`  No model matching "${modelHint}". Available:`));
            for (const cp of checkpoints) console.log(chalk.dim(`    - ${cp}`));
            return;
          }
        }
      } else if (modelHint) {
        resolvedModel = modelHint; // Interactive mode already resolved
      }

      // Show summary before generating
      console.log();
      console.log(chalk.bold('  Generating:'));
      console.log(`    Prompt: ${chalk.white(prompt)}`);
      if (resolvedModel) console.log(`    Model:  ${chalk.cyan(resolvedModel)}`);
      if (style) console.log(`    Style:  ${chalk.cyan(style)}`);
      console.log(`    Tier:   ${chalk.cyan(tier)}`);
      console.log(`    Size:   ${chalk.dim(`${width}×${height}`)}`);
      console.log(`    Safety: ${chalk.dim(config?.safetyLevel || 'default')}`);
      console.log();

      const spinner = ora('Generating image...').start();
      try {
        const body: Record<string, any> = { prompt, style, resolution: `${width}x${height}`, enhance_prompt: true, tier };
        if (resolvedModel) body.preferred_model = resolvedModel;
        if (config?.safetyLevel) body.safety_level = config.safetyLevel;
        const resp = await fetch(`${canvasUrl}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300_000),
        });
        if (!resp.ok) throw new Error(`Canvas returned ${resp.status}: ${await resp.text()}`);
        const result = await resp.json() as any;
        spinner.stop();

        const inner = result?.result || result;
        const b64Images: string[] = inner?.images || [];
        const rawUrl = inner?.url || inner?.image_url || inner?.path || '';

        if (b64Images.length > 0) {
          const repoRoot = resolveImagePath('Library/Output/images').replace(/Library.*$/, '');
          const outDir = join(repoRoot, 'Library', 'Output', 'images');
          mkdirSync(outDir, { recursive: true });

          for (let i = 0; i < b64Images.length; i++) {
            const fname = `gen_${Date.now().toString(16)}${i > 0 ? `_${i}` : ''}.png`;
            const fpath = join(outDir, fname);
            writeFileSync(fpath, Buffer.from(b64Images[i], 'base64'));
            const fileUrl = `file:///${fpath.replace(/\\/g, '/')}`;
            const link = `\x1b]8;;${fileUrl}\x1b\\${chalk.cyan.underline(fpath)}\x1b]8;;\x1b\\`;
            console.log(chalk.green('  Image saved: ') + link);
          }
          const modelUsed = inner?.model_used || '';
          const seed = inner?.seed ?? '';
          if (modelUsed || seed) console.log(chalk.dim(`  Model: ${modelUsed}${seed ? ` · Seed: ${seed}` : ''}`));
        } else if (rawUrl) {
          const absPath = resolveImagePath(rawUrl);
          const fileUrl = `file:///${absPath.replace(/\\/g, '/')}`;
          const link = `\x1b]8;;${fileUrl}\x1b\\${chalk.cyan.underline(absPath)}\x1b]8;;\x1b\\`;
          console.log(chalk.green('  Image generated: ') + link);
        } else {
          console.log(chalk.yellow('  Generation completed but no images returned.'));
        }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    },
  },

  checkpoints: {
    description: 'List available image generation models (checkpoints + LoRAs)',
    usage: '/checkpoints [search term]',
    handler: async (_client, args, config) => {
      const canvasUrl = process.env.AITHER_CANVAS_URL || 'https://127.0.0.1:8108';
      const modelsQs = config?.safetyLevel ? `?safety_level=${config.safetyLevel}` : '';
      const spinner = ora('Fetching models...').start();
      try {
        const resp = await fetch(`${canvasUrl}/models${modelsQs}`, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) throw new Error(`Canvas returned ${resp.status}`);
        const data = await resp.json() as any;
        spinner.stop();
        const checkpoints: string[] = data?.checkpoints || [];
        const loras: string[] = data?.loras || [];
        const filter = args.trim().toLowerCase();

        const filteredCp = filter ? checkpoints.filter(m => m.toLowerCase().includes(filter)) : checkpoints;
        const filteredLr = filter ? loras.filter(m => m.toLowerCase().includes(filter)) : loras;

        console.log(chalk.bold(`\n  Checkpoints (${filteredCp.length}):`));
        if (!filteredCp.length) console.log(chalk.dim('    (none)'));
        for (const m of filteredCp) console.log(`    ${chalk.cyan('-')} ${m}`);

        if (filteredLr.length) {
          console.log(chalk.bold(`\n  LoRAs (${filteredLr.length}):`));
          for (const m of filteredLr) console.log(`    ${chalk.cyan('-')} ${m}`);
        }
        console.log(chalk.dim(`\n  Use with: /generate <prompt> --model <name>`));
        console.log(chalk.dim(`  Safety: ${config?.safetyLevel || 'default'} (set with /safety set <level>)\n`));
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    },
  },

  approve: {
    description: 'Approve a registered user for platform access',
    usage: '/approve <username>',
    handler: async (client, args, config) => {
      const username = args.trim();
      if (!username) {
        console.log(chalk.dim('  Usage: /approve <username>'));
        return;
      }
      const spinner = ora(`Approving ${username}...`).start();
      try {
        const token = getActiveToken();
        if (!token) {
          spinner.stop();
          console.log(chalk.red('  Not logged in. Use /login first.'));
          return;
        }
        const url = `${config.identityUrl}/admin/users/${encodeURIComponent(username)}/approve`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        const result = await resp.json() as any;
        spinner.stop();
        if (resp.ok) {
          const status = result.status === 'already_approved' ? chalk.yellow('already approved') : chalk.green('approved');
          console.log(`  ${chalk.bold(username)}: ${status}`);
        } else {
          console.log(chalk.red(`  Error: ${result.detail || resp.statusText}`));
        }
      } catch (e: any) {
        spinner.stop();
        console.log(chalk.red(`  Error: ${e.message}`));
      }
    },
  },

  rbac: {
    description: 'Manage roles, users, and groups',
    usage: '/rbac [users|roles|groups|check <user> <permission>]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'users').toLowerCase();
      const endpoints: Record<string, string> = { users: '/rbac/users', roles: '/rbac/roles', groups: '/rbac/groups' };
      const endpoint = endpoints[sub];
      if (endpoint) {
        const spinner = ora(`Loading ${sub}...`).start();
        try {
          const result = await client.get(endpoint) as any;
          spinner.stop();
          const items = result?.items || result?.users || result?.roles || result?.groups || [];
          console.log();
          for (const item of items.slice(0, 20)) {
            const name = item.name || item.username || item.id;
            const detail = item.role || item.permissions?.length ? `(${item.permissions?.length || 0} perms)` : '';
            console.log(`  ${chalk.cyan('-')} ${name} ${chalk.dim(detail)}`);
          }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'check' && parts[1] && parts[2]) {
        const spinner = ora('Checking permission...').start();
        try {
          const result = await client.post('/rbac/check', { user: parts[1], permission: parts[2] }) as any;
          spinner.stop();
          const allowed = result?.allowed ?? result?.granted ?? false;
          console.log(allowed ? chalk.green(`  ${parts[1]} has ${parts[2]}`) : chalk.red(`  ${parts[1]} lacks ${parts[2]}`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else {
        console.log(chalk.dim('  Usage: /rbac [users|roles|groups|check <user> <permission>]'));
      }
    },
  },

  acc: {
    description: 'AVEC code analysis via ACC engine',
    usage: '/acc [node <id>|friction|unstable|stats]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'stats').toLowerCase();
      if (sub === 'stats') {
        const spinner = ora('Loading ACC stats...').start();
        try {
          const result = await client.get('/acc/stats');
          spinner.stop();
          console.log(); console.log(JSON.stringify(result, null, 2)); console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'node' && parts[1]) {
        const spinner = ora(`Analyzing ${parts[1]}...`).start();
        try {
          const result = await client.get(`/acc/node/${encodeURIComponent(parts[1])}`) as any;
          spinner.stop();
          console.log();
          if (result?.avec) {
            const a = result.avec;
            console.log(`  ${chalk.bold(result.name || parts[1])}`);
            console.log(`  Stability: ${chalk.cyan(String(a.stability?.toFixed(2) ?? '?'))}  Friction: ${chalk.yellow(String(a.friction?.toFixed(2) ?? '?'))}  Logic: ${chalk.green(String(a.logic?.toFixed(2) ?? '?'))}  Autonomy: ${chalk.magenta(String(a.autonomy?.toFixed(2) ?? '?'))}`);
          } else { console.log(JSON.stringify(result, null, 2)); }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'friction') {
        const spinner = ora('Finding high-friction nodes...').start();
        try {
          const result = await client.get('/acc/high-friction') as any;
          spinner.stop();
          const nodes = result?.nodes || [];
          console.log();
          for (const n of nodes.slice(0, 15)) { console.log(`  ${chalk.yellow(String(n.friction?.toFixed(2)))}  ${n.name || n.id}`); }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'unstable') {
        const spinner = ora('Finding unstable nodes...').start();
        try {
          const result = await client.get('/acc/unstable') as any;
          spinner.stop();
          const nodes = result?.nodes || [];
          console.log();
          for (const n of nodes.slice(0, 15)) { console.log(`  ${chalk.red(String(n.stability?.toFixed(2)))}  ${n.name || n.id}`); }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else {
        console.log(chalk.dim('  Usage: /acc [node <id>|friction|unstable|stats]'));
      }
    },
  },

  sttp: {
    description: 'Session memory via STTP',
    usage: '/sttp [calibrate|store <content>|get|list]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'list').toLowerCase();
      if (sub === 'list') {
        const spinner = ora('Loading STTP nodes...').start();
        try {
          const result = await client.get('/sttp/nodes') as any;
          spinner.stop();
          const nodes = result?.nodes || [];
          if (!nodes.length) { console.log(chalk.dim('  No STTP nodes.')); return; }
          console.log();
          for (const n of nodes.slice(0, 10)) { console.log(`  ${chalk.cyan('-')} ${n.label || n.id} ${chalk.dim(n.session_id?.slice(0, 8) || '')}`); }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'store') {
        const content = parts.slice(1).join(' ');
        if (!content) { console.log(chalk.dim('  Usage: /sttp store <content>')); return; }
        const spinner = ora('Storing context...').start();
        try {
          const result = await client.post('/sttp/store', { content, source: 'aither-shell' }) as any;
          spinner.stop();
          console.log(chalk.green(`  Stored: ${result?.node_id || 'OK'}`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'get') {
        const spinner = ora('Retrieving context...').start();
        try {
          const result = await client.get('/sttp/context');
          spinner.stop();
          console.log(); console.log(JSON.stringify(result, null, 2)); console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'calibrate') {
        const spinner = ora('Calibrating session...').start();
        try {
          const result = await client.post('/sttp/calibrate', { source: 'aither-shell' }) as any;
          spinner.stop();
          console.log(chalk.green(`  Calibrated. Drift: ${result?.drift?.toFixed(3) ?? '?'}`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else {
        console.log(chalk.dim('  Usage: /sttp [calibrate|store <content>|get|list]'));
      }
    },
  },

  stacks: {
    description: 'Switch model stacks',
    usage: '/stacks [list|switch <name>|status]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'status').toLowerCase();
      if (sub === 'status') {
        const spinner = ora('Loading active stack...').start();
        try {
          const result = await client.get('/model-stacks/active') as any;
          spinner.stop();
          console.log();
          console.log(`  Active: ${chalk.bold.cyan(result?.name || result?.stack || 'default')}`);
          if (result?.models) { for (const [k, v] of Object.entries(result.models)) { console.log(`    ${chalk.dim(k)}: ${v}`); } }

          // ── Effort → tier → model routing table ──
          // Surfaces exactly which model serves each effort level so a misroute
          // (e.g. a chat turn going straight to a DGX/reasoning model instead of
          // the orchestrator) is obvious at a glance. DOCTRINE: every chat tier
          // should serve from the default agent; the DGX is only the `reason` tool.
          const routing = result?.routing || result?.info?.routing || {};
          const e2t = routing.effort_to_tier || {};
          const tb = routing.tier_backends || {};
          if (Object.keys(e2t).length) {
            console.log();
            console.log(chalk.bold('  Effort → tier → model (what serves each turn):'));
            for (let e = 1; e <= 10; e++) {
              const tier = e2t[String(e)] || e2t[e];
              if (!tier) continue;
              const cfg = tb[tier] || {};
              const model = cfg.model || '(default)';
              // Flag anything that is NOT the orchestrator serving a chat turn.
              const offOrch = model && !String(model).startsWith(DEFAULT_AGENT) && tier !== 'vision';
              const line = `    effort ${String(e).padStart(2)} → ${String(tier).padEnd(10)} → ${model}`;
              console.log(offOrch ? chalk.yellow(line + '  ⚠ not orchestrator') : chalk.dim(line));
              if (cfg.reasoning_model) {
                console.log(chalk.dim(`                 ↳ reason tool → ${cfg.reasoning_model}`));
              }
            }
          }
          const reasonTool = result?.info?.tools?.reason;
          if (reasonTool?.model) {
            console.log();
            console.log(`  reason tool: ${chalk.cyan(reasonTool.model)} ${chalk.dim('(' + (reasonTool.invoked_when || 'orchestrator-invoked') + ')')}`);
          }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'list') {
        const spinner = ora('Loading stacks...').start();
        try {
          const result = await client.get('/model-stacks') as any;
          spinner.stop();
          const stcks = result?.stacks || result?.items || [];
          console.log();
          for (const s of stcks) {
            const active = s.active ? chalk.green(' (active)') : '';
            console.log(`  ${chalk.cyan('-')} ${s.name || s.id}${active}`);
          }
          console.log();
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else if (sub === 'switch' && parts[1]) {
        const spinner = ora(`Switching to ${parts[1]}...`).start();
        try {
          await client.post('/model-stacks/switch', { stack: parts[1] });
          spinner.stop();
          console.log(chalk.green(`  Switched to: ${parts[1]}`));
        } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
      } else {
        console.log(chalk.dim('  Usage: /stacks [list|switch <name>|status]'));
      }
    },
  },

  image: {
    description: 'Attach image(s) for the next chat message',
    usage: '/image <path> [path2 ...] — images persist until next chat message',
    handler: async (_client, args, config) => {
      const paths = args.trim().split(/\s+/).filter(Boolean);
      if (paths.length === 0) {
        console.log(chalk.dim('  Usage: /image <path> [path2 ...]'));
        console.log(chalk.dim('  Attaches image(s) to your next chat message for vision analysis.'));
        if (config.imageAttachments?.length) {
          console.log(chalk.cyan(`  Currently queued: ${config.imageAttachments.length} image(s)`));
        }
        return;
      }
      const { readFileSync } = await import('fs');
      const { extname } = await import('path');
      config.imageAttachments = config.imageAttachments || [];
      const mimeMap: Record<string, string> = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' };
      for (const p of paths) {
        try {
          const buf = readFileSync(p);
          const ext = extname(p).toLowerCase().replace('.', '');
          const mime = mimeMap[ext] || 'png';
          config.imageAttachments.push(`data:image/${mime};base64,${buf.toString('base64')}`);
          console.log(chalk.green(`  Attached: ${p} (${(buf.length / 1024).toFixed(0)} KB)`));
        } catch (e: any) {
          console.log(chalk.red(`  Cannot read: ${p} — ${e.message}`));
        }
      }
      console.log(chalk.cyan(`  ${config.imageAttachments.length} image(s) queued for next message.`));
    },
  },

  imagine: {
    description: 'Generate an image (Sana / ComfyUI / Gemini / OpenAI)',
    usage: '/imagine <prompt> [--backend sana|comfyui|gemini|openai] [--model <name>] [-w 1024] [-h 1024] [-o out.png]  |  /imagine backends  |  /imagine models',
    handler: async (client: GenesisClient, args: string, config: ShellConfig) => {
      const BACKENDS = ['sana', 'comfyui', 'gemini', 'openai'];
      const LABELS: Record<string, string> = {
        sana: 'Local · Sana (fast Linear DiT, keyless)',
        comfyui: 'Local · ComfyUI (full SDXL workflows)',
        gemini: 'Cloud · Gemini / Imagen (BYOK)',
        openai: 'Cloud · OpenAI gpt-image-1 / DALL·E (BYOK)',
      };
      const trimmed = args.trim();

      // The image API (/api/canvas/generate, /api/canvas/models) is a VEIL route
      // (port 3000), NOT Genesis (8001) which `client` is bound to. Derive the
      // Veil base from the Genesis URL (swap port → 3000) with env override.
      const veilBase = (process.env.AITHER_VEIL_URL
        || client.baseUrl.replace(/:\d+($|\/)/, ':3000$1')
        || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const authToken = config.authToken;
      const veilFetch = async (path: string, init: RequestInit = {}) => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...((init.headers as Record<string, string>) || {}),
        };
        return fetch(`${veilBase}${path}`, { ...init, headers });
      };

      if (trimmed === 'backends') {
        console.log(chalk.bold('\nImage generation backends:\n'));
        for (const b of BACKENDS) {
          const def = b === 'sana' ? chalk.green('  (default)') : '';
          console.log(`  ${chalk.cyan(b.padEnd(8))} ${LABELS[b]}${def}`);
        }
        console.log(chalk.dim('\n  Use:  /imagine a fox --backend sana\n'));
        return;
      }

      if (trimmed === 'models') {
        const spinner = ora('Fetching installed image models...').start();
        try {
          const res = await veilFetch('/api/canvas/models');
          const data = await res.json().catch(() => ({})) as any;
          const allCkpts = (data?.models || []).filter((m: any) => m.type === 'checkpoint');
          // BOTH halves of the gate, not one: an explicit per-account opt-in
          // (isAdultContentVisible) AND a safety level that allows it. Keying on
          // the safety level alone revealed the tier to accounts that never
          // opted in. Fails CLOSED: any error resolves to false.
          const adultVisible = await isAdultContentVisible(client).catch(() => false);
          const levelAllows = ADULT_TIERS.includes((config.safetyLevel || '').toLowerCase());
          const allowNsfw = adultVisible && levelAllows;
          const ckpts = allowNsfw ? allCkpts : allCkpts.filter((m: any) => !m.nsfw);
          spinner.succeed(`${ckpts.length} installed checkpoint(s):`);
          for (const m of ckpts) console.log(`  ${chalk.cyan(m.id)}${m.nsfw ? chalk.dim(' (nsfw)') : ''}`);
          // No "(N hidden — set safety to explicit to show)" hint. A count of
          // withheld items announces the existence of what the gate is hiding,
          // which is the disclosure this gate exists to stop. Only an account that
          // has already passed BOTH halves may learn these models exist.
          console.log(chalk.dim('\n  Use:  /imagine a fox --backend comfyui --model <name>'));
          console.log(chalk.dim('  (Sana: --model sprint for one-step fast mode)\n'));
        } catch (err: any) {
          spinner.fail(`Failed to list models: ${err.message}`);
        }
        return;
      }

      const flag = (re: RegExp, def?: string): string | undefined => {
        const m = args.match(re);
        return m ? m[1] : def;
      };
      const backend = (flag(/--backend\s+(\S+)/) || flag(/-b\s+(\S+)/) || 'sana').toLowerCase();
      const model = flag(/--model\s+(\S+)/) || flag(/-m\s+(\S+)/);
      const width = parseInt(flag(/--width\s+(\d+)/) || flag(/-w\s+(\d+)/) || '1024');
      const height = parseInt(flag(/--height\s+(\d+)/) || flag(/-h\s+(\d+)/) || '1024');
      const steps = parseInt(flag(/--steps\s+(\d+)/) || '20');
      const output = flag(/--output\s+(\S+)/) || flag(/-o\s+(\S+)/);
      const negative = flag(/--negative\s+"([^"]+)"/) || flag(/--negative\s+(\S+)/);

      const prompt = args
        .replace(/--(backend|model|width|height|steps|output|negative)\s+("[^"]+"|\S+)/g, '')
        .replace(/-[bmwho]\s+\S+/g, '')
        .replace(/^["']|["']$/g, '')
        .trim();

      if (!prompt) {
        console.log(chalk.yellow('  Usage: /imagine <prompt> [--backend sana|comfyui|gemini|openai] [--model <name>] [-w 1024] [-h 1024] [-o out.png]'));
        console.log(chalk.dim('         /imagine backends   — list backends'));
        console.log(chalk.dim('         /imagine models     — list installed ComfyUI checkpoints'));
        return;
      }
      if (!BACKENDS.includes(backend)) {
        console.log(chalk.red(`  Unknown backend "${backend}". Choose: ${BACKENDS.join(', ')}`));
        return;
      }

      const spinner = ora(`Generating via ${chalk.cyan(backend)} (${veilBase})...`).start();
      try {
        const res = await veilFetch('/api/canvas/generate', {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            provider: backend,
            negative_prompt: negative || '',
            width, height, steps,
            preferred_model: model || undefined,
            model: model || undefined,
            batch_size: 1,
            safety_level: config.safetyLevel || 'OFF',
          }),
        });
        const data = await res.json().catch(() => ({})) as any;
        if (!res.ok || data?.success === false) {
          const hint = data?.needsKey ? ` — add a ${backend} key under Settings → Integrations` : '';
          spinner.fail(`Generation failed (HTTP ${res.status}): ${data?.error || 'unknown'}${hint}`);
          return;
        }
        const images: string[] = data?.images || (data?.image ? [data.image] : []);
        if (!images.length) {
          spinner.fail(`No image returned by ${backend}. (Is the Veil API at ${veilBase}? Override with AITHER_VEIL_URL.)`);
          return;
        }
        spinner.succeed(`Image generated via ${backend}${data?.model ? ` (${data.model})` : ''}!`);
        const { resolve: resolvePath } = await import('node:path');
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          const base = (output || `aither-image-${Date.now()}.png`).replace(/\.png$/i, '');
          const outPath = images.length > 1 ? `${base}-${i}.png` : `${base}.png`;
          if (img.startsWith('data:') || /^[A-Za-z0-9+/=]{40,}/.test(img)) {
            writeFileSync(outPath, Buffer.from(img.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
          } else {
            // http(s) URL or a Veil-relative path (e.g. /api/canvas/image?...)
            const imgRes = img.startsWith('http')
              ? await fetch(img)
              : await veilFetch(img);
            writeFileSync(outPath, Buffer.from(await imgRes.arrayBuffer()));
          }
          // Absolute path + clickable link, and register as a session artifact so
          // /get and /artifacts can find it (matches how chat-generated images work).
          const absPath = resolvePath(outPath);
          let sz = 0;
          try { sz = statSync(absPath).size; } catch { /* size optional */ }
          const idx = addSessionArtifact({ path: absPath, size: sz, language: 'image' });
          console.log(chalk.green(`  Saved: ${osc8Link(`file://${absPath.replace(/\\/g, '/')}`, absPath)}`));
          console.log(chalk.dim(`  Artifact #${idx} — /get ${idx} to copy it here`));
        }
      } catch (err: any) {
        spinner.fail(`Error: ${err.message}`);
      }
    },
  },

  speak: {
    description: 'Text-to-speech via Lyra',
    usage: '/speak <text> [--voice <name>]',
    handler: async (client: GenesisClient, args: string) => {
      let text = args;
      let voice: string | undefined;
      const voiceMatch = args.match(/--voice\s+(\S+)/);
      if (voiceMatch) { voice = voiceMatch[1]; text = text.replace(voiceMatch[0], ''); }
      text = text.trim();
      if (!text) { console.log(chalk.dim('  Usage: /speak <text> [--voice <name>]')); return; }
      const spinner = ora('Synthesizing speech...').start();
      try {
        const result = await client.post('/voice/synthesize', { text, voice }) as any;
        spinner.stop();
        const url = result?.url || result?.audio_url || '';
        if (url) { console.log(chalk.green(`  Audio: ${url}`)); }
        else { console.log(chalk.green('  Speech synthesized.')); }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    },
  },

  cloud: {
    description: 'Deploy models to cloud GPUs (Vast.ai/RunPod)',
    usage: '/cloud [models|offers|deploy <model>|status [id]|active|teardown <id>|cost <model>|billing]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'help').toLowerCase();

      if (sub === 'help' || sub === '?') {
        console.log();
        console.log(chalk.bold('  Cloud GPU Deployment'));
        console.log();
        console.log(chalk.cyan('  Quick start:'));
        console.log(chalk.dim('    /cloud models                   — Browse deployable models'));
        console.log(chalk.dim('    /cloud cost reasoning            — Estimate before deploying'));
        console.log(chalk.dim('    /cloud deploy reasoning          — Deploy (one command)'));
        console.log(chalk.dim('    /cloud status                    — Check all deployments'));
        console.log();
        console.log(chalk.cyan('  Full commands:'));
        console.log(chalk.dim('    /cloud models                   — List Aither-optimized models'));
        console.log(chalk.dim('    /cloud offers [model] [provider] — Browse GPU marketplace'));
        console.log(chalk.dim('    /cloud cost <model>             — Estimate hourly cost'));
        console.log(chalk.dim('    /cloud deploy <model> [provider] — Start deployment'));
        console.log(chalk.dim('    /cloud status [session_id]      — Check deployment status'));
        console.log(chalk.dim('    /cloud active                   — List running deployments'));
        console.log(chalk.dim('    /cloud billing                  — GPU spend summary'));
        console.log(chalk.dim('    /cloud teardown <session_id>    — Tear down + stop billing'));
        console.log(chalk.dim('    /cloud profiles                 — Show cloud_node_profiles'));
        console.log();
      } else if (sub === 'models') {
        const spinner = ora('Fetching model catalog...').start();
        const result = await client.get('/deploy/cloud-model/profiles') as any;
        spinner.stop();
        const profiles = result?.profiles || [];
        // Also show curated catalog
        console.log();
        console.log(chalk.bold('  Aither-Optimized Models'));
        console.log(chalk.dim('  Use model name with: /cloud deploy <name>'));
        console.log();
        const curated = [
          { name: 'orchestrator', desc: '8B tool-calling + agent dispatch', vram: '16GB' },
          { name: 'reasoning', desc: '14B deep reasoning (DeepSeek R1)', vram: '24GB' },
          { name: 'gemma4_reasoning', desc: '26B MoE reasoning (4B active)', vram: '24GB' },
          { name: 'vision_voice', desc: '7B multimodal vision + language', vram: '16GB' },
          { name: 'research', desc: '30B deep research (MiroThinker)', vram: '48GB' },
          { name: 'gemma4_e4b', desc: '4B edge model (low cost)', vram: '8GB' },
        ];
        for (const m of curated) {
          const available = profiles.includes?.(m.name) ? chalk.green(' ✓') : '';
          console.log(`  ${chalk.cyan(m.name.padEnd(20))} ${m.desc}  ${chalk.dim(m.vram)}${available}`);
        }
        if (profiles.length) {
          console.log();
          console.log(chalk.dim(`  ${profiles.length} profiles in cloud_node_profiles.yaml`));
        }
        console.log();
      } else if (sub === 'offers') {
        const model = parts[1] || '';
        const minVram = model ? 0 : 24;
        const spinner = ora('Searching GPU marketplace...').start();
        const result = await client.get(`/deploy/cloud-model/marketplace?min_vram_gb=${minVram}&max_price_per_hour=1.0&limit=10`) as any;
        spinner.stop();
        const offers = result?.offers || [];
        if (!offers.length) { console.log(chalk.dim('  No GPU offers found. Check provider API keys.')); return; }
        console.log();
        console.log(chalk.bold('  GPU Marketplace'));
        console.log();
        for (const o of offers.slice(0, 10)) {
          const gpu = o.gpu_model || o.gpu_name || '?';
          const vram = o.vram_gb || o.gpu_vram_gb || '?';
          const price = o.price_per_hour != null ? `$${Number(o.price_per_hour).toFixed(3)}/hr` : '';
          const id = o.offer_id || o.id || '?';
          console.log(`  ${chalk.dim(String(id).padEnd(8))} ${chalk.cyan(String(gpu).padEnd(14))} ${String(vram).padEnd(4)}GB  ${chalk.yellow(price)}`);
        }
        console.log();
        console.log(chalk.dim('  Deploy to a specific offer: /cloud deploy <model> --offer <id>'));
        console.log();
      } else if (sub === 'cost' || sub === 'estimate') {
        const model = parts[1];
        if (!model) { console.log(chalk.dim('  Usage: /cloud cost <model>')); return; }
        const spinner = ora(`Estimating cost for ${model}...`).start();
        const result = await client.post('/deploy/cloud-model/estimate', { model }) as any;
        spinner.stop();
        console.log();
        if (result?.error) { console.log(chalk.yellow(`  ${result.error}`)); return; }
        const est = result?.estimate || result;
        console.log(chalk.bold(`  Cost Estimate: ${model}`));
        if (est.vram_estimate_gb) console.log(`  VRAM needed:  ${est.vram_estimate_gb} GB`);
        if (est.cheapest_offer) {
          console.log(`  Cheapest GPU: ${est.cheapest_offer.gpu_model} — $${Number(est.cheapest_offer.price_per_hour).toFixed(3)}/hr`);
        }
        if (est.hourly_cost) console.log(`  Hourly cost:  $${Number(est.hourly_cost).toFixed(3)}`);
        if (est.daily_cost) console.log(`  Daily cost:   $${Number(est.daily_cost).toFixed(2)}`);
        console.log();
        console.log(chalk.dim(`  Deploy: /cloud deploy ${model}`));
        console.log();
      } else if (sub === 'deploy') {
        const model = parts[1];
        if (!model) { console.log(chalk.dim('  Usage: /cloud deploy <model> [--offer <id>]')); return; }
        const offerIdx = parts.indexOf('--offer');
        const offerId = offerIdx >= 0 ? parts[offerIdx + 1] : '';
        const maxPrice = parts.includes('--max-price') ? parseFloat(parts[parts.indexOf('--max-price') + 1]) : 0;

        // Show cost estimate first
        console.log(chalk.dim(`  Estimating cost for ${model}...`));
        const est = await client.post('/deploy/cloud-model/estimate', { model }) as any;
        if (est?.cheapest_offer) {
          console.log(chalk.dim(`  Estimated: ~$${Number(est.cheapest_offer.price_per_hour).toFixed(3)}/hr on ${est.cheapest_offer.gpu_model}`));
        }

        const spinner = ora(`Deploying ${model}...`).start();
        const payload: Record<string, any> = { model };
        if (offerId) payload.offer_id = offerId;
        if (maxPrice) payload.max_price_per_hour = maxPrice;
        const result = await client.post('/deploy/cloud-model', payload) as any;
        spinner.stop();
        if (result?.session_id) {
          console.log(chalk.green(`  ✓ Deployment started: ${result.session_id}`));
          if (result.phase) console.log(chalk.dim(`  Phase: ${result.phase}`));
          console.log(chalk.dim(`  Track: /cloud status ${result.session_id}`));
        } else {
          console.log(chalk.yellow('  ' + (result?.error || 'Deploy failed.')));
        }
      } else if (sub === 'status') {
        const id = parts[1];
        if (!id) {
          const spinner = ora('Fetching deployments...').start();
          const result = await client.get('/deploy/cloud-model/sessions?active_only=true') as any;
          spinner.stop();
          const sessions = result?.sessions || result?.deployments || [];
          if (!sessions.length) { console.log(chalk.dim('  No active deployments. Use: /cloud deploy <model>')); return; }
          console.log();
          console.log(chalk.bold('  Cloud Deployments'));
          console.log();
          for (const s of sessions) {
            const phase = s.phase || s.status || '?';
            const phaseColor = phase === 'complete' || phase === 'completed' ? chalk.green(phase) : chalk.yellow(phase);
            const cost = s.price_per_hour != null ? chalk.dim(` $${Number(s.price_per_hour).toFixed(3)}/hr`) : '';
            console.log(`  ${chalk.cyan((s.session_id || s.id || '?').substring(0, 12))}  ${(s.model || s.served_name || '?').padEnd(20)} ${phaseColor}${cost}`);
          }
          console.log();
        } else {
          const spinner = ora(`Fetching status for ${id}...`).start();
          const result = await client.get(`/deploy/cloud-model/status/${id}`) as any;
          spinner.stop();
          const s = result?.session || result;
          console.log();
          console.log(`  Session: ${chalk.cyan(id)}`);
          console.log(`  Phase:   ${s.phase || '?'}`);
          if (s.model) console.log(`  Model:   ${s.model}`);
          if (s.served_name) console.log(`  Served:  ${s.served_name}`);
          if (s.gpu_model) console.log(`  GPU:     ${s.gpu_model}`);
          if (s.vllm_url) console.log(`  URL:     ${chalk.green(s.vllm_url)}`);
          if (s.price_per_hour != null) console.log(`  Cost:    $${Number(s.price_per_hour).toFixed(3)}/hr`);
          if (s.backend_name) console.log(`  Backend: ${s.backend_name} (in LLMQueue)`);
          console.log();
        }
      } else if (sub === 'active') {
        const spinner = ora('Fetching active deployments...').start();
        const result = await client.get('/deploy/cloud-model/sessions?active_only=true') as any;
        spinner.stop();
        const sessions = result?.sessions || result?.deployments || [];
        if (!sessions.length) { console.log(chalk.dim('  No active cloud deployments.')); return; }
        console.log();
        console.log(chalk.bold('  Active Cloud Deployments'));
        for (const s of sessions) {
          const phase = s.phase || s.status || '?';
          const phaseColor = phase === 'complete' || phase === 'completed' ? chalk.green(phase) : chalk.yellow(phase);
          console.log(`  ${chalk.cyan((s.session_id || s.id || '?').substring(0, 12))}  ${(s.model || '?').padEnd(20)} ${phaseColor}  ${s.gpu_model || ''}`);
        }
        console.log();
      } else if (sub === 'teardown' && parts[1]) {
        const spinner = ora(`Tearing down ${parts[1]}...`).start();
        const result = await client.post(`/deploy/cloud-model/teardown/${parts[1]}`, {}) as any;
        spinner.stop();
        console.log(result?.ok || result?.torn_down ? chalk.green('  ✓ Torn down. Billing stopped.') : chalk.yellow('  ' + (result?.error || 'Teardown failed.')));
      } else if (sub === 'billing') {
        const spinner = ora('Fetching billing summary...').start();
        const result = await client.get('/deploy/cloud-model/billing') as any;
        spinner.stop();
        console.log();
        console.log(chalk.bold('  GPU Billing'));
        if (result?.total_hourly_burn != null) console.log(`  Burn rate:  $${Number(result.total_hourly_burn).toFixed(3)}/hr`);
        if (result?.active_count != null) console.log(`  Active:     ${result.active_count} deployments`);
        if (result?.total_spend != null) console.log(`  Total spent: $${Number(result.total_spend).toFixed(2)}`);
        console.log();
      } else if (sub === 'profiles') {
        const spinner = ora('Fetching profiles...').start();
        const result = await client.get('/deploy/cloud-model/profiles') as any;
        spinner.stop();
        const profiles = result?.profiles || {};
        console.log();
        console.log(chalk.bold('  Cloud Node Profiles'));
        console.log();
        if (Array.isArray(profiles)) {
          for (const p of profiles) console.log(`  ${chalk.cyan(p)}`);
        } else {
          for (const [name, cfg] of Object.entries(profiles)) {
            const c = cfg as any;
            console.log(`  ${chalk.cyan(name.padEnd(20))} ${c.model || ''} ${chalk.dim(c.min_vram_gb ? `${c.min_vram_gb}GB` : '')}`);
          }
        }
        console.log();
      } else {
        console.log(chalk.dim('  Unknown subcommand. Use /cloud help'));
      }
    },
  },

  // ── Per-role API key management ──
  keys: {
    description: 'Manage per-role API key environment variables',
    usage: '/keys set <orchestrator|reasoning|perception> <ENV_VAR_NAME>',
    handler: async (_client: GenesisClient, _args: string, _config: ShellConfig) => {
      console.log(chalk.yellow('  Use /keys in the interactive shell to configure per-role keys:'));
      console.log(chalk.dim('    /keys set orchestrator DEEPSEEK_API_KEY'));
      console.log(chalk.dim('    /keys set reasoning AITHER_REASONING_KEY'));
      console.log(chalk.dim('  Or set env vars: AITHER_ORCHESTRATOR_KEY_ENV, etc.'));
    },
  },

};

// ── /sessions command ──
COMMANDS['sessions'] = {
  description: 'List or inspect saved session traces',
  usage: '/sessions [session_id]',
  handler: async (_client, args) => {
    const sessRoot = join(homedir(), '.aither', 'sessions');
    if (!existsSync(sessRoot)) {
      console.log(chalk.dim('  No session traces found yet.'));
      return;
    }
    const sessionArg = args.trim();
    if (!sessionArg) {
      // List all sessions with most recent trace
      const dirs = readdirSync(sessRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
          const files = readdirSync(join(sessRoot, d.name)).filter(f => f.endsWith('.json')).sort();
          const latest = files.length > 0 ? files[files.length - 1] : null;
          let prompt = '';
          let events = 0;
          if (latest) {
            try {
              const data = JSON.parse(readFileSync(join(sessRoot, d.name, latest), 'utf-8'));
              prompt = data.prompt || '';
              events = data.event_count || 0;
            } catch { /* ignore */ }
          }
          return { id: d.name, traces: files.length, prompt: prompt.slice(0, 60), events };
        })
        .sort((a, b) => b.traces - a.traces);

      console.log(chalk.bold('\n  Session Traces\n'));
      for (const s of dirs.slice(0, 30)) {
        console.log(`  ${chalk.cyan(s.id)}  ${chalk.dim(`${s.traces} traces, ${s.events} events`)}  ${chalk.white(s.prompt)}`);
      }
      if (dirs.length > 30) console.log(chalk.dim(`  ... and ${dirs.length - 30} more`));
      console.log();
    } else {
      // Show details of a specific session
      const sessDir = join(sessRoot, sessionArg);
      if (!existsSync(sessDir)) {
        console.log(chalk.red(`  Session not found: ${sessionArg}`));
        return;
      }
      const files = readdirSync(sessDir).filter(f => f.endsWith('.json')).sort();
      console.log(chalk.bold(`\n  Session ${sessionArg} — ${files.length} traces\n`));
      for (const file of files) {
        try {
          const data = JSON.parse(readFileSync(join(sessDir, file), 'utf-8'));
          const duration = data.duration_ms ? `${Math.round(data.duration_ms / 1000)}s` : '?';
          const toolCount = (data.tool_calls || []).length;
          const errCount = (data.errors || []).length;
          const model = data.model || '?';
          console.log(`  ${chalk.dim(file.replace('.json', ''))}  ${chalk.white(data.prompt?.slice(0, 50) || '(no prompt)')}`);
          console.log(chalk.dim(`    ${model} | ${data.event_count || 0} events | ${toolCount} tools | ${errCount} errors | ${duration}`));
          if (data.thinking_traces?.length) {
            console.log(chalk.dim(`    Thinking: ${data.thinking_traces.length} traces`));
          }
        } catch { /* ignore */ }
      }
      console.log();
    }
  },
};

// ── /artifacts command ──
COMMANDS['artifacts'] = {
  description: 'List all artifacts produced in this session',
  usage: '/artifacts [clear]',
  handler: async (_client, args) => {
    if (args.trim() === 'clear') {
      clearSessionArtifacts();
      console.log(chalk.dim('  Artifact mailbox cleared.'));
      return;
    }

    const artifacts = getSessionArtifacts();
    if (artifacts.length === 0) {
      console.log(chalk.dim('  No artifacts produced yet. Run a code generation task first.'));
      return;
    }

    console.log(chalk.bold(`\n  📦 Artifacts (${artifacts.length})\n`));
    for (let i = 0; i < artifacts.length; i++) {
      const art = artifacts[i];
      const sizeStr = art.size > 1024
        ? `${(art.size / 1024).toFixed(1)} KB`
        : `${art.size} bytes`;
      const timeStr = new Date(art.timestamp).toLocaleTimeString();
      console.log(`  ${chalk.cyan(`#${i + 1}`)} ${chalk.white.bold(art.filename)} ${chalk.dim(`(${sizeStr})`)} ${chalk.dim(timeStr)}`);
    }
    console.log(chalk.cyan(`\n  /get <N>`) + chalk.dim(` to download  ·  `) + chalk.cyan(`/get all`) + chalk.dim(` to download all\n`));
  },
};

// ── /get command ──
COMMANDS['get'] = {
  description: 'Download an artifact by number or "all" (from /artifacts list)',
  usage: '/get <number|all> [dest_path]',
  handler: async (client, args) => {
    const artifacts = getSessionArtifacts();
    if (artifacts.length === 0) {
      console.log(chalk.dim('  No artifacts to download.'));
      return;
    }

    const parts = args.trim().split(/\s+/);
    const selector = parts[0] || '';
    const customDest = parts.slice(1).join(' ');

    // Determine which artifacts to download
    let indices: number[];
    if (selector === 'all') {
      indices = artifacts.map((_, i) => i);
    } else {
      const num = parseInt(selector, 10);
      if (isNaN(num) || num < 1 || num > artifacts.length) {
        console.log(chalk.red(`  Usage: /get <1-${artifacts.length}|all> [dest_path]`));
        return;
      }
      indices = [num - 1];
    }

    for (const idx of indices) {
      const art = artifacts[idx];
      const dest = customDest || `./${art.filename}`;
      await _downloadArtifact(client, art, idx + 1, dest);
    }
  },
};

/** Download a single artifact — HTTP first, docker cp fallback. */
async function _downloadArtifact(
  client: GenesisClient,
  art: SessionArtifact,
  num: number,
  dest: string,
) {
  const filename = basename(dest) || art.filename;
  const destPath = resolve(dest);
  console.log(chalk.dim(`  Downloading #${num}: ${art.filename}...`));

  // 1) Try HTTP download via Genesis /files/ endpoint
  if (art.download_url || art.path) {
    try {
      let url = art.download_url || '';
      if (!url && art.path) {
        // Build from absolute container path
        let rel = art.path;
        for (const prefix of ['/app/AitherOS/', '/app/']) {
          if (rel.startsWith(prefix)) { rel = rel.slice(prefix.length); break; }
        }
        url = `/files/${rel}`;
      }
      const fullUrl = `${client.baseUrl}${url}`;
      const resp = await fetch(fullUrl, { signal: AbortSignal.timeout(60000) });
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        writeFileSync(destPath, buf);
        // OSC 8 clickable hyperlink for terminals that support it
        const fileUri = `file://${destPath.replace(/\\/g, '/')}`;
        const link = `\x1b]8;;${fileUri}\x1b\\${destPath}\x1b]8;;\x1b\\`;
        console.log(chalk.green(`  ✓ Saved: ${link}`));
        return;
      }
      // Non-ok — fall through to docker cp
    } catch {
      // HTTP failed — fall through to docker cp
    }
  }

  // 2) Fallback: docker cp
  if (art.retrieve_cmd) {
    try {
      execSync(art.retrieve_cmd, { stdio: 'pipe' });
      const fileUri = `file://${destPath.replace(/\\/g, '/')}`;
      const link = `\x1b]8;;${fileUri}\x1b\\${destPath}\x1b]8;;\x1b\\`;
      console.log(chalk.green(`  ✓ Saved: ${link}`));
    } catch (err: any) {
      console.log(chalk.red(`  ✗ Download failed: ${err.message || err}`));
    }
    return;
  }

  console.log(chalk.red(`  ✗ No download path available for artifact #${num}.`));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sandbox + IDE commands
// ═══════════════════════════════════════════════════════════════════════════════

COMMANDS['sandbox'] = {
  description: 'Manage sandbox sessions (list, create, stop, exec)',
  usage: '/sandbox [list | create [name] | stop <id> | exec <id> <command> | files <id>]',
  handler: async (client: GenesisClient, args: string) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] || 'list';

    if (sub === 'list' || sub === 'ls') {
      const data = await client.get('/sandbox/sessions') as any;
      if (data?.error) { console.log(chalk.red(`  Error: ${data.error}`)); return; }
      const sessions = data?.sessions || [];
      if (sessions.length === 0) {
        console.log(chalk.dim('  No active sandbox sessions.'));
        console.log(chalk.dim('  Create one: /sandbox create [name]'));
        return;
      }
      console.log(chalk.bold('\n  Sandbox Sessions\n'));
      for (const s of sessions) {
        const status = s.status === 'running' ? chalk.green('●') : s.status === 'error' ? chalk.red('●') : chalk.yellow('●');
        const expires = Math.round(s.expires_in / 60);
        console.log(`  ${status} ${chalk.cyan(s.session_id.slice(0, 8))} ${s.name} (${s.language}) — ${s.files_written?.length || 0} files, ${s.execution_count} runs, ${expires}m remaining`);
        if (s.task_description) console.log(chalk.dim(`    Task: ${s.task_description.slice(0, 80)}`));
      }
      console.log();
    } else if (sub === 'create' || sub === 'new') {
      const name = parts[1] || undefined;
      const lang = parts[2] || 'python';
      const spinner = ora({ text: 'Creating sandbox session...', color: 'yellow' }).start();
      const data = await client.post('/sandbox/sessions', { name, language: lang, with_container: true }) as any;
      spinner.stop();
      if (data?.error) { console.log(chalk.red(`  Error: ${data.error}`)); return; }
      console.log(chalk.green(`  ✓ Session created: ${chalk.bold(data.session_id?.slice(0, 8))}`));
      console.log(chalk.dim(`    Name: ${data.name}`));
      console.log(chalk.dim(`    Language: ${data.language}`));
      console.log(chalk.dim(`    Status: ${data.status}`));
      console.log(chalk.dim(`    Container: ${data.container_name || 'filesystem-only'}`));
      console.log(chalk.cyan(`\n  Open in IDE: /ide ${data.session_id?.slice(0, 8)}`));
    } else if (sub === 'stop' || sub === 'rm' || sub === 'delete') {
      const id = parts[1];
      if (!id) { console.log(chalk.yellow('  Usage: /sandbox stop <session-id>')); return; }
      // Try to match partial ID
      const sessions = ((await client.get('/sandbox/sessions') as any)?.sessions || []);
      const match = sessions.find((s: any) => s.session_id.startsWith(id));
      if (!match) { console.log(chalk.red(`  Session not found: ${id}`)); return; }
      await client.delete(`/sandbox/sessions/${match.session_id}`);
      console.log(chalk.green(`  ✓ Session ${id} stopped and cleaned up.`));
    } else if (sub === 'exec' || sub === 'run') {
      const id = parts[1];
      const cmd = parts.slice(2).join(' ');
      if (!id || !cmd) { console.log(chalk.yellow('  Usage: /sandbox exec <id> <command>')); return; }
      const sessions = ((await client.get('/sandbox/sessions') as any)?.sessions || []);
      const match = sessions.find((s: any) => s.session_id.startsWith(id));
      if (!match) { console.log(chalk.red(`  Session not found: ${id}`)); return; }
      const result = await client.post(`/sandbox/sessions/${match.session_id}/execute`, { command: cmd }) as any;
      if (result?.stdout) console.log(result.stdout);
      if (result?.stderr) console.log(chalk.red(result.stderr));
      console.log(chalk.dim(`  Exit: ${result?.returncode ?? result?.status}`));
    } else if (sub === 'files') {
      const id = parts[1];
      if (!id) { console.log(chalk.yellow('  Usage: /sandbox files <id>')); return; }
      const sessions = ((await client.get('/sandbox/sessions') as any)?.sessions || []);
      const match = sessions.find((s: any) => s.session_id.startsWith(id));
      if (!match) { console.log(chalk.red(`  Session not found: ${id}`)); return; }
      const data = await client.get(`/sandbox/sessions/${match.session_id}/files`) as any;
      const entries = data?.entries || [];
      if (entries.length === 0) { console.log(chalk.dim('  (empty workspace)')); return; }
      for (const e of entries) {
        const icon = e.type === 'directory' ? '📁' : '📄';
        const size = e.size != null ? chalk.dim(` (${e.size} bytes)`) : '';
        console.log(`  ${icon} ${e.name}${size}`);
      }
    } else if (sub === 'test') {
      const id = parts[1];
      if (!id) { console.log(chalk.yellow('  Usage: /sandbox test <id> [file]')); return; }
      const sessions = ((await client.get('/sandbox/sessions') as any)?.sessions || []);
      const match = sessions.find((s: any) => s.session_id.startsWith(id));
      if (!match) { console.log(chalk.red(`  Session not found: ${id}`)); return; }
      const file = parts[2] || undefined;
      const spinner = ora({ text: 'Running tests...', color: 'yellow' }).start();
      const result = await client.post(`/sandbox/sessions/${match.session_id}/test`, { file }) as any;
      spinner.stop();
      if (result?.stdout) console.log(result.stdout);
      if (result?.stderr) console.log(chalk.red(result.stderr));
    } else {
      console.log(chalk.yellow('  Unknown subcommand. Use: list, create, stop, exec, files, test'));
    }
  },
};

COMMANDS['ide'] = {
  description: 'Open ForgeIDE in browser (optionally for a sandbox session)',
  usage: '/ide [session-id]',
  handler: async (client: GenesisClient, args: string) => {
    const sessionId = args.trim();
    const baseUrl = process.env.FORGEIDE_URL || 'https://forge.aitherium.com';

    if (sessionId) {
      // Find the session
      const sessions = ((await client.get('/sandbox/sessions') as any)?.sessions || []);
      const match = sessions.find((s: any) => s.session_id.startsWith(sessionId));
      if (!match) {
        console.log(chalk.red(`  Session not found: ${sessionId}`));
        console.log(chalk.dim('  Use /sandbox list to see active sessions'));
        return;
      }
      const url = `${baseUrl}/ide?session=${match.session_id}`;
      console.log(chalk.cyan(`  Opening ForgeIDE for session ${match.name}...`));
      console.log(chalk.dim(`  URL: ${url}`));
      try { execSync(`start "" "${url}"`); } catch { /* ignore */ }
    } else {
      console.log(chalk.cyan(`  Opening ForgeIDE...`));
      console.log(chalk.dim(`  URL: ${baseUrl}/ide`));
      try { execSync(`start "" "${baseUrl}/ide"`); } catch { /* ignore */ }
    }
  },
};

COMMANDS['preview'] = {
  description: 'List active preview containers or open one in browser',
  usage: '/preview [session-id]',
  handler: async (client: GenesisClient, args: string) => {
    const id = args.trim();
    if (id) {
      const sessions = ((await client.get('/sandbox/sessions') as any)?.sessions || []);
      const match = sessions.find((s: any) => s.session_id.startsWith(id));
      if (!match) {
        console.log(chalk.red(`  Session not found: ${id}`));
        return;
      }
      if (match.preview_url) {
        console.log(chalk.cyan(`  Preview: ${match.preview_url}`));
        try { execSync(`start "" "${match.preview_url}"`); } catch { /* ignore */ }
      } else if (match.container_port) {
        const url = `http://localhost:${match.container_port}`;
        console.log(chalk.cyan(`  Container available at: ${url}`));
      } else {
        console.log(chalk.dim('  No preview URL available for this session.'));
      }
    } else {
      // List all previews
      const data = await client.get('/sandbox/sessions') as any;
      const sessions = (data?.sessions || []).filter((s: any) => s.status === 'running');
      if (sessions.length === 0) {
        console.log(chalk.dim('  No active sandbox sessions with previews.'));
        return;
      }
      for (const s of sessions) {
        const url = s.preview_url || (s.container_port ? `http://localhost:${s.container_port}` : 'none');
        console.log(`  ${chalk.cyan(s.session_id.slice(0, 8))} ${s.name} → ${url}`);
      }
    }
  },
};

COMMANDS['dev'] = {
  description: 'Manage dev environments (sandbox + AI agent)',
  usage: '/dev [list | create [name] [lang] | stop <id> | codegen <id> <prompt> | exec <id> <cmd> | task <id> <task> | open <id>]',
  handler: async (client: GenesisClient, args: string) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] || 'list';

    if (sub === 'list' || sub === 'ls') {
      const spinner = ora({ text: 'Fetching dev environments...', color: 'yellow' }).start();
      const data = await client.get('/dev-env/list') as any;
      spinner.stop();
      const envs = data?.envs || [];
      if (envs.length === 0) {
        console.log(chalk.dim('  No active dev environments.'));
        console.log(chalk.dim('  Create one: /dev create [name] [python|nodejs|static]'));
        return;
      }
      console.log(chalk.bold('\n  Dev Environments\n'));
      for (const e of envs) {
        const status = e.status === 'running' ? chalk.green('●') : chalk.red('●');
        const agent = e.agent ? chalk.magenta(`[${e.agent}]`) : '';
        console.log(`  ${status} ${chalk.cyan(e.env_id.slice(0, 12))} ${e.name} (${e.language}) ${agent} — ${e.executions} runs`);
        if (e.sandbox_session_id) console.log(chalk.dim(`    Sandbox: ${e.sandbox_session_id.slice(0, 8)}`));
      }
      console.log();

    } else if (sub === 'create' || sub === 'new') {
      const name = parts[1] || 'dev';
      const lang = parts[2] || 'python';
      const template = parts[3] || undefined;
      const spinner = ora({ text: `Creating ${lang} dev environment...`, color: 'yellow' }).start();
      const data = await client.post('/dev-env/create', {
        name, language: lang, template, auto_agent: true,
      }) as any;
      spinner.stop();
      if (data?.error) { console.log(chalk.red(`  Error: ${data.error}`)); return; }
      const env = data.env;
      console.log(chalk.green(`  ✓ Dev environment created: ${chalk.bold(env.env_id.slice(0, 12))}`));
      console.log(chalk.dim(`    Name: ${env.name} | Language: ${env.language} | Agent: ${env.agent || 'none'}`));
      if (env.sandbox_session_id) {
        console.log(chalk.dim(`    Sandbox: ${env.sandbox_session_id.slice(0, 8)}`));
        console.log(chalk.cyan(`\n  Open in browser: tunnel.aitherium.com/console/dev`));
        console.log(chalk.cyan(`  Open in IDE:     /ide ${env.sandbox_session_id.slice(0, 8)}`));
      }
      console.log(chalk.dim(`\n  Generate code:   /dev codegen ${env.env_id.slice(0, 8)} "build a REST API"`));
      console.log(chalk.dim(`  Execute:         /dev exec ${env.env_id.slice(0, 8)} python main.py`));
      console.log(chalk.dim(`  Agent task:      /dev task ${env.env_id.slice(0, 8)} "add tests and CI"`));

    } else if (sub === 'stop' || sub === 'rm' || sub === 'delete') {
      const id = parts[1];
      if (!id) { console.log(chalk.yellow('  Usage: /dev stop <env-id>')); return; }
      const envs = ((await client.get('/dev-env/list') as any)?.envs || []);
      const match = envs.find((e: any) => e.env_id.startsWith(id) || e.env_id.includes(id));
      if (!match) { console.log(chalk.red(`  Environment not found: ${id}`)); return; }
      await client.delete(`/dev-env/${match.env_id}`);
      console.log(chalk.green(`  ✓ Environment ${match.name} stopped.`));

    } else if (sub === 'codegen' || sub === 'gen' || sub === 'generate') {
      const id = parts[1];
      const prompt = parts.slice(2).join(' ');
      if (!id || !prompt) { console.log(chalk.yellow('  Usage: /dev codegen <id> <prompt>')); return; }
      const envs = ((await client.get('/dev-env/list') as any)?.envs || []);
      const match = envs.find((e: any) => e.env_id.startsWith(id) || e.env_id.includes(id));
      if (!match) { console.log(chalk.red(`  Environment not found: ${id}`)); return; }
      const spinner = ora({ text: 'Generating code...', color: 'magenta' }).start();
      const result = await client.post('/dev-env/codegen', { env_id: match.env_id, prompt, mode: 'generate' }) as any;
      spinner.stop();
      if (result?.error) { console.log(chalk.red(`  Error: ${result.error}`)); return; }
      console.log(chalk.green('  ✓ Code generated'));
      if (result.result) {
        console.log();
        console.log(result.result);
      }
      if (result.files_modified?.length) {
        console.log(chalk.dim(`\n  Files: ${result.files_modified.join(', ')}`));
      }

    } else if (sub === 'exec' || sub === 'run') {
      const id = parts[1];
      const cmd = parts.slice(2).join(' ');
      if (!id || !cmd) { console.log(chalk.yellow('  Usage: /dev exec <id> <command>')); return; }
      const envs = ((await client.get('/dev-env/list') as any)?.envs || []);
      const match = envs.find((e: any) => e.env_id.startsWith(id) || e.env_id.includes(id));
      if (!match) { console.log(chalk.red(`  Environment not found: ${id}`)); return; }
      const spinner = ora({ text: 'Executing...', color: 'green' }).start();
      const result = await client.post('/dev-env/exec', { env_id: match.env_id, command: cmd }) as any;
      spinner.stop();
      if (result?.output) console.log(result.output);
      if (result?.error) console.log(chalk.red(result.error));

    } else if (sub === 'task' || sub === 'agent') {
      const id = parts[1];
      const task = parts.slice(2).join(' ');
      if (!id || !task) { console.log(chalk.yellow('  Usage: /dev task <id> <task description>')); return; }
      const envs = ((await client.get('/dev-env/list') as any)?.envs || []);
      const match = envs.find((e: any) => e.env_id.startsWith(id) || e.env_id.includes(id));
      if (!match) { console.log(chalk.red(`  Environment not found: ${id}`)); return; }
      const spinner = ora({ text: `Agent working on: ${task.slice(0, 60)}...`, color: 'magenta' }).start();
      const result = await client.post('/dev-env/agent-task', { env_id: match.env_id, task }) as any;
      spinner.stop();
      if (result?.error) { console.log(chalk.red(`  Error: ${result.error}`)); return; }
      console.log(chalk.green('  ✓ Agent task complete'));
      if (result.result) console.log(`\n${result.result}`);
      if (result.steps?.length) console.log(chalk.dim(`\n  Steps: ${result.steps.length}`));

    } else if (sub === 'open') {
      const id = parts[1];
      if (!id) { console.log(chalk.yellow('  Usage: /dev open <id>')); return; }
      const tunnelUrl = process.env.TUNNEL_DOMAIN || 'tunnel.aitherium.com';
      const url = `https://${tunnelUrl}/console/dev`;
      console.log(chalk.cyan(`  Opening dev environment in browser...`));
      console.log(chalk.dim(`  URL: ${url}`));
      try { execSync(`start "" "${url}"`); } catch { /* ignore */ }

    } else {
      console.log(chalk.yellow('  Subcommands: list, create, stop, codegen, exec, task, open'));
    }
  },
};

COMMANDS['scope'] = {
  description: 'AitherScope — codebase visualization and analysis',
  usage: '/scope [graph|dead|metrics|health|reindex] [path]',
  handler: async (_client, args, config) => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase() || '';
    const path = parts.slice(1).join(' ') || '';
    const genesisUrl = config.genesisUrl || 'http://localhost:8100';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getActiveToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const target = path || 'AitherOS';
    const scopeDetail = (data: any): string => {
      if (typeof data === 'string') return data;
      if (typeof data?.detail === 'string') return data.detail;
      if (typeof data?.message === 'string') return data.message;
      if (typeof data?.error === 'string') return data.error;
      return '';
    };

    const isMissingIndex = (status: number, data: any): boolean => {
      const detail = scopeDetail(data).toLowerCase();
      return status === 404
        || detail.includes('empty index')
        || detail.includes('no index')
        || detail.includes('index is empty')
        || detail.includes('not indexed')
        || detail.includes('no roots')
        || detail.includes('codegraph is empty');
    };

    const printMissingIndexHint = (): void => {
      console.log(chalk.yellow('  Scope index is empty — nothing has been indexed yet.'));
      console.log(chalk.dim(`  Run ${chalk.cyan(`/scope reindex ${target}`)} to populate CodeGraph.`));
      console.log(chalk.dim('  After that, retry /scope graph or open /scope in the browser.'));
    };

    if (!sub || sub === 'browser') {
      const veilUrl = process.env.AITHER_VEIL_URL || 'http://localhost:3000';
      let url = `${veilUrl}/console/scope`;
      if (path) url += `?path=${encodeURIComponent(path)}`;
      console.log(chalk.cyan('  Opening AitherScope in browser...'));
      console.log(chalk.dim(`  URL: ${url}`));
      try { execSync(`start "" "${url}"`); } catch { /* ignore */ }
      return;
    }

    if (sub === 'graph') {
      const spinner = ora('Fetching dependency graph...').start();
      try {
        const endpoint = path
          ? `${genesisUrl}/scope/graph/full?path=${encodeURIComponent(path)}`
          : `${genesisUrl}/scope/graph/full`;
        const resp = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) });
        const data = await resp.json() as any;
        spinner.stop();
        if (!resp.ok) {
          if (isMissingIndex(resp.status, data)) {
            printMissingIndexHint();
            return;
          }
          console.log(chalk.red(`  Error: ${scopeDetail(data) || resp.statusText}`));
          return;
        }
        const nodes = data.nodes?.length ?? 0;
        const edges = data.edges?.length ?? 0;
        const roots = Array.isArray(data.roots) ? data.roots : [];
        if (nodes === 0 && edges === 0 && roots.length === 0) {
          printMissingIndexHint();
          return;
        }
        console.log(chalk.bold(`  📊 Scope Graph: ${nodes} nodes, ${edges} edges`));
        if (roots.length) console.log(chalk.dim(`  Roots: ${roots.join(', ')}`));
      } catch (e: any) {
        spinner.stop();
        console.log(chalk.red(`  Failed to fetch graph: ${e.message}`));
        console.log(chalk.dim('  Is Genesis running? Try /status first.'));
      }
      return;
    }

    if (sub === 'dead') {
      const spinner = ora('Scanning for dead code...').start();
      try {
        const endpoint = path
          ? `${genesisUrl}/scope/dead-code?path=${encodeURIComponent(path)}`
          : `${genesisUrl}/scope/dead-code`;
        const resp = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) });
        const data = await resp.json() as any;
        spinner.stop();
        if (!resp.ok) {
          if (isMissingIndex(resp.status, data)) {
            printMissingIndexHint();
            return;
          }
          console.log(chalk.red(`  Error: ${scopeDetail(data) || resp.statusText}`));
          return;
        }
        const items = Array.isArray(data) ? data : data.items || [];
        if (!items.length) { console.log(chalk.green('  ✓ No dead code found')); return; }
        console.log(chalk.bold(`  🧹 ${items.length} dead code items:`));
        for (const item of items.slice(0, 20)) {
          console.log(`  ${chalk.dim('•')} ${chalk.yellow(item.name || item.symbol || 'unknown')} ${chalk.dim(item.file || '')}`);
        }
        if (items.length > 20) console.log(chalk.dim(`  ... and ${items.length - 20} more`));
      } catch (e: any) {
        spinner.stop();
        console.log(chalk.red(`  Failed: ${e.message}`));
      }
      return;
    }

    if (sub === 'metrics') {
      const spinner = ora('Fetching codebase metrics...').start();
      try {
        const endpoint = path
          ? `${genesisUrl}/scope/metrics?path=${encodeURIComponent(path)}`
          : `${genesisUrl}/scope/metrics`;
        const resp = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) });
        const data = await resp.json() as any;
        spinner.stop();
        if (!resp.ok) {
          if (isMissingIndex(resp.status, data)) {
            printMissingIndexHint();
            return;
          }
          console.log(chalk.red(`  Error: ${scopeDetail(data) || resp.statusText}`));
          return;
        }
        if (Object.keys(data || {}).length === 0) {
          printMissingIndexHint();
          return;
        }
        console.log(chalk.bold('  📈 Codebase Metrics'));
        for (const [key, val] of Object.entries(data)) {
          if (typeof val === 'object') continue;
          console.log(`  ${chalk.dim(key + ':')} ${val}`);
        }
      } catch (e: any) {
        spinner.stop();
        console.log(chalk.red(`  Failed: ${e.message}`));
      }
      return;
    }

    if (sub === 'health') {
      const spinner = ora('Checking scope services...').start();
      try {
        const resp = await fetch(`${genesisUrl}/scope/graph/health`, { headers, signal: AbortSignal.timeout(10000) });
        const data = await resp.json() as any;
        spinner.stop();
        const status = data.status || (resp.ok ? 'healthy' : 'unhealthy');
        const icon = status === 'healthy' ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${icon} CodeGraph: ${status}`);
        if (data.roots) console.log(chalk.dim(`  Indexed roots: ${data.roots}`));
        if (data.nodes !== undefined) console.log(chalk.dim(`  Nodes: ${data.nodes}`));
        if ((data.roots === 0 || data.roots === '0' || !data.roots) && (data.nodes === 0 || data.nodes === '0' || !data.nodes)) {
          printMissingIndexHint();
        }
      } catch (e: any) {
        spinner.stop();
        console.log(chalk.red(`  ✗ Scope service unreachable: ${e.message}`));
      }
      return;
    }

    if (sub === 'reindex') {
      const spinner = ora(`Re-indexing ${target}...`).start();
      try {
        const resp = await fetch(`${genesisUrl}/scope/reindex`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ path: target }),
          signal: AbortSignal.timeout(60000),
        });
        const data = await resp.json() as any;
        spinner.stop();
        if (!resp.ok) { console.log(chalk.red(`  Error: ${data.detail || resp.statusText}`)); return; }
        console.log(chalk.green(`  ✓ Re-index started for ${target}`));
        if (data.files) console.log(chalk.dim(`  Files queued: ${data.files}`));
      } catch (e: any) {
        spinner.stop();
        console.log(chalk.red(`  Failed: ${e.message}`));
      }
      return;
    }

    console.log(chalk.yellow('  Subcommands: graph, dead, metrics, health, reindex'));
    console.log(chalk.dim('  Or just /scope to open in browser'));
  },
};

COMMANDS['onboard'] = {
  description: 'Unified onboarding for codebases, repos, and knowledge directories',
  usage: '/onboard [auto|code|knowledge|repo] <path-or-url> [name]',
  handler: async (client: GenesisClient, args: string) => {
    const tokens = parseQuotedArgs(args);
    const first = tokens[0]?.toLowerCase() || '';
    const explicitMode = new Set<OnboardMode>(['auto', 'code', 'knowledge', 'repo']).has(first as OnboardMode)
      ? first as OnboardMode
      : 'auto';

    const targetArg = explicitMode === 'auto' && first !== 'auto'
      ? (tokens[0] || process.cwd())
      : (tokens[1] || process.cwd());
    const nameArg = explicitMode === 'auto' && first !== 'auto'
      ? tokens.slice(1).join(' ')
      : tokens.slice(2).join(' ');

    const target = isRepoUrl(targetArg) ? targetArg : resolve(targetArg || process.cwd());
    const displayName = inferTargetName(target, nameArg);
    let mode: OnboardMode = explicitMode;

    const profile = !isRepoUrl(target) ? scanLocalTarget(target) : null;

    if (mode === 'auto') {
      if (isRepoUrl(target)) {
        mode = 'repo';
      } else if (!profile?.exists) {
        console.log(chalk.red(`  Target not found: ${target}`));
        return;
      } else if (profile.codeFiles > 0 && profile.docFiles > 0) {
        mode = 'code';
      } else if (profile.codeFiles > 0 || profile.hasGit) {
        mode = 'code';
      } else if (profile.docFiles > 0) {
        mode = 'knowledge';
      } else {
        console.log(chalk.yellow('  Could not auto-detect onboarding mode for this target.'));
        console.log(chalk.dim('  Try /onboard code <path> or /onboard knowledge <path>.'));
        return;
      }
    }

    console.log(chalk.bold('\n  Unified Onboarding\n'));
    console.log(`  ${chalk.dim('Mode:')}   ${chalk.cyan(mode)}`);
    console.log(`  ${chalk.dim('Target:')} ${target}`);
    if (profile) {
      console.log(`  ${chalk.dim('Scan:')}   ${profile.codeFiles} code files, ${profile.docFiles} docs (${profile.scannedFiles} scanned)`);
    }
    console.log();

    if (mode === 'repo') {
      const spinner = ora('Importing repository into workspace...').start();
      const result = await client.postDetailed('/workspace/import-repo', {
        repo_url: target,
        name: displayName,
        auto_index: true,
      });
      spinner.stop();

      if (result?.error) {
        console.log(chalk.red(`  Import failed: ${result.error}`));
        return;
      }

      const project = result?.project || {};
      console.log(chalk.green(`  ✓ Repository onboarded: ${project.name || displayName}`));
      if (project.id) console.log(chalk.dim(`    Project ID: ${project.id}`));
      if (project.repo_path) console.log(chalk.dim(`    Repo path: ${project.repo_path}`));
      if (project.codegraph_label) console.log(chalk.dim(`    CodeGraph root: ${project.codegraph_label}`));
      if (project.repo_path) {
        await printCodebaseIntelSummary(client, project.repo_path, project.name || displayName);
      }
      console.log(chalk.dim('\n  Next: /scope graph   /codegraph <query>   /repowise <question>'));
      console.log();
      return;
    }

    if (!profile?.exists || !profile.isDirectory) {
      console.log(chalk.red(`  Local directory not found: ${target}`));
      return;
    }

    let codeIndexed = false;
    let docsIngested = false;

    if (mode === 'code') {
      const spinner = ora('Indexing code with CodeGraph...').start();
      const result = await callMcpTool(client, 'codegraph_trigger_index', {
        root_path: target,
        force: false,
      });
      spinner.stop();

      if ((result && typeof result === 'object' && result.error) || !result) {
        console.log(chalk.red(`  CodeGraph indexing failed: ${result?.error || 'unknown error'}`));
      } else {
        codeIndexed = true;
        console.log(chalk.green('  ✓ CodeGraph index ready'));
        const files = result?.stats?.files || result?.files || result?.indexed_files;
        const chunks = result?.stats?.chunks || result?.chunks || result?.indexed_chunks;
        if (files !== undefined) console.log(chalk.dim(`    Files: ${files}`));
        if (chunks !== undefined) console.log(chalk.dim(`    Chunks: ${chunks}`));
      }

      if (profile.docFiles > 0) {
        const ragSpinner = ora('Ingesting project docs with RAGAnything...').start();
        const ragResult = await callMcpTool(client, 'rag_ingest_dir', {
          directory: target,
          recursive: true,
          force: false,
        });
        ragSpinner.stop();

        if (ragResult && typeof ragResult === 'object' && !ragResult.error) {
          docsIngested = true;
          console.log(chalk.green('  ✓ Project docs ingested for knowledge retrieval'));
          if (ragResult.ingested !== undefined) console.log(chalk.dim(`    Documents ingested: ${ragResult.ingested}`));
        } else if (ragResult?.error) {
          console.log(chalk.yellow(`  RAG ingestion skipped: ${ragResult.error}`));
        }
      }

      console.log();
      if (codeIndexed) {
        await printCodebaseIntelSummary(client, target, displayName);
      }
      if (codeIndexed) {
        console.log(chalk.dim('  Next: /scope graph   /codegraph <query>'));
      }
      if (docsIngested) {
        console.log(chalk.dim('  Knowledge is now available to RAG-backed flows.'));
      }
      if (profile.hasGit) {
        console.log(chalk.dim('  For remote workspace onboarding, use /onboard repo <git-url>.'));
      }
      console.log(chalk.dim('  Obsidian: /obsidian setup — explore this project as linked notes'));
      console.log();
      return;
    }

    if (mode === 'knowledge') {
      const spinner = ora('Ingesting knowledge directory with RAGAnything...').start();
      const result = await callMcpTool(client, 'rag_ingest_dir', {
        directory: target,
        recursive: true,
        force: false,
      });
      spinner.stop();

      if ((result && typeof result === 'object' && result.error) || !result) {
        console.log(chalk.red(`  Knowledge ingest failed: ${result?.error || 'unknown error'}`));
        return;
      }

      docsIngested = true;
      console.log(chalk.green(`  ✓ Knowledge base onboarded: ${displayName}`));
      if (result.total_files !== undefined) console.log(chalk.dim(`    Files scanned: ${result.total_files}`));
      if (result.ingested !== undefined) console.log(chalk.dim(`    Files ingested: ${result.ingested}`));
      if (result.errors !== undefined) console.log(chalk.dim(`    Errors: ${result.errors}`));
      console.log(chalk.dim('\n  Knowledge is now available to RAG-backed retrieval and research flows.'));
      console.log();
      return;
    }

    console.log(chalk.yellow('  Usage: /onboard [auto|code|knowledge|repo] <path-or-url> [name]'));
  },
};

// ── /obsidian — Easy-button Obsidian plugin setup ────────────────────────

const OBSIDIAN_PLUGIN_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'obsidian-aitheros',
);

function findObsidianVaults(): string[] {
  const candidates: string[] = [];
  const home = homedir();
  // Common vault locations
  for (const dir of [home, join(home, 'Documents'), join(home, 'Desktop')]) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true }) as any[]) {
        if (entry.isDirectory()) {
          const dotObs = join(dir, entry.name, '.obsidian');
          if (existsSync(dotObs)) candidates.push(join(dir, entry.name));
        }
      }
    } catch { /* ignore */ }
  }
  return candidates;
}

COMMANDS['obsidian'] = {
  description: 'Install or link the AitherOS Obsidian plugin into a vault',
  usage: '/obsidian setup [vault-path]  |  /obsidian status',
  handler: async (_client, args) => {
    const tokens = parseQuotedArgs(args);
    const sub = tokens[0]?.toLowerCase() || 'setup';

    if (sub === 'status') {
      if (!existsSync(OBSIDIAN_PLUGIN_DIR)) {
        console.log(chalk.red('  Plugin source not found at:'));
        console.log(chalk.dim(`  ${OBSIDIAN_PLUGIN_DIR}`));
        return;
      }
      const built = existsSync(join(OBSIDIAN_PLUGIN_DIR, 'main.js'));
      console.log(chalk.cyan('  AitherOS Obsidian Plugin'));
      console.log(`  Source: ${chalk.dim(OBSIDIAN_PLUGIN_DIR)}`);
      console.log(`  Built:  ${built ? chalk.green('Yes') : chalk.yellow('No — run /obsidian setup')}`);

      const vaults = findObsidianVaults();
      if (vaults.length) {
        console.log(chalk.dim(`\n  Detected vaults:`));
        for (const v of vaults) {
          const linked = existsSync(join(v, '.obsidian', 'plugins', 'obsidian-aitheros'));
          console.log(`    ${linked ? chalk.green('✓') : chalk.dim('○')} ${v}`);
        }
      }
      return;
    }

    if (sub === 'setup') {
      let vaultPath = tokens[1];

      // Auto-detect vault if not specified
      if (!vaultPath) {
        const vaults = findObsidianVaults();
        if (vaults.length === 1) {
          vaultPath = vaults[0];
          console.log(chalk.dim(`  Auto-detected vault: ${vaultPath}`));
        } else if (vaults.length > 1) {
          console.log(chalk.yellow('  Multiple Obsidian vaults detected:'));
          vaults.forEach((v, i) => console.log(chalk.dim(`    ${i + 1}. ${v}`)));
          console.log(chalk.dim('\n  Specify one: /obsidian setup <vault-path>'));
          return;
        } else {
          console.log(chalk.yellow('  No Obsidian vaults found automatically.'));
          console.log(chalk.dim('  Specify your vault: /obsidian setup /path/to/my-vault'));
          return;
        }
      }

      vaultPath = resolve(vaultPath);
      const pluginsDir = join(vaultPath, '.obsidian', 'plugins');
      const targetDir = join(pluginsDir, 'obsidian-aitheros');

      if (!existsSync(join(vaultPath, '.obsidian'))) {
        console.log(chalk.red(`  Not an Obsidian vault (no .obsidian folder): ${vaultPath}`));
        return;
      }

      if (!existsSync(OBSIDIAN_PLUGIN_DIR)) {
        console.log(chalk.red('  Plugin source not found. Expected at:'));
        console.log(chalk.dim(`  ${OBSIDIAN_PLUGIN_DIR}`));
        return;
      }

      // 1. Build plugin if needed
      const mainJs = join(OBSIDIAN_PLUGIN_DIR, 'main.js');
      if (!existsSync(mainJs)) {
        console.log(chalk.cyan('  Building Obsidian plugin...'));
        try {
          execSync('npm install && npm run build', { cwd: OBSIDIAN_PLUGIN_DIR, stdio: 'pipe' });
          console.log(chalk.green('  ✓ Plugin built'));
        } catch (e: any) {
          console.log(chalk.red(`  Build failed: ${e.message}`));
          return;
        }
      }

      // 2. Create plugins dir if needed
      if (!existsSync(pluginsDir)) {
        try {
          execSync(`mkdir "${pluginsDir}"`, { stdio: 'pipe' });
        } catch { /* may already exist */ }
      }

      // 3. Symlink or copy
      if (!existsSync(targetDir)) {
        try {
          const isWin = process.platform === 'win32';
          if (isWin) {
            execSync(`mklink /J "${targetDir}" "${OBSIDIAN_PLUGIN_DIR}"`, { stdio: 'pipe', shell: 'cmd.exe' });
          } else {
            execSync(`ln -s "${OBSIDIAN_PLUGIN_DIR}" "${targetDir}"`, { stdio: 'pipe' });
          }
          console.log(chalk.green('  ✓ Plugin linked into vault'));
        } catch (e: any) {
          console.log(chalk.yellow(`  Symlink failed (${e.message}), copying instead...`));
          try {
            const cpCmd = process.platform === 'win32'
              ? `xcopy "${OBSIDIAN_PLUGIN_DIR}" "${targetDir}\\" /E /I /Y /Q`
              : `cp -r "${OBSIDIAN_PLUGIN_DIR}" "${targetDir}"`;
            execSync(cpCmd, { stdio: 'pipe' });
            console.log(chalk.green('  ✓ Plugin copied into vault'));
          } catch (e2: any) {
            console.log(chalk.red(`  Failed to install plugin: ${e2.message}`));
            return;
          }
        }
      } else {
        console.log(chalk.dim('  Plugin already installed at: ' + targetDir));
      }

      console.log();
      console.log(chalk.green('  ✓ AitherOS Obsidian plugin is ready!'));
      console.log(chalk.dim('  Next steps:'));
      console.log(chalk.dim('    1. Open Obsidian → Settings → Community Plugins'));
      console.log(chalk.dim('    2. Enable "AitherOS Graph Explorer"'));
      console.log(chalk.dim('    3. Use Ctrl+P → "AitherOS" to access commands'));
      console.log();
      return;
    }

    console.log(chalk.yellow('  Subcommands: setup [vault-path], status'));
  },
};

// ── /models — Model routing control plane ──────────────────────────────

function formatRoutingTiers(routing: any): string {
  if (!routing?.tiers) return '  (no routing data)';
  return Object.entries(routing.tiers as Record<string, string>)
    .map(([tier, model]) => `    ${tier.padEnd(14)} → ${model}`)
    .join('\n');
}

COMMANDS.models = {
  description: 'Model routing: profiles, effort tiers, reasoning swap',
  usage: '/models [status|list|use <profile>|set <slot> <model>|route <tier> <model> [backend]]',
  handler: async (client: GenesisClient, args: string) => {
    const parts = args.trim().split(/\s+/);
    const sub = (parts[0] || 'status').toLowerCase();

    if (sub === 'help' || sub === '?') {
      console.log();
      console.log(chalk.bold('  Model Routing Control'));
      console.log();
      console.log(chalk.dim('    /models                                — Current status + routing table'));
      console.log(chalk.dim('    /models list                           — Available profiles'));
      console.log(chalk.dim('    /models use <profile>                  — Switch profile (local/deepseek/claude/gemini/hybrid)'));
      console.log(chalk.dim('    /models set <slot> <model>             — Set model slot (model/fast_model/premium_model/reasoning_model)'));
      console.log(chalk.dim('    /models route <tier> <model> [backend] — Set effort tier (low/medium/high)'));
      console.log(chalk.dim('    /models escalation [on|off]            — Toggle human approval gate'));
      console.log();
      return;
    }

    if (sub === 'status' || sub === '') {
      const spinner = ora('Loading model routing...').start();
      const data = await client.get('/reasoning/status');
      spinner.stop();
      if (!data) { console.log(chalk.red('  Reasoning config endpoint unavailable. Rebuild Genesis: docker compose -f docker-compose.aitheros.yml up -d --build aitheros-genesis')); return; }
      if (data?.error) { console.log(chalk.red(`  ${data.error}`)); return; }
      console.log();
      console.log(chalk.bold('  Profile: ') + chalk.cyan(data.display_name) + chalk.dim(` (${data.active_profile})`));
      console.log(chalk.bold('  Model:   ') + data.model + chalk.dim(` via ${data.backend}`));
      console.log(chalk.bold('  Cost:    ') + (data.cost_per_1k_tokens > 0 ? `$${data.cost_per_1k_tokens}/1k tokens` : chalk.green('free (local)')));
      console.log();
      console.log(chalk.bold('  Effort Routing:'));
      console.log(formatRoutingTiers(data.routing));
      if (data.routing?.model_slots) {
        console.log();
        console.log(chalk.bold('  Model Slots:'));
        for (const [slot, val] of Object.entries(data.routing.model_slots as Record<string, string>)) {
          if (val) console.log(`    ${slot.padEnd(18)} = ${val}`);
        }
      }
      console.log();
      console.log(chalk.bold('  Escalation: ') + (data.escalation?.require_human_approval ? chalk.yellow('manual approval') : chalk.green('auto')) + chalk.dim(` (threshold: ${data.escalation?.threshold})`));
      if (data.stats?.total_judged > 0) {
        console.log(chalk.bold('  Quality:    ') + `${(data.stats.avg_quality_score * 100).toFixed(0)}% avg — ${data.stats.escalations_approved}/${data.stats.escalations_proposed} escalated`);
      }
      if (data.stats?.pending_count > 0) {
        console.log(chalk.yellow(`  Pending:    ${data.stats.pending_count} proposal(s) awaiting review`));
      }
      console.log();
      return;
    }

    if (sub === 'list') {
      const spinner = ora('Fetching profiles...').start();
      const data = await client.get('/reasoning/profiles');
      spinner.stop();
      if (!data || data?.error) { console.log(chalk.red(`  ${data?.error || 'Reasoning config unavailable — rebuild Genesis'}`)); return; }
      console.log();
      console.log(chalk.bold('  Available Profiles:'));
      for (const p of (data.profiles || [])) {
        const marker = p.active ? chalk.green('▸') : ' ';
        const status = !p.enabled ? chalk.dim('(disabled)') : '';
        const cost = p.cost_per_1k_tokens > 0 ? chalk.dim(`$${p.cost_per_1k_tokens}/1k`) : chalk.dim('free');
        console.log(`  ${marker} ${chalk.cyan(p.name.padEnd(12))} ${p.display_name.padEnd(28)} ${cost} ${status}`);
      }
      console.log();
      console.log(chalk.dim('  Switch: /models use <name>'));
      console.log();
      return;
    }

    if (sub === 'use' || sub === 'switch' || sub === 'profile') {
      const profile = parts[1];
      if (!profile) { console.log(chalk.yellow('  Usage: /models use <profile>')); return; }
      const spinner = ora(`Switching to ${profile}...`).start();
      const data = await client.put('/reasoning/profile', { profile });
      spinner.stop();
      if (data?.error) { console.log(chalk.red(`  ${data.error}`)); return; }
      console.log(chalk.green(`  Switched to ${data.display_name || profile} (model: ${data.model})`));
      return;
    }

    if (sub === 'set') {
      const slot = parts[1];
      const model = parts.slice(2).join(' ');
      if (!slot || !model) {
        console.log(chalk.yellow('  Usage: /models set <slot> <model>'));
        console.log(chalk.dim('  Slots: model, fast_model, premium_model, reasoning_model, vision_model'));
        console.log(chalk.dim('  Example: /models set reasoning_model gemma4-e4b'));
        return;
      }
      const spinner = ora(`Setting ${slot} = ${model}...`).start();
      const data = await client.put('/reasoning/model', { slot, value: model });
      spinner.stop();
      if (data?.error) { console.log(chalk.red(`  ${data.error}`)); return; }
      console.log(chalk.green(`  ${data.slot}: ${data.old_value} → ${data.new_value}`));
      console.log();
      console.log(chalk.bold('  Routing:'));
      console.log(formatRoutingTiers(data.routing));
      console.log();
      return;
    }

    if (sub === 'route' || sub === 'effort') {
      const tier = parts[1];
      const model = parts[2];
      const backend = parts[3];
      if (!tier || !model) {
        console.log(chalk.yellow('  Usage: /models route <tier> <model> [backend]'));
        console.log(chalk.dim('  Tiers: low (effort 1-4), medium (5-7), high (8-10)'));
        console.log(chalk.dim('  Example: /models route medium gemma4-e4b'));
        console.log(chalk.dim('  Example: /models route high deepseek-v4-flash deepseek'));
        return;
      }
      const body: any = { tier, model };
      if (backend) body.backend = backend;
      const spinner = ora(`Setting ${tier} tier → ${model}...`).start();
      const data = await client.put('/reasoning/effort-route', body);
      spinner.stop();
      if (data?.error) { console.log(chalk.red(`  ${data.error}`)); return; }
      console.log(chalk.green(`  ${data.tier} tier → ${data.route.model} (${data.route.backend})`));
      console.log();
      console.log(chalk.bold('  Routing:'));
      console.log(formatRoutingTiers(data.routing));
      console.log();
      return;
    }

    if (sub === 'escalation') {
      const toggle = (parts[1] || '').toLowerCase();
      if (toggle === 'on' || toggle === 'manual') {
        await client.put('/reasoning/escalation/config', { require_human_approval: true });
        console.log(chalk.green('  Escalation gate: manual approval required'));
      } else if (toggle === 'off' || toggle === 'auto') {
        await client.put('/reasoning/escalation/config', { require_human_approval: false });
        console.log(chalk.green('  Escalation gate: auto-escalation enabled'));
      } else {
        console.log(chalk.yellow('  Usage: /models escalation [on|off]'));
      }
      return;
    }

    // Unknown subcommand — show help
    console.log(chalk.yellow(`  Unknown: ${sub}. Use /models help`));
  },
};

// ── /v4 — One-shot V4 elevation (pass-through to chat) ──────────────

COMMANDS.v4 = {
  description: 'Elevate prompt to V4 reasoning model',
  usage: '/v4 <prompt>',
  handler: async (client: GenesisClient, args: string) => {
    if (!args.trim()) {
      console.log(chalk.yellow('  Usage: /v4 <prompt>'));
      console.log(chalk.dim('  Sends the prompt through DeepSeek V4 reasoning model'));
      return;
    }
    const spinner = ora('Routing to V4 reasoning...').start();
    const data = await client.post('/reasoning/elevate', {
      prompt: args.trim(),
      reasoning_mode: 'think_high',
    });
    spinner.stop();
    if (data?.error) { console.log(chalk.red(`  ${data.error}`)); return; }
    if (data?.reasoning) {
      console.log(chalk.dim('\n  Reasoning:'));
      console.log(chalk.dim('  ' + data.reasoning.slice(0, 500)));
      if (data.reasoning.length > 500) console.log(chalk.dim('  ...'));
    }
    console.log();
    console.log(data?.response || 'No response');
    console.log();
    if (data?.model) console.log(chalk.dim(`  Model: ${data.model}`));
    if (data?.tokens?.total_tokens) console.log(chalk.dim(`  Tokens: ${data.tokens.total_tokens}`));
  },
};
COMMANDS.elevate = COMMANDS.v4;

// ── /deepseek — interactive wizard: route the live orchestrator to DeepSeek ──
// Drives the REAL lever (model stack switch), NOT the reasoning profile (which
// only affects MCTS / one-shot /v4 and does nothing for normal chat turns).
// Flow: ensure DEEPSEEK_API_KEY → switch model stack to a DeepSeek stack →
// live test turn that PROVES generation actually came from DeepSeek.

// The stack whose tier_backends route effort>=5 to backend: deepseek_cloud.
const _DEEPSEEK_STACK = 'cloud-dsv4';
// Remembered so `/deepseek off` can revert to whatever was active before.
let _deepseekPrevStack: string | null = null;

/** Resolve the active model stack + whether it routes any tier to DeepSeek. */
async function _dsActiveStack(client: GenesisClient): Promise<{ stack: string; routesDeepseek: boolean; tiers: Record<string, string> }> {
  const data = await client.get('/model-stacks/active') as any;
  const stack = data?.stack || '(unknown)';
  const tb = (data?.routing?.tier_backends || {}) as Record<string, any>;
  const tiers: Record<string, string> = {};
  let routesDeepseek = false;
  for (const [tier, cfg] of Object.entries(tb)) {
    const backend = (cfg as any)?.backend || '';
    const model = (cfg as any)?.model || '';
    tiers[tier] = `${model} (${backend})`;
    if (/deepseek/i.test(backend) || /deepseek/i.test(model)) routesDeepseek = true;
  }
  return { stack, routesDeepseek, tiers };
}

/** True if a DEEPSEEK_API_KEY value is present in the vault. */
async function _dsKeyPresent(client: GenesisClient): Promise<boolean> {
  const r = await client.getDetailed('/secrets/DEEPSEEK_API_KEY') as any;
  const val = r?.value ?? r?.secret ?? '';
  return Boolean(val && String(val).trim());
}

/** Live test turn — proves generation actually came from DeepSeek (not local). */
async function _dsSelfTest(client: GenesisClient, config: ShellConfig): Promise<{ ok: boolean; model: string; gotContent: boolean; error: string }> {
  let model = '';
  let gotContent = false;
  let error = '';
  try {
    for await (const ev of client.streamChat('Reply with exactly the three words: DEEPSEEK ROUTE OK', {
      effort: 8,                 // effort 8 → 'deep' tier → deepseek_cloud in cloud-dsv4
      maxEffort: 8,
      agent: config.defaultAgent,
      sessionId: `deepseek-selftest-${Date.now()}`,
      priority: 'user',
    })) {
      const d: any = ev.data || {};
      if (d.model && typeof d.model === 'string') model = d.model;
      if (ev.type === 'token' || d.t) gotContent = true;
      if (d.via_cloud || d.via_bridge) gotContent = true;
      if (ev.type === 'error' || d.error) error = d.error || d.message || 'stream error';
      if (ev.type === 'stream_timeout') error = error || 'timed out waiting for tokens';
    }
  } catch (e: any) {
    error = e?.message || String(e);
  }
  // Definitive PASS = the served model name is a DeepSeek model.
  // Soft PASS = content streamed with no error (model name not surfaced by SSE).
  const ok = /deepseek/i.test(model) || (gotContent && !error);
  return { ok, model, gotContent, error };
}

COMMANDS.deepseek = {
  description: 'Route the live orchestrator to DeepSeek (interactive setup + self-test)',
  usage: '/deepseek [on|off|status|test]',
  handler: async (client: GenesisClient, args: string, config: ShellConfig) => {
    const sub = (args.trim().split(/\s+/)[0] || 'on').toLowerCase();

    // ── status ──────────────────────────────────────────────────────────
    if (sub === 'status') {
      const spinner = ora('Reading routing...').start();
      const st = await _dsActiveStack(client);
      const hasKey = await _dsKeyPresent(client);
      spinner.stop();
      console.log();
      console.log(chalk.bold('  Active stack: ') + chalk.cyan(st.stack));
      console.log(chalk.bold('  DeepSeek routed: ') + (st.routesDeepseek ? chalk.green('yes') : chalk.yellow('no — chatting against local/other')));
      console.log(chalk.bold('  API key stored:  ') + (hasKey ? chalk.green('yes') : chalk.red('no — run /deepseek on')));
      console.log();
      console.log(chalk.bold('  Effort tiers:'));
      for (const [tier, val] of Object.entries(st.tiers)) {
        const ds = /deepseek/i.test(val);
        console.log(`    ${tier.padEnd(10)} ${ds ? chalk.green(val) : chalk.dim(val)}`);
      }
      console.log();
      return;
    }

    // ── off / revert ────────────────────────────────────────────────────
    if (sub === 'off' || sub === 'revert' || sub === 'local') {
      let target = _deepseekPrevStack;
      if (!target) {
        // Fall back to the stack marked default.
        const list = await client.get('/model-stacks') as any;
        const def = (list?.stacks || []).find((s: any) => s.default);
        target = def?.name || 'dgx-hybrid';
      }
      const spinner = ora(`Reverting to ${target}...`).start();
      const res = await client.postDetailed('/model-stacks/switch', { stack: target }) as any;
      spinner.stop();
      if (res?.error) { console.log(chalk.red(`  Revert failed: ${res.error}`)); return; }
      _deepseekPrevStack = null;
      console.log(chalk.green(`  Reverted — orchestrator back on '${target}'.`));
      return;
    }

    // ── test only ───────────────────────────────────────────────────────
    if (sub === 'test') {
      const spinner = ora('Running live DeepSeek test turn...').start();
      const t = await _dsSelfTest(client, config);
      spinner.stop();
      if (t.ok) {
        console.log(chalk.green(`  ✓ DeepSeek answered${t.model ? ` (model: ${t.model})` : ''}.`));
      } else {
        console.log(chalk.red(`  ✗ Test failed${t.model ? ` (served: ${t.model})` : ''}${t.error ? ` — ${t.error}` : ''}.`));
        if (!/deepseek/i.test(t.model) && t.model) {
          console.log(chalk.yellow(`  The turn was served by '${t.model}', not DeepSeek — stack may not be switched.`));
        }
      }
      return;
    }

    // ── on (default): full interactive wizard ───────────────────────────
    console.log();
    console.log(chalk.bold.cyan('  DeepSeek orchestrator setup'));
    console.log(chalk.dim('  Routes the model you chat with to the DeepSeek API (V4). Reversible with /deepseek off.'));
    console.log();

    // 1. Show where we are.
    let spinner = ora('Checking current routing...').start();
    const before = await _dsActiveStack(client);
    const hasKey = await _dsKeyPresent(client);
    spinner.stop();
    console.log(chalk.dim(`  Current stack: ${before.stack}${before.routesDeepseek ? ' (already routes DeepSeek)' : ''}`));

    // 2. Ensure the API key exists (prompt if missing).
    if (!hasKey) {
      console.log();
      console.log(chalk.yellow('  No DEEPSEEK_API_KEY found in the vault.'));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));
      let key = '';
      try {
        key = (await ask(chalk.cyan('  Paste your DeepSeek API key (or blank to cancel): '))).trim();
      } finally {
        rl.close();
      }
      if (!key) { console.log(chalk.yellow('  Cancelled — no key entered.')); return; }
      spinner = ora('Storing key in vault...').start();
      const sres = await client.postDetailed('/secrets', { key: 'DEEPSEEK_API_KEY', value: key }) as any;
      spinner.stop();
      if (sres?.error) { console.log(chalk.red(`  Failed to store key: ${sres.error}`)); return; }
      console.log(chalk.green('  ✓ Key stored.'));
    } else {
      console.log(chalk.dim('  DEEPSEEK_API_KEY already in vault — reusing it.'));
    }

    // 3. Switch the model stack (the real lever) unless already there.
    if (before.stack !== _DEEPSEEK_STACK) {
      _deepseekPrevStack = before.stack;
      spinner = ora(`Switching model stack → ${_DEEPSEEK_STACK}...`).start();
      const swres = await client.postDetailed('/model-stacks/switch', { stack: _DEEPSEEK_STACK }) as any;
      spinner.stop();
      if (swres?.error) {
        console.log(chalk.red(`  Stack switch failed: ${swres.error}`));
        console.log(chalk.dim('  (Need execute permission, and Genesis + MicroScheduler must be up.)'));
        return;
      }
      console.log(chalk.green(`  ✓ Stack switched to ${_DEEPSEEK_STACK} (effort 5+ → DeepSeek).`));
    } else {
      console.log(chalk.dim(`  Already on ${_DEEPSEEK_STACK}.`));
    }

    // 4. Prove it: live test turn.
    spinner = ora('Verifying with a live DeepSeek turn...').start();
    const t = await _dsSelfTest(client, config);
    spinner.stop();
    console.log();
    if (t.ok) {
      console.log(chalk.green.bold(`  ✓ Working — DeepSeek served the turn${t.model ? ` (model: ${t.model})` : ''}.`));
      console.log(chalk.dim('  Effort 5+ chat now routes to DeepSeek. Low-effort reflex stays local.'));
      console.log(chalk.dim('  Revert anytime:  /deepseek off    •    Re-check:  /deepseek status'));
    } else {
      console.log(chalk.red.bold('  ✗ Stack switched but the test turn did NOT confirm DeepSeek.'));
      if (t.model) console.log(chalk.yellow(`    Served by: ${t.model}`));
      if (t.error) console.log(chalk.yellow(`    Error: ${t.error}`));
      console.log(chalk.dim('    Likely causes: bad/missing key, V4 model name not allowed for your key,'));
      console.log(chalk.dim('    or MicroScheduler down. Check: /deepseek status  and  /secrets get DEEPSEEK_API_KEY'));
    }
    console.log();
  },
};

// ── /gateway — provision an ACTA gateway key for a deployment (the provision_gateway_key tool) ──
COMMANDS.gateway = {
  description: 'Provision a scoped ACTA gateway key (aither_sk_live_*) for a deployment',
  usage: '/gateway mint <tenant> [scopes] [days]',
  handler: async (client: GenesisClient, args: string, _config: ShellConfig) => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts[0] !== 'mint' || !parts[1]) {
      console.log(chalk.yellow('  usage: /gateway mint <tenant> [scopes] [days]'));
      console.log(chalk.dim('  e.g.   /gateway mint daoos-usb-demo  chat,agent:ask  30'));
      return;
    }
    const tenant = parts[1];
    const scopes = parts[2] || 'chat,agent:ask,agent:read';
    const days = parseInt(parts[3] || '30', 10) || 30;
    console.log(chalk.cyan(`  minting gateway key for ${tenant} (${scopes}, ${days}d)…`));
    const res = await invokeMcpTool(client, 'provision_gateway_key',
      { tenant, scopes, expires_in_days: days });
    if (res?.error) { console.log(chalk.red('  ✗ ' + res.error)); return; }
    const key = res?.api_key || res?.key || '';
    if (key) {
      console.log(chalk.green(`  ✓ minted: ${String(key).slice(0, 18)}…${String(key).slice(-4)}`));
      console.log(chalk.dim('  Save it to your deployment .env as AITHER_GATEWAY_KEY — shown once, never commit it.'));
    } else {
      console.log(chalk.dim('  ' + JSON.stringify(res)));
    }
  },
};

// ── /panel — interactive dev control panel (secrets/env • routing • MCP • status) ──
// A pop-up console you drive with the keyboard — no memorizing commands. Uses the
// proven rl.question loop (same input path as /login and /deepseek), so it works in
// both plain and TUI modes. Authenticated as the active shell user.
COMMANDS.panel = {
  description: 'Dev control panel — routing/DeepSeek, MCP tools, secrets/env, status',
  usage: '/panel',
  handler: async (client: GenesisClient, _args: string, config: ShellConfig) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));
    const pause = async () => { await ask(chalk.dim('\n  ↵ enter to continue ')); };
    const rule = (w = 58) => chalk.dim('  ' + '─'.repeat(w));

    const header = (title: string) => {
      console.clear();
      console.log();
      console.log(chalk.bold.cyan(`  AitherOS Dev Panel`) + chalk.dim(`  ·  ${title}`));
      const who = config.authUser?.email || config.authUser?.username || 'local';
      console.log(chalk.dim(`  ${who}  ·  ${config.genesisUrl}`));
      console.log(rule());
    };

    // ── Section: Model routing & DeepSeek ──────────────────────────────
    const routingMenu = async () => {
      let back = false;
      while (!back) {
        header('Model routing & DeepSeek');
        const spin = ora('Reading routing...').start();
        const st = await _dsActiveStack(client).catch(() => null as any);
        const hasKey = await _dsKeyPresent(client).catch(() => false);
        spin.stop();
        if (!st) { console.log(chalk.red('  Could not read /model-stacks/active (Genesis down?).')); await pause(); return; }
        console.log(chalk.bold('  Active stack:    ') + chalk.cyan(st.stack));
        console.log(chalk.bold('  DeepSeek routed: ') + (st.routesDeepseek ? chalk.green('yes (effort 5+)') : chalk.yellow('no')));
        console.log(chalk.bold('  DeepSeek key:    ') + (hasKey ? chalk.green('stored') : chalk.red('missing')));
        console.log();
        for (const [tier, val] of Object.entries(st.tiers)) {
          const ds = /deepseek/i.test(val as string);
          console.log(`    ${tier.padEnd(10)} ${ds ? chalk.green(val as string) : chalk.dim(val as string)}`);
        }
        console.log(rule());
        console.log('  [d] route orchestrator → DeepSeek    [l] revert to local/previous');
        console.log('  [t] live self-test                   [r] refresh        [b] back');
        const c = (await ask('\n  > ')).trim().toLowerCase();
        if (c === 'b' || c === '') { back = true; }
        else if (c === 'r') { /* loop re-reads */ }
        else if (c === 'd') {
          if (st.stack !== _DEEPSEEK_STACK) _deepseekPrevStack = st.stack;
          const s2 = ora(`Switching → ${_DEEPSEEK_STACK}...`).start();
          const res = await client.postDetailed('/model-stacks/switch', { stack: _DEEPSEEK_STACK }) as any;
          s2.stop();
          console.log(res?.error ? chalk.red(`  Failed: ${res.error}`) : chalk.green(`  ✓ Switched to ${_DEEPSEEK_STACK}.`));
          await pause();
        } else if (c === 'l') {
          const target = _deepseekPrevStack || 'dgx-hybrid';
          const s2 = ora(`Reverting → ${target}...`).start();
          const res = await client.postDetailed('/model-stacks/switch', { stack: target }) as any;
          s2.stop();
          if (!res?.error) _deepseekPrevStack = null;
          console.log(res?.error ? chalk.red(`  Failed: ${res.error}`) : chalk.green(`  ✓ Reverted to ${target}.`));
          await pause();
        } else if (c === 't') {
          const s2 = ora('Live DeepSeek test turn...').start();
          const t = await _dsSelfTest(client, config);
          s2.stop();
          console.log(t.ok ? chalk.green(`  ✓ Served by ${t.model || 'model'} — working.`)
            : chalk.red(`  ✗ ${t.error || 'no DeepSeek response'}${t.model ? ` (served: ${t.model})` : ''}`));
          await pause();
        }
      }
    };

    // ── Section: MCP tools ─────────────────────────────────────────────
    const mcpMenu = async () => {
      header('MCP tools');
      const spin = ora('Loading tools...').start();
      let tools: any[] = [];
      try {
        const remote = getRemoteMcpClient(config);
        if (remote) { await remote.connect(); tools = await remote.listTools(); }
        else { const r = await client.get('/tools') as any; tools = r?.tools || []; }
      } catch (e: any) { spin.stop(); console.log(chalk.red(`  Could not list tools: ${e?.message || e}`)); await pause(); return; }
      spin.stop();
      if (!tools.length) { console.log(chalk.yellow('  No MCP tools available (is the MCP gateway connected?).')); await pause(); return; }
      let back = false;
      let filter = '';
      while (!back) {
        header('MCP tools');
        const shown = (filter ? tools.filter(t => (t.name || '').toLowerCase().includes(filter)) : tools).slice(0, 30);
        shown.forEach((t, i) => {
          const desc = (t.description || '').split('\n')[0].slice(0, 60);
          console.log(`  ${String(i + 1).padStart(2)}. ${chalk.cyan((t.name || '').padEnd(28))} ${chalk.dim(desc)}`);
        });
        console.log(rule());
        console.log(chalk.dim(`  ${shown.length} of ${tools.length} shown.  Type a number to run, /<text> to filter, b to go back.`));
        const c = (await ask('\n  > ')).trim();
        if (c.toLowerCase() === 'b' || c === '') { back = true; }
        else if (c.startsWith('/')) { filter = c.slice(1).toLowerCase(); }
        else {
          const idx = parseInt(c, 10) - 1;
          const tool = shown[idx];
          if (!tool) { console.log(chalk.yellow('  No such number.')); await pause(); continue; }
          console.log(chalk.dim(`\n  Args for ${tool.name} — JSON object, or k=v space-separated, or blank for none:`));
          const raw = (await ask('  args> ')).trim();
          let params: Record<string, any> = {};
          if (raw) {
            try { params = raw.startsWith('{') ? JSON.parse(raw)
              : Object.fromEntries(raw.split(/\s+/).map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; })); }
            catch (e: any) { console.log(chalk.red(`  Bad args: ${e?.message || e}`)); await pause(); continue; }
          }
          const s2 = ora(`Running ${tool.name}...`).start();
          const res = await invokeMcpTool(client, tool.name, params);
          s2.stop();
          console.log(rule());
          if (res?.error) console.log(chalk.red(`  Error: ${res.error}`));
          else console.log('  ' + (typeof res === 'string' ? res : JSON.stringify(res, null, 2)).split('\n').join('\n  '));
          await pause();
        }
      }
    };

    // ── Section: Secrets & env ─────────────────────────────────────────
    const secretsMenu = async () => {
      header('Secrets & env');
      const spin = ora('Reading vault...').start();
      // Genesis has no /secrets route on all deployments; probe and degrade honestly.
      const listing = await client.getDetailed('/secrets') as any;
      spin.stop();
      const keys = listing?.keys || listing?.secrets;
      if (Array.isArray(keys)) {
        console.log(chalk.bold(`  ${keys.length} secret(s):`));
        for (const k of keys) console.log(`    ${chalk.cyan(typeof k === 'string' ? k : (k.key || k.name))}`);
        console.log(rule());
        console.log('  [s] set a secret   [d] delete   [b] back');
        const c = (await ask('\n  > ')).trim().toLowerCase();
        if (c === 's') {
          const k = (await ask('  key:   ')).trim();
          const v = (await ask('  value: ')).trim();
          if (k && v) {
            const r = await client.postDetailed('/secrets', { key: k, value: v }) as any;
            console.log(r?.error ? chalk.red(`  Failed: ${r.error}`) : chalk.green(`  ✓ ${k} stored.`));
          }
          await pause();
        } else if (c === 'd') {
          const k = (await ask('  key to delete: ')).trim();
          if (k) { const r = await client.postDetailed(`/secrets/${k}/delete`, {}) as any; console.log(r?.error ? chalk.red(`  Failed: ${r.error}`) : chalk.green(`  ✓ ${k} deleted.`)); }
          await pause();
        }
      } else {
        console.log(chalk.yellow('  The secrets vault is not exposed through Genesis on this deployment.'));
        console.log(chalk.dim('  (GET /secrets → 404. The vault at :8111 rejects unauthenticated writes by design.)'));
        console.log();
        console.log(chalk.dim('  To make this section live, a small owner-gated Genesis route is needed that'));
        console.log(chalk.dim('  proxies reads/writes to AitherSecrets using Genesis’s in-cluster credential.'));
        console.log(chalk.dim('  Routing, MCP tools, and status below work without it.'));
        await pause();
      }
    };

    // ── Section: Service status ────────────────────────────────────────
    const statusView = async () => {
      header('Service status');
      const spin = ora('Querying Genesis...').start();
      const st = await client.get('/status').catch(() => null) as any;
      spin.stop();
      if (!st) { console.log(chalk.red('  /status unavailable.')); await pause(); return; }
      const tracked = st.tracked_services ?? st.count ?? '?';
      const healthy = st.healthy ?? st.healthy_count ?? '?';
      console.log(chalk.bold('  Tracked services: ') + tracked);
      console.log(chalk.bold('  Healthy:          ') + healthy);
      if (st.generation_ready !== undefined) console.log(chalk.bold('  Generation ready: ') + (st.generation_ready ? chalk.green('yes') : chalk.yellow('no')));
      await pause();
    };

    // ── Main loop ──────────────────────────────────────────────────────
    try {
      let running = true;
      while (running) {
        header('main');
        console.log('  1) Model routing & DeepSeek');
        console.log('  2) MCP tools');
        console.log('  3) Secrets & env');
        console.log('  4) Service status');
        console.log('  q) Quit');
        const c = (await ask('\n  > ')).trim().toLowerCase();
        if (c === 'q' || c === 'quit' || c === 'exit') running = false;
        else if (c === '1') await routingMenu();
        else if (c === '2') await mcpMenu();
        else if (c === '3') await secretsMenu();
        else if (c === '4') await statusView();
      }
    } finally {
      rl.close();
      console.clear();
      console.log(chalk.dim('  Dev panel closed.'));
    }
  },
};

COMMANDS['pool'] = {
  description: 'LLM pool management — check status or reset stuck slots',
  usage: '/pool [status|reset]',
  handler: async (client: GenesisClient, args: string) => {
    const sub = args.trim().toLowerCase() || 'status';
    const candidates = [process.env.AITHER_LLM_URL, 'https://localhost:8150', 'http://localhost:8150'].filter(Boolean) as string[];

    async function fetchPool(path: string, method: string = 'GET'): Promise<any> {
      for (const base of candidates) {
        try {
          const r = await fetch(`${base}${path}`, {
            method,
            signal: AbortSignal.timeout(5000),
          });
          if (r.ok) return r.json();
        } catch {}
      }
      return null;
    }

    if (sub === 'reset') {
      const result = await fetchPool('/llm/pool/vllm/reset', 'POST');
      if (result?.ok) {
        console.log(chalk.green('  Pool reset successful.'));
        const s = result.stats;
        console.log(chalk.dim(`  Slots: ${s.available_for_user}/${s.total_slots} available`));
        console.log(chalk.dim(`  Lifetime: ${s.lifetime_acquired} acquired, ${s.lifetime_timeouts} timeouts`));
      } else {
        console.log(chalk.red(`  Pool reset failed: ${result?.error || 'unreachable'}`));
      }
    } else {
      const stats = await fetchPool('/queue/vllm-pool');
      if (stats) {
        const avail = stats.available_for_user ?? 0;
        const total = stats.total_slots ?? 0;
        const active = stats.active_total ?? 0;
        const color = avail === 0 ? chalk.red : avail < total / 4 ? chalk.yellow : chalk.green;
        console.log(color(`  Pool: ${avail}/${total} slots available (${active} active)`));
        console.log(chalk.dim(`  Lifetime: ${stats.lifetime_acquired} acquired, ${stats.lifetime_released} released, ${stats.lifetime_timeouts} timeouts`));
        if (stats.leak_delta > 0) {
          console.log(chalk.yellow(`  Leak detected: ${stats.leak_delta} unreleased slots`));
        }
        if (stats.active_by_priority && Object.keys(stats.active_by_priority).length > 0) {
          console.log(chalk.dim(`  Active by priority: ${JSON.stringify(stats.active_by_priority)}`));
        }
      } else {
        console.log(chalk.red('  Cannot reach MicroScheduler pool endpoint.'));
      }
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// FLEET — rebuild every lib-baking Python image + safe rolling recreate onto current code
// ═══════════════════════════════════════════════════════════════════════════
COMMANDS['fleet'] = {
  description: 'Fleet refresh — rebuild all lib-baking Python images + safe rolling recreate',
  usage: '/fleet refresh [--build-only|--recreate-only|--dry-run]',
  handler: async (_client: GenesisClient, args: string, _config: ShellConfig) => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
    const script = join(repoRoot, '.DEPLOYMENT', 'scripts', 'fleet-refresh.sh');
    if (!existsSync(script)) {
      console.log(chalk.red(`  fleet-refresh.sh not found: ${script}`));
      return;
    }
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts[0] !== 'refresh') {
      console.log(chalk.yellow('  Usage: /fleet refresh [--build-only|--recreate-only|--dry-run]'));
      return;
    }
    const allowed = ['--build-only', '--recreate-only', '--dry-run'];
    const flags = parts.slice(1).filter((f) => allowed.includes(f));
    console.log(chalk.cyan(`  Running fleet-refresh ${flags.join(' ')} ...`));
    try {
      execSync(`bash "${script}" ${flags.join(' ')}`, { stdio: 'inherit', cwd: repoRoot });
    } catch (e: any) {
      console.log(chalk.red(`  fleet-refresh failed: ${e?.message || e}`));
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// DOCKER — Container lifecycle management
// ═══════════════════════════════════════════════════════════════════════════
COMMANDS['docker'] = {
  description: 'Manage Docker containers (up/down/status/build/restart/logs/ps/recover)',
  usage: '/docker <up|down|status|restart|build|logs|ps|recover> [--build] [service]',
  handler: async (_client: GenesisClient, args: string, _config: ShellConfig) => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
      const composeFile = join(repoRoot, 'docker-compose.aitheros.yml');

      if (!existsSync(composeFile)) {
        console.log(chalk.red(`  Compose file not found: ${composeFile}`));
        return;
      }

      // ALL profiles — nothing skipped
      const SAFE_PROFILES = [
        'all', 'chat-minimal', 'chat-full', 'chat-agents', 'core',
        'intelligence', 'agents', 'autonomic', 'communication', 'creative',
        'desktop', 'bootloader', 'tunnel', 'portal-creative', 'creative-studio',
        'creative-full', 'security', 'dgx-hybrid',
      ];
      const profileFlags = SAFE_PROFILES.map(p => `--profile ${p}`).join(' ');
      const baseCmd = `docker compose -f "${composeFile}" ${profileFlags}`;

      const parts = args.trim().split(/\s+/);
      const subcmd = (parts[0] || 'status').toLowerCase();
      const rest = parts.slice(1).join(' ');
      const wantBuild = rest.includes('--build');

      switch (subcmd) {
        case 'up': {
          const buildFlag = wantBuild ? '--build' : '--no-build';
          const spinner = ora(`Starting containers${wantBuild ? ' (building)' : ''}...`).start();
          try {
            execSync(`${baseCmd} up -d ${buildFlag}`, {
              encoding: 'utf-8',
              timeout: 600000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            const count = execSync('docker ps -q', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n').filter(Boolean).length;
            spinner.succeed(chalk.green(`  ${count} containers running`));
          } catch (e: any) {
            spinner.fail(chalk.red('  Some containers failed to start'));
            const errMsg = e.stderr?.toString() || e.message || '';
            const errors = errMsg.split('\n').filter((l: string) => l.includes('Error')).slice(0, 5);
            errors.forEach((line: string) => console.log(chalk.dim(`  ${line.trim()}`)));
            // Still show what's running
            const count = execSync('docker ps -q', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n').filter(Boolean).length;
            console.log(chalk.yellow(`  ${count} containers running despite errors`));
          }
          break;
        }

        case 'down': {
          const spinner = ora('Stopping all containers...').start();
          try {
            execSync(`${baseCmd} down --remove-orphans`, {
              encoding: 'utf-8',
              timeout: 120000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            spinner.succeed(chalk.green('  All containers stopped'));
          } catch (e: any) {
            spinner.fail(chalk.red('  Error stopping containers'));
            console.log(chalk.dim(`  ${e.message?.slice(0, 200)}`));
          }
          break;
        }

        case 'restart': {
          const spinner = ora('Restarting all containers...').start();
          try {
            execSync(`${baseCmd} down --remove-orphans`, {
              encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
            });
            execSync(`${baseCmd} up -d --no-build`, {
              encoding: 'utf-8', timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'],
            });
            const count = execSync('docker ps -q', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n').filter(Boolean).length;
            spinner.succeed(chalk.green(`  Restarted: ${count} containers running`));
          } catch (e: any) {
            spinner.fail(chalk.red('  Restart failed'));
            console.log(chalk.dim(`  ${e.message?.slice(0, 200)}`));
          }
          break;
        }

        case 'build': {
          console.log(chalk.cyan('  Building all images (this may take a while)...\n'));
          try {
            const child = spawn('docker', ['compose', '-f', composeFile, ...SAFE_PROFILES.flatMap(p => ['--profile', p]), 'build'], {
              cwd: repoRoot,
              stdio: 'inherit',
            });
            await new Promise<void>((res, rej) => {
              child.on('close', (code) => code === 0 ? res() : rej(new Error(`Build exited ${code}`)));
            });
            console.log(chalk.green('\n  Build complete'));
          } catch (e: any) {
            console.log(chalk.red(`\n  Build failed: ${e.message}`));
          }
          break;
        }

        case 'status':
        case 'ps': {
          try {
            const output = execSync('docker ps -a --format "{{.Names}}\\t{{.Status}}"', {
              encoding: 'utf-8', timeout: 10000,
            }).trim();
            const lines = output ? output.split('\n') : [];
            const running = lines.filter(l => l.includes('Up'));
            const exited = lines.filter(l => l.includes('Exited'));
            const other = lines.filter(l => !l.includes('Up') && !l.includes('Exited'));

            console.log();
            console.log(chalk.green(`  Running: ${running.length}`));
            if (exited.length) console.log(chalk.red(`  Exited:  ${exited.length}`));
            if (other.length) console.log(chalk.yellow(`  Other:   ${other.length}`));
            console.log(chalk.dim(`  Total:   ${lines.length}`));

            if (subcmd === 'ps') {
              console.log();
              const rows = lines.slice(0, 60).map(l => {
                const [name, ...statusParts] = l.split('\t');
                const status = statusParts.join(' ');
                const icon = status.includes('Up') ? chalk.green('\u25cf')
                  : status.includes('Restarting') ? chalk.yellow('\u25cf')
                  : chalk.red('\u25cf');
                return [icon + ' ' + chalk.cyan(name), status];
              });
              console.log(formatTable(['  Container', 'Status'], rows));
              if (lines.length > 60) console.log(chalk.dim(`  ... and ${lines.length - 60} more`));
            }

            // Show failures if any
            if (exited.length && subcmd === 'status') {
              console.log(chalk.dim('\n  Failed containers:'));
              exited.slice(0, 10).forEach(l => {
                const [name] = l.split('\t');
                console.log(chalk.red(`    \u2717 ${name}`));
              });
              if (exited.length > 10) console.log(chalk.dim(`    ... and ${exited.length - 10} more`));
            }
          } catch {
            console.log(chalk.red('  Cannot reach Docker daemon'));
          }
          break;
        }

        case 'logs': {
          const service = rest.replace('--build', '').trim();
          if (!service) {
            console.log(chalk.yellow('  Usage: /docker logs <container-name>'));
            console.log(chalk.dim('  Example: /docker logs aitheros-genesis'));
            return;
          }
          const containerName = service.startsWith('aitheros-') || service.startsWith('aither-')
            ? service : `aitheros-${service}`;
          console.log(chalk.dim(`  Tailing logs for ${containerName} (Ctrl+C to stop)...\n`));
          const child = spawn('docker', ['logs', '-f', '--tail', '50', containerName], {
            stdio: 'inherit',
          });
          await new Promise<void>((res) => {
            child.on('close', () => res());
            child.on('error', () => res());
          });
          break;
        }

        case 'recover': {
          // Recover Docker Desktop from WSL2 500-error hang (no reboot needed)
          console.log();
          const isHealthy = (() => {
            try {
              const r = execSync('docker info 2>&1', { encoding: 'utf-8', timeout: 10000 });
              return !r.includes('500 Internal Server Error');
            } catch { return false; }
          })();
          if (isHealthy && !rest.includes('--force')) {
            console.log(chalk.green('  Docker engine is healthy. Use --force to recover anyway.'));
            break;
          }
          console.log(chalk.red('  Docker engine is DOWN. Starting recovery...'));
          const recoverSteps: [string, string[]][] = [
            ['[1/5] Killing Docker Desktop...', [
              'taskkill /F /IM "Docker Desktop.exe" 2>NUL',
              'taskkill /F /IM "com.docker.backend.exe" 2>NUL',
              'taskkill /F /IM "com.docker.build.exe" 2>NUL',
              'taskkill /F /IM "docker-agent.exe" 2>NUL',
              'taskkill /F /IM "docker-sandbox.exe" 2>NUL',
            ]],
            ['[2/5] Shutting down WSL...', ['wsl --shutdown']],
            ['[3/5] Cleaning up zombie processes...', [
              'taskkill /F /IM vmmem 2>NUL',
              'taskkill /F /IM wslservice.exe 2>NUL',
            ]],
            ['[4/5] Restarting Docker service...', [
              'net stop com.docker.service 2>NUL',
              'net start com.docker.service 2>NUL',
            ]],
          ];
          for (const [label, shellCmds] of recoverSteps) {
            console.log(chalk.yellow(`  ${label}`));
            for (const c of shellCmds) {
              try { execSync(c, { encoding: 'utf-8', timeout: 15000, stdio: 'pipe' }); } catch {}
            }
            await new Promise<void>(r => setTimeout(r, 2000));
          }
          console.log(chalk.yellow('  [5/5] Starting Docker Desktop...'));
          spawn('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', [], {
            detached: true, stdio: 'ignore',
          }).unref();
          // Wait for engine to come back
          const recoverSpinner = ora('  Waiting for Docker engine...').start();
          let recovered = false;
          for (let elapsed = 5; elapsed <= 90; elapsed += 5) {
            await new Promise<void>(r => setTimeout(r, 5000));
            try {
              const info = execSync('docker info 2>&1', { encoding: 'utf-8', timeout: 10000 });
              if (!info.includes('500 Internal Server Error')) {
                recoverSpinner.succeed(chalk.green(`  Docker recovered in ${elapsed}s!`));
                recovered = true;
                break;
              }
            } catch {}
          }
          if (!recovered) {
            recoverSpinner.fail(chalk.red('  Recovery failed after 90s. You may need to reboot.'));
            break;
          }
          // Clean up dead containers
          try {
            const deadContainers = execSync('docker ps -a --filter status=dead --format "{{.Names}}"', {
              encoding: 'utf-8', timeout: 10000,
            }).trim();
            for (const name of deadContainers.split('\n').filter(Boolean)) {
              console.log(chalk.dim(`  Removing dead: ${name}`));
              try { execSync(`docker rm -f ${name}`, { timeout: 10000, stdio: 'pipe' }); } catch {}
            }
          } catch {}
          // Restart exited containers
          try {
            const exitedContainers = execSync('docker ps -a --filter status=exited --format "{{.Names}}"', {
              encoding: 'utf-8', timeout: 10000,
            }).trim();
            for (const name of exitedContainers.split('\n').filter(Boolean)) {
              console.log(chalk.dim(`  Restarting: ${name}`));
              try { execSync(`docker start ${name}`, { timeout: 10000, stdio: 'pipe' }); } catch {}
            }
          } catch {}
          const finalCount = execSync('docker ps -q', { encoding: 'utf-8', timeout: 5000 }).trim().split('\n').filter(Boolean).length;
          console.log(chalk.green(`  ${finalCount} containers running`));
          break;
        }

        default:
          console.log(chalk.yellow('  Unknown subcommand: ' + subcmd));
          console.log(chalk.dim('  Available: up [--build], down, restart, build, status, ps, logs <service>, recover [--force]'));
      }
    },
};
COMMANDS['dc'] = COMMANDS['docker'];

// ═══════════════════════════════════════════════════════════════════════════
// COMPUTE — Federated Compute Fabric management
// ═══════════════════════════════════════════════════════════════════════════
COMMANDS['compute'] = {
  description: 'Manage federated compute fabric (discover/backends/nodes/scale/status)',
  usage: '/compute <discover|backends|nodes|scale|status> [args]',
  handler: async (client: GenesisClient, args: string, _config: ShellConfig) => {
    const parts = args.trim().split(/\s+/);
    const subcmd = (parts[0] || 'discover').toLowerCase();
    const rest = parts.slice(1).join(' ');

    switch (subcmd) {
      case 'discover': {
        const data = await client.get('/compute/discover');
        if (!data) { console.log(chalk.red('  Cannot reach Genesis /compute/discover')); return; }
        console.log(chalk.bold.cyan('\n  Compute Fabric Discovery\n'));
        const agents = data.agents || [];
        const backends = data.llm_backends || [];
        const gpus = data.gpu_nodes || [];
        const remote = data.remote_agents || [];
        console.log(chalk.white(`  Agents: ${agents.length}  |  Backends: ${backends.length}  |  GPU Nodes: ${gpus.length}  |  Remote: ${remote.length}`));
        if (backends.length > 0) {
          console.log(chalk.dim('\n  LLM Backends:'));
          for (const b of backends) {
            const health = b.healthy ? chalk.green('●') : chalk.red('●');
            console.log(`    ${health} ${b.name || b.backend_id} (${b.backend_type}) → ${b.endpoint_url}  [${b.latency_ms?.toFixed(0) || '?'}ms]`);
          }
        }
        if (gpus.length > 0) {
          console.log(chalk.dim('\n  GPU Nodes:'));
          for (const n of gpus) {
            const alive = n.is_alive ? chalk.green('●') : chalk.red('●');
            const vram = n.metadata?.vram_gb ? `${n.metadata.vram_gb}GB` : '?';
            console.log(`    ${alive} ${n.name || n.node_id} (${n.location}) ${n.address}:${n.port}  VRAM=${vram}`);
          }
        }
        console.log('');
        break;
      }

      case 'backends': {
        const sub2 = parts[1] || 'list';
        if (sub2 === 'list') {
          const data = await client.get('/compute/backends');
          if (!data) { console.log(chalk.red('  Cannot reach Genesis')); return; }
          const items = data.backends || data || [];
          if (items.length === 0) { console.log(chalk.yellow('  No backends registered')); return; }
          console.log(chalk.bold.cyan('\n  Registered LLM Backends\n'));
          for (const b of items) {
            const health = b.healthy ? chalk.green('●') : chalk.red('●');
            console.log(`    ${health} ${b.name || b.backend_id}  ${b.backend_type}  ${b.endpoint_url}  models=[${(b.models || []).join(',')}]`);
          }
          console.log('');
        } else {
          console.log(chalk.yellow(`  Unknown subcommand: backends ${sub2}`));
          console.log(chalk.dim('  Available: list'));
        }
        break;
      }

      case 'nodes': {
        const sub2 = parts[1] || 'list';
        if (sub2 === 'list') {
          const data = await client.get('/compute/nodes');
          if (!data) { console.log(chalk.red('  Cannot reach Genesis')); return; }
          const items = data.nodes || data || [];
          if (items.length === 0) { console.log(chalk.yellow('  No GPU nodes registered')); return; }
          console.log(chalk.bold.cyan('\n  GPU Compute Nodes\n'));
          for (const n of items) {
            const alive = n.is_alive ? chalk.green('●') : chalk.red('●');
            console.log(`    ${alive} ${n.name || n.node_id}  ${n.location}  ${n.address}:${n.port}  caps=[${(n.capabilities || []).join(',')}]`);
          }
          console.log('');
        } else {
          console.log(chalk.yellow(`  Unknown subcommand: nodes ${sub2}`));
        }
        break;
      }

      case 'scale': {
        const direction = parts[1] || '';
        const pool = parts[2] || 'cloud_llm';
        if (!direction || !['up', 'down'].includes(direction)) {
          console.log(chalk.yellow('  Usage: /compute scale <up|down> [pool_type]'));
          return;
        }
        const data = await client.post('/compute/autoscale/trigger', { action: direction, pool_type: pool });
        if (data) {
          console.log(chalk.green(`  Scale ${direction} triggered for pool=${pool}`));
        } else {
          console.log(chalk.red('  Scale action failed'));
        }
        break;
      }

      case 'status': {
        const data = await client.get('/compute/status');
        if (!data) { console.log(chalk.red('  Cannot reach Genesis /compute/status')); return; }
        console.log(chalk.bold.cyan('\n  Compute Fabric Status\n'));
        console.log(`  Nodes: ${data.total_nodes || 0}  (online: ${data.online_nodes || 0})`);
        console.log(`  Backends: ${data.total_backends || 0}  (healthy: ${data.healthy_backends || 0})`);
        console.log(`  Policies: ${data.total_policies || 0}`);
        if (data.grafana_url) console.log(chalk.dim(`  Grafana: ${data.grafana_url}`));
        console.log('');
        break;
      }

      default:
        console.log(chalk.yellow(`  Unknown subcommand: ${subcmd}`));
        console.log(chalk.dim('  Available: discover, backends, nodes, scale, status'));
    }
  },
};

/* ═══════════════════════════════════════════════════════════════════════════════
 * AUTONOMOUS AGENT COMMANDS — Calendar, Mail, Will, Escalate, Research, Publish
 * ═══════════════════════════════════════════════════════════════════════════════ */

COMMANDS['calendar'] = {
  description: 'Manage calendar events',
  usage: '/calendar [list|create "<title>" --start <ISO> [--end <ISO>]|delete <id>|sync]',
  handler: async (client: GenesisClient, args: string) => {
    const parsed = parseQuotedArgs(args.trim());
    const sub = (parsed[0] || 'list').toLowerCase();
    if (sub === 'list') {
      const spinner = ora('Loading calendar...').start();
      try {
        const result = await client.get('/calendar') as any;
        spinner.stop();
        const events = result?.events || result?.items || [];
        if (!events.length) { console.log(chalk.dim('  No upcoming events.')); return; }
        console.log();
        for (const ev of events.slice(0, 20)) {
          const start = ev.start || ev.start_time || '';
          const title = ev.title || ev.summary || ev.name || '';
          console.log(`  ${chalk.cyan(start.slice(0, 16))}  ${chalk.bold(title)}`);
        }
        console.log();
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'create') {
      const title = parsed[1];
      if (!title) { console.log(chalk.dim('  Usage: /calendar create "<title>" --start <ISO> [--end <ISO>]')); return; }
      const flagStr = parsed.slice(2).join(' ');
      const startMatch = flagStr.match(/--start\s+(\S+)/);
      const endMatch = flagStr.match(/--end\s+(\S+)/);
      if (!startMatch) { console.log(chalk.red('  --start <ISO datetime> required.')); return; }
      const spinner = ora('Creating event...').start();
      try {
        const body: any = { title, start: startMatch[1] };
        if (endMatch) body.end = endMatch[1];
        const result = await client.post('/calendar', body) as any;
        spinner.stop();
        console.log(chalk.green(`  Event created: ${result?.id || result?.event_id || 'OK'}`));
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'delete' && parsed[1]) {
      const spinner = ora('Deleting event...').start();
      try {
        const result = await client.delete(`/calendar/${parsed[1]}`) as any;
        spinner.stop();
        if (result?.error) { console.log(chalk.red(`  Error: ${result.error}`)); }
        else { console.log(chalk.green(`  Event ${parsed[1]} deleted.`)); }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'sync') {
      const spinner = ora('Syncing calendar (CalDAV)...').start();
      try {
        const result = await client.get('/calendar/sync') as any;
        spinner.stop();
        console.log(chalk.green(`  Synced: ${result?.synced || result?.count || 0} events updated.`));
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else {
      console.log(chalk.dim('  Usage: /calendar [list|create "<title>" --start <ISO> [--end <ISO>]|delete <id>|sync]'));
    }
  },
};
COMMANDS['cal'] = COMMANDS['calendar'];

COMMANDS['mail'] = {
  description: 'Manage email inbox and sending',
  usage: '/mail [inbox|send "<subject>" --body "<text>" [--priority high]|threads|read <thread_id>]',
  handler: async (client: GenesisClient, args: string) => {
    const parsed = parseQuotedArgs(args.trim());
    const sub = (parsed[0] || 'inbox').toLowerCase();
    if (sub === 'inbox') {
      const spinner = ora('Loading inbox...').start();
      try {
        const result = await client.get('/mail/inbox/admin') as any;
        spinner.stop();
        const messages = result?.messages || result?.emails || result?.items || [];
        if (!messages.length) { console.log(chalk.dim('  Inbox empty.')); return; }
        console.log();
        for (const m of messages.slice(0, 20)) {
          const from = m.from || m.sender || '';
          const subject = m.subject || m.title || '';
          const date = m.date || m.received_at || '';
          const unread = m.unread ? chalk.cyan('●') : ' ';
          console.log(`  ${unread} ${chalk.dim(date.slice(0, 16))}  ${chalk.bold(subject)}  ${chalk.dim(from)}`);
        }
        console.log();
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'send') {
      const subject = parsed[1];
      if (!subject) { console.log(chalk.dim('  Usage: /mail send "<subject>" --body "<text>" [--priority high]')); return; }
      const flagStr = parsed.slice(2).join(' ');
      const bodyMatch = flagStr.match(/--body\s+"([^"]+)"|--body\s+(\S+)/);
      const priorityMatch = flagStr.match(/--priority\s+(\S+)/);
      if (!bodyMatch) { console.log(chalk.red('  --body "<text>" required.')); return; }
      const spinner = ora('Sending mail...').start();
      try {
        const body: any = { subject, body: bodyMatch[1] || bodyMatch[2] };
        if (priorityMatch) body.priority = priorityMatch[1];
        const result = await client.post('/mail/send', body) as any;
        spinner.stop();
        if (result?.error) { console.log(chalk.red(`  Error: ${result.error}`)); }
        else { console.log(chalk.green(`  Mail sent: ${result?.message_id || 'OK'}`)); }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'threads') {
      const spinner = ora('Loading threads...').start();
      try {
        const result = await client.get('/mail/threads') as any;
        spinner.stop();
        const threads = result?.threads || result?.items || [];
        if (!threads.length) { console.log(chalk.dim('  No threads.')); return; }
        console.log();
        for (const t of threads.slice(0, 15)) {
          const count = t.message_count || t.count || '';
          const subject = t.subject || t.title || '';
          console.log(`  ${chalk.cyan(t.id?.slice(0, 8) || '')}  ${chalk.bold(subject)}  ${chalk.dim(`(${count} msgs)`)}`);
        }
        console.log();
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'read' && parsed[1]) {
      const spinner = ora('Loading thread...').start();
      try {
        const result = await client.get(`/mail/threads/${parsed[1]}`) as any;
        spinner.stop();
        const messages = result?.messages || [result];
        console.log();
        for (const m of messages) {
          console.log(chalk.bold(`  From: ${m.from || m.sender || '?'}  ${chalk.dim(m.date || '')}`));
          console.log(`  ${m.body || m.text || m.content || '(empty)'}`);
          console.log();
        }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else {
      console.log(chalk.dim('  Usage: /mail [inbox|send "<subject>" --body "<text>"|threads|read <thread_id>]'));
    }
  },
};
COMMANDS['email'] = COMMANDS['mail'];

COMMANDS['will'] = {
  description: 'Manage Will policies (autonomous behavior directives)',
  usage: '/will [active|list|activate <id>|policy]',
  handler: async (client: GenesisClient, args: string) => {
    const parts = args.trim().split(/\s+/);
    const sub = (parts[0] || 'active').toLowerCase();
    if (sub === 'active') {
      const spinner = ora('Loading active will...').start();
      try {
        const result = await client.get('/will/active') as any;
        spinner.stop();
        if (!result) { console.log(chalk.dim('  No active will policy.')); return; }
        console.log();
        console.log(`  ${chalk.bold('Active Will:')} ${result.name || result.id || '?'}`);
        if (result.description) console.log(`  ${chalk.dim(result.description)}`);
        if (result.directives) {
          console.log(chalk.dim('\n  Directives:'));
          const dirs = Array.isArray(result.directives) ? result.directives : [result.directives];
          for (const d of dirs.slice(0, 10)) {
            console.log(`    ${chalk.cyan('→')} ${typeof d === 'string' ? d : d.text || d.name || JSON.stringify(d)}`);
          }
        }
        console.log();
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'list') {
      const spinner = ora('Loading wills...').start();
      try {
        const result = await client.get('/will/list') as any;
        spinner.stop();
        const wills = result?.wills || result?.items || result?.policies || [];
        if (!wills.length) { console.log(chalk.dim('  No will policies found.')); return; }
        console.log();
        for (const w of wills) {
          const active = w.active ? chalk.green('●') : chalk.dim('○');
          console.log(`  ${active}  ${chalk.bold(w.name || w.id)}  ${chalk.dim(w.description || '')}`);
        }
        console.log();
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'activate' && parts[1]) {
      const spinner = ora(`Activating will "${parts[1]}"...`).start();
      try {
        const result = await client.post('/will/activate', { id: parts[1] }) as any;
        spinner.stop();
        if (result?.error) { console.log(chalk.red(`  Error: ${result.error}`)); }
        else { console.log(chalk.green(`  Will "${parts[1]}" activated.`)); }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'policy') {
      const spinner = ora('Loading full policy...').start();
      try {
        const result = await client.get('/user/persona/will') as any;
        spinner.stop();
        if (!result) { console.log(chalk.dim('  No policy data.')); return; }
        console.log(); console.log(JSON.stringify(result, null, 2)); console.log();
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else {
      console.log(chalk.dim('  Usage: /will [active|list|activate <id>|policy]'));
    }
  },
};

COMMANDS['escalate'] = {
  description: 'Manage escalation proposals and config',
  usage: '/escalate [list|config|approve <id>|deny <id> [reason]|set <key> <value>]',
  handler: async (client: GenesisClient, args: string) => {
    const parts = args.trim().split(/\s+/);
    const sub = (parts[0] || 'list').toLowerCase();
    if (sub === 'list') {
      const spinner = ora('Loading escalation proposals...').start();
      try {
        const result = await client.get('/reasoning/escalation/proposals') as any;
        spinner.stop();
        const proposals = result?.proposals || result?.items || [];
        if (!proposals.length) { console.log(chalk.dim('  No pending escalation proposals.')); return; }
        console.log();
        for (const p of proposals) {
          const status = p.status === 'pending' ? chalk.yellow('pending') : p.status === 'approved' ? chalk.green('approved') : chalk.dim(p.status);
          console.log(`  ${status}  ${chalk.bold(p.title || p.reason || p.id)}  ${chalk.dim(p.id?.slice(0, 8) || '')}`);
          if (p.description) console.log(`         ${chalk.dim(p.description.slice(0, 80))}`);
        }
        console.log();
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'config') {
      const spinner = ora('Loading escalation config...').start();
      try {
        const result = await client.get('/reasoning/escalation/config') as any;
        spinner.stop();
        if (!result) { console.log(chalk.dim('  No escalation config found.')); return; }
        console.log(); console.log(JSON.stringify(result, null, 2)); console.log();
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'approve' && parts[1]) {
      const spinner = ora('Approving proposal...').start();
      try {
        const result = await client.put(`/reasoning/escalation/proposals/${parts[1]}`, { action: 'approve' }) as any;
        spinner.stop();
        if (result?.error) { console.log(chalk.red(`  Error: ${result.error}`)); }
        else { console.log(chalk.green(`  Proposal ${parts[1]} approved.`)); }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'deny' && parts[1]) {
      const reason = parts.slice(2).join(' ') || undefined;
      const spinner = ora('Denying proposal...').start();
      try {
        const body: any = { action: 'deny' };
        if (reason) body.reason = reason;
        const result = await client.put(`/reasoning/escalation/proposals/${parts[1]}`, body) as any;
        spinner.stop();
        if (result?.error) { console.log(chalk.red(`  Error: ${result.error}`)); }
        else { console.log(chalk.yellow(`  Proposal ${parts[1]} denied.`)); }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'set' && parts[1] && parts[2]) {
      const key = parts[1];
      const value = parts.slice(2).join(' ');
      const spinner = ora(`Setting ${key}...`).start();
      try {
        const result = await client.put('/reasoning/escalation/config', { [key]: value }) as any;
        spinner.stop();
        if (result?.error) { console.log(chalk.red(`  Error: ${result.error}`)); }
        else { console.log(chalk.green(`  Config updated: ${key} = ${value}`)); }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else {
      console.log(chalk.dim('  Usage: /escalate [list|config|approve <id>|deny <id> [reason]|set <key> <value>]'));
    }
  },
};

COMMANDS['research'] = {
  description: 'Launch a research task via Lyra (Forge dispatch)',
  usage: '/research "<topic>" [--depth quick|deep] [--report]',
  handler: async (client: GenesisClient, args: string) => {
    const parsed = parseQuotedArgs(args.trim());
    if (!parsed[0]) { console.log(chalk.dim('  Usage: /research "<topic>" [--depth quick|deep] [--report]')); return; }
    const topic = parsed[0];
    const flagStr = parsed.slice(1).join(' ');
    const depthMatch = flagStr.match(/--depth\s+(quick|deep)/);
    const wantReport = flagStr.includes('--report');
    const depth = depthMatch?.[1] || 'deep';
    const effort = depth === 'quick' ? 5 : 8;

    const taskDesc = wantReport
      ? `Research the following topic and produce a structured report with citations: ${topic}`
      : `Research the following topic thoroughly: ${topic}`;

    console.log(chalk.dim(`  Dispatching to Lyra (effort ${effort}, depth: ${depth})...\n`));
    const spinner = ora('Researching...').start();
    try {
      const result = await client.forgeDispatch(taskDesc, { agent: 'lyra', effort }) as any;
      spinner.stop();
      const answer = result?.result || result?.response || result?.answer || result?.output || '';
      if (answer) {
        console.log(); console.log(answer); console.log();
      } else if (result?.job_id) {
        console.log(chalk.green(`  Research job started: ${result.job_id}`));
        console.log(chalk.dim(`  Check status: /jobs`));
      } else {
        console.log(chalk.dim('  No result returned.')); console.log(chalk.dim(`  Raw: ${JSON.stringify(result).slice(0, 200)}`));
      }
    } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
  },
};

COMMANDS['publish'] = {
  description: 'Publish content via Vera (blog, social)',
  usage: '/publish [blog "<topic>"|social "<message>"|status]',
  handler: async (client: GenesisClient, args: string) => {
    const parsed = parseQuotedArgs(args.trim());
    const sub = (parsed[0] || '').toLowerCase();
    if (sub === 'blog' && parsed[1]) {
      const topic = parsed.slice(1).join(' ');
      console.log(chalk.dim(`  Dispatching blog generation to Vera...\n`));
      const spinner = ora('Writing blog post...').start();
      try {
        const result = await client.forgeDispatch(
          `Write a blog post about: ${topic}. Format as markdown with title, introduction, body sections, and conclusion.`,
          { agent: 'vera', effort: 7 },
        ) as any;
        spinner.stop();
        const answer = result?.result || result?.response || result?.output || '';
        if (answer) { console.log(); console.log(answer); console.log(); }
        else if (result?.job_id) {
          console.log(chalk.green(`  Blog job started: ${result.job_id}`));
        } else { console.log(chalk.dim('  No result returned.')); }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'social' && parsed[1]) {
      const message = parsed.slice(1).join(' ');
      console.log(chalk.dim(`  Dispatching social post to Vera...\n`));
      const spinner = ora('Crafting social post...').start();
      try {
        const result = await client.forgeDispatch(
          `Compose a social media post: ${message}. Make it engaging and concise.`,
          { agent: 'vera', effort: 4 },
        ) as any;
        spinner.stop();
        const answer = result?.result || result?.response || result?.output || '';
        if (answer) { console.log(); console.log(answer); console.log(); }
        else { console.log(chalk.dim('  No result returned.')); }
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else if (sub === 'status') {
      const spinner = ora('Loading content status...').start();
      try {
        const result = await client.get('/content/decks') as any;
        spinner.stop();
        const decks = result?.decks || result?.items || [];
        if (!decks.length) { console.log(chalk.dim('  No content decks found.')); return; }
        console.log();
        for (const d of decks.slice(0, 15)) {
          const status = d.status === 'published' ? chalk.green('published') : d.status === 'draft' ? chalk.yellow('draft') : chalk.dim(d.status || '');
          console.log(`  ${status}  ${chalk.bold(d.title || d.name || d.id)}`);
        }
        console.log();
      } catch (e: any) { spinner.stop(); console.log(chalk.red(`  Error: ${e.message}`)); }
    } else {
      console.log(chalk.dim('  Usage: /publish [blog "<topic>"|social "<message>"|status]'));
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Lockbox — private prompt management via Strata
// ═══════════════════════════════════════════════════════════════════════════════

COMMANDS['lockbox'] = {
  description: 'Manage private prompts stored in Strata lockbox',
  usage: '/lockbox [list | add <name> <content> | add-file <name> <path> | remove <id> | sync]',
  handler: async (client: GenesisClient, args: string) => {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] || 'list';

    if (sub === 'list' || sub === 'ls') {
      const spinner = ora('Loading lockbox prompts...').start();
      try {
        const data = await client.get('/safety/config/lockbox/prompts') as any;
        spinner.stop();
        if (!data?.success) {
          console.log(chalk.red(`  Error: ${data?.detail || 'Unknown error'}`));
          return;
        }
        const prompts = data.prompts || [];
        if (prompts.length === 0) {
          console.log(chalk.dim('  No prompts in lockbox.'));
          console.log(chalk.dim('  Add one: /lockbox add <name> "<content>"'));
          return;
        }
        console.log(chalk.bold(`\n  Lockbox Prompts (${prompts.length})\n`));
        for (const p of prompts) {
          const cat = chalk.dim(`[${p.category || 'system'}]`);
          const access = p.access_level === 'owner' ? chalk.red('owner') : p.access_level === 'admin' ? chalk.yellow('admin') : chalk.green('std');
          const hasContent = p.has_content ? chalk.green('●') : chalk.dim('○');
          console.log(`  ${hasContent} ${cat} ${chalk.cyan(p.id || p.name)} ${access}`);
          if (p.description) console.log(chalk.dim(`      ${p.description}`));
        }
        console.log();
      } catch (e: any) {
        spinner.stop();
        console.log(chalk.red(`  Error: ${e.message}`));
      }
    } else if (sub === 'add') {
      const name = parts[1];
      if (!name) {
        console.log(chalk.yellow('  Usage: /lockbox add <name> "<content>" [--category <cat>] [--access <level>]'));
        return;
      }
      // Parse content (everything after name, possibly quoted)
      const afterName = args.slice(args.indexOf(name) + name.length).trim();
      let content = '';
      let category = 'system';
      let accessLevel = 'standard';

      // Check for flags
      const flagIdx = afterName.indexOf('--');
      if (flagIdx > 0) {
        content = afterName.slice(0, flagIdx).trim();
        const flagStr = afterName.slice(flagIdx);
        const catMatch = flagStr.match(/--category\s+(\S+)/);
        if (catMatch) category = catMatch[1];
        const accMatch = flagStr.match(/--access\s+(\S+)/);
        if (accMatch) accessLevel = accMatch[1];
      } else {
        content = afterName;
      }

      // Strip surrounding quotes
      if ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'"))) {
        content = content.slice(1, -1);
      }

      if (!content) {
        console.log(chalk.yellow('  No content provided.'));
        return;
      }

      const spinner = ora('Storing prompt...').start();
      try {
        const data = await client.post('/safety/config/lockbox/prompts', {
          name, content, category, access_level: accessLevel, description: '', tags: [],
        }) as any;
        spinner.stop();
        if (data?.success) {
          console.log(chalk.green(`  ✓ Stored: ${chalk.bold(data.prompt_id)}`));
        } else {
          console.log(chalk.red(`  Error: ${data?.detail || 'Failed to store'}`));
        }
      } catch (e: any) {
        spinner.stop();
        console.log(chalk.red(`  Error: ${e.message}`));
      }
    } else if (sub === 'add-file') {
      const name = parts[1];
      const filePath = parts[2];
      if (!name || !filePath) {
        console.log(chalk.yellow('  Usage: /lockbox add-file <name> <path> [--category <cat>]'));
        return;
      }
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        console.log(chalk.red(`  File not found: ${resolved}`));
        return;
      }
      const content = readFileSync(resolved, 'utf-8');
      let category = 'system';
      const catMatch = args.match(/--category\s+(\S+)/);
      if (catMatch) category = catMatch[1];

      const spinner = ora('Storing prompt from file...').start();
      try {
        const data = await client.post('/safety/config/lockbox/prompts', {
          name, content, category, access_level: 'standard', description: `Imported from ${basename(resolved)}`, tags: [],
        }) as any;
        spinner.stop();
        if (data?.success) {
          console.log(chalk.green(`  ✓ Stored: ${chalk.bold(data.prompt_id)} (${content.length} chars)`));
        } else {
          console.log(chalk.red(`  Error: ${data?.detail || 'Failed to store'}`));
        }
      } catch (e: any) {
        spinner.stop();
        console.log(chalk.red(`  Error: ${e.message}`));
      }
    } else if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      const promptId = parts[1];
      if (!promptId) {
        console.log(chalk.yellow('  Usage: /lockbox remove <prompt_id>'));
        return;
      }
      const spinner = ora('Deleting prompt...').start();
      try {
        const data = await client.delete(`/safety/config/lockbox/prompts/${encodeURIComponent(promptId)}`) as any;
        spinner.stop();
        if (data?.success) {
          console.log(chalk.green(`  ✓ Deleted: ${promptId}`));
        } else {
          console.log(chalk.red(`  Error: ${data?.detail || 'Prompt not found'}`));
        }
      } catch (e: any) {
        spinner.stop();
        console.log(chalk.red(`  Error: ${e.message}`));
      }
    } else if (sub === 'sync' || sub === 'status') {
      const spinner = ora('Checking lockbox sync status...').start();
      try {
        const data = await client.get('/safety/config/lockbox') as any;
        spinner.stop();
        if (!data?.success) {
          console.log(chalk.red(`  Error: ${data?.detail || 'Unknown error'}`));
          return;
        }
        console.log(chalk.bold('\n  Lockbox Status\n'));
        console.log(`  Active:     ${data.active ? chalk.green('yes') : chalk.dim('no')}`);
        console.log(`  Prompts:    ${data.prompt_count}`);
        console.log(`  Categories: ${(data.categories || []).join(', ') || chalk.dim('none')}`);
        console.log(`  Eligible:   ${data.lockbox_eligible ? chalk.green('yes') : chalk.red('no')}`);
        console.log(`  Safety:     ${data.safety_level}`);
        console.log();
      } catch (e: any) {
        spinner.stop();
        console.log(chalk.red(`  Error: ${e.message}`));
      }
    } else {
      console.log(chalk.dim('  Usage: /lockbox [list | add <name> "<content>" | add-file <name> <path> | remove <id> | sync]'));
    }
  },
};

// ─── Agent Platform Commands ────────────────────────────────────────

COMMANDS['notebook'] = {
    description: 'Create, run, or list agent notebooks',
    usage: '/notebook [list|create <name>|run <id>]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || 'list';
      const spinner = ora('').start();

      if (sub === 'list') {
        spinner.text = 'Fetching notebooks...';
        const result = await client.get('/notebooks');
        spinner.stop();
        const notebooks = result?.notebooks || [];
        if (!notebooks.length) { console.log(chalk.dim('  No notebooks.')); return; }
        console.log(chalk.bold('\n  Notebooks\n'));
        for (const nb of notebooks) {
          const status = nb.status === 'completed' ? chalk.green(nb.status) : nb.status === 'running' ? chalk.yellow(nb.status) : chalk.dim(nb.status);
          console.log(`  ${chalk.cyan(nb.id?.slice(0, 12))}  ${nb.name}  ${status}  (${nb.cell_count || 0} cells)`);
        }
        console.log();
      } else if (sub === 'create' && parts[1]) {
        spinner.text = `Creating notebook "${parts[1]}"...`;
        const result = await client.post('/notebooks', { name: parts[1], kernel: parts[2] || 'python', cells: [] });
        spinner.stop();
        console.log(chalk.green(`  Created: ${result?.id || '?'} (${parts[1]})`));
      } else if (sub === 'run' && parts[1]) {
        spinner.text = `Running notebook ${parts[1]}...`;
        const result = await client.post(`/notebooks/${parts[1]}/execute`, { cell_range: 'all' });
        spinner.stop();
        const status = result?.status === 'completed' ? chalk.green(result.status) : chalk.red(result?.status || 'unknown');
        console.log(`  ${status}  cells: ${result?.cells_executed || 0}  duration: ${result?.duration_ms || '?'}ms`);
      } else {
        spinner.stop();
        console.log(chalk.dim('  Usage: /notebook [list | create <name> [kernel] | run <id>]'));
      }
    },
};
COMMANDS['products'] = {
    description: 'Manage standalone product instances',
    usage: '/products [list|catalog|deploy <type>|status <id>|destroy <id>]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || 'list';
      const spinner = ora('').start();

      if (sub === 'list') {
        spinner.text = 'Fetching product instances...';
        const result = await client.get('/products/instances');
        spinner.stop();
        const instances = result?.instances || [];
        if (!instances.length) { console.log(chalk.dim('  No product instances.')); return; }
        console.log(chalk.bold('\n  Product Instances\n'));
        for (const inst of instances) {
          const status = inst.status === 'running' ? chalk.green(inst.status) : chalk.yellow(inst.status);
          const endpoint = Object.values(inst.endpoints || {})[0] || '';
          console.log(`  ${chalk.cyan(inst.instance_id?.slice(0, 12))}  ${chalk.bold(inst.product_type)}  ${status}  ${chalk.dim(String(endpoint))}`);
        }
        console.log();
      } else if (sub === 'catalog') {
        spinner.text = 'Fetching catalog...';
        const result = await client.get('/products/catalog');
        spinner.stop();
        const products = result?.products || {};
        console.log(chalk.bold('\n  Product Catalog\n'));
        for (const [name, info] of Object.entries(products) as any[]) {
          console.log(`  ${chalk.cyan(name)}  ${info.description || ''}`);
        }
        console.log();
      } else if (sub === 'deploy' && parts[1]) {
        spinner.text = `Deploying ${parts[1]}...`;
        const result = await client.post('/products/provision', {
          product_type: parts[1],
          tenant_id: parts[2] || 'default',
          plan: 'free',
          deploy_target: 'local',
        });
        spinner.stop();
        const status = result?.status === 'running' ? chalk.green(result.status) : chalk.yellow(result?.status || '?');
        console.log(`  ${status}  instance: ${result?.instance_id || '?'}`);
      } else if (sub === 'status' && parts[1]) {
        spinner.text = `Checking ${parts[1]}...`;
        const result = await client.get(`/products/${parts[1]}`);
        spinner.stop();
        console.log(`  ${chalk.bold(result?.product_type || '?')}  status: ${result?.status}  version: ${result?.version}`);
      } else if (sub === 'destroy' && parts[1]) {
        spinner.text = `Destroying ${parts[1]}...`;
        await client.delete(`/products/${parts[1]}`);
        spinner.stop();
        console.log(chalk.red(`  Destroyed ${parts[1]}`));
      } else {
        spinner.stop();
        console.log(chalk.dim('  Usage: /products [list | catalog | deploy <type> [tenant] | status <id> | destroy <id>]'));
      }
    },
};

COMMANDS['tool-scope'] = {
    description: 'View or modify workspace tool scoping',
    usage: '/tool-scope [show|allow <tool>|deny <tool>]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || 'show';
      const spinner = ora('').start();

      if (sub === 'show') {
        spinner.text = 'Fetching tool scoping...';
        const result = await client.get('/workspace/tools/scoping');
        spinner.stop();
        const config = result?.config || {};
        const allow = config.tool_allowlist || [];
        const deny = config.tool_denylist || [];
        console.log(chalk.bold('\n  Tool Scoping\n'));
        console.log(`  Allowed: ${allow.length ? allow.join(', ') : chalk.dim('(all)')}`);
        console.log(`  Denied:  ${deny.length ? chalk.red(deny.join(', ')) : chalk.dim('(none)')}`);
        console.log();
      } else if ((sub === 'allow' || sub === 'deny') && parts[1]) {
        spinner.text = `${sub === 'allow' ? 'Allowing' : 'Denying'} ${parts[1]}...`;
        await client.post('/workspace/tools/scoping/update', { action: sub, tool_name: parts[1] });
        spinner.stop();
        console.log(chalk.green(`  ${sub === 'allow' ? 'Allowed' : 'Denied'}: ${parts[1]}`));
      } else {
        spinner.stop();
        console.log(chalk.dim('  Usage: /tool-scope [show | allow <tool_name> | deny <tool_name>]'));
      }
    },
};

COMMANDS['compose'] = {
    description: 'Compose a new custom agent interactively',
    usage: '/compose <name> [--template <base>]',
    handler: async (client: GenesisClient, args: string) => {
      const parts = args.trim().split(/\s+/);
      if (!parts[0]) {
        console.log(chalk.dim('  Usage: /compose <agent_name> [--template <base_agent>]'));
        console.log(chalk.dim('  For full visual builder: http://localhost:3000/workspace/agents/compose'));
        return;
      }
      const name = parts[0];
      const templateIdx = parts.indexOf('--template');
      const template = templateIdx >= 0 ? parts[templateIdx + 1] || '' : '';
      const spinner = ora(`Composing agent "${name}"...`).start();
      const result = await client.post('/agents/compose', {
        name,
        identity_template: template,
        deploy_target: 'genesis',
        reasoning_mode: 'auto',
        model: 'auto',
        effort_cap: 6,
        tools: [],
        capabilities: [],
      });
      spinner.stop();
      if (result?.error) {
        console.log(chalk.red(`  Error: ${result.error}`));
      } else {
        console.log(chalk.green(`  Agent "${name}" created`));
        console.log(chalk.dim(`  Full config: http://localhost:3000/workspace/agents/compose`));
      }
    },
};

COMMANDS['monitor'] = {
    description: 'Show real-time agent performance metrics',
    usage: '/monitor [agent_name]',
    handler: async (client: GenesisClient, args: string) => {
      const agent = args.trim();
      const spinner = ora('Fetching agent metrics...').start();
      const result = await client.get('/agents/metrics');
      spinner.stop();
      const metrics = result?.agents || result?.metrics || [];
      if (!metrics.length) { console.log(chalk.dim('  No agent metrics available.')); return; }

      const filtered = agent ? metrics.filter((m: any) => m.name?.toLowerCase().includes(agent.toLowerCase())) : metrics;
      console.log(chalk.bold('\n  Agent Metrics (24h)\n'));
      console.log(chalk.dim('  Name              Requests  Latency   Tokens    Success  Errors'));
      for (const m of filtered.slice(0, 20)) {
        const name = (m.name || m.agent_id || '').padEnd(18).slice(0, 18);
        const reqs = String(m.total_requests || 0).padStart(8);
        const lat = `${m.avg_latency_ms || 0}ms`.padStart(8);
        const tokens = `${((m.tokens_used_24h || 0) / 1000).toFixed(1)}k`.padStart(9);
        const success = m.success_rate >= 95 ? chalk.green(`${m.success_rate}%`) : m.success_rate >= 80 ? chalk.yellow(`${m.success_rate}%`) : chalk.red(`${m.success_rate}%`);
        const errors = m.errors_24h > 0 ? chalk.red(String(m.errors_24h)) : chalk.dim('0');
        console.log(`  ${name} ${reqs} ${lat} ${tokens}  ${success.padStart(10)}  ${errors}`);
      }
      console.log();
    },
};

// ── Products CLI ─────────────────────────────────────────────────────────
import { productsInit, productsDeploy, productsList } from './products.js';

COMMANDS['products'] = {
  description: 'Product scaffolding and deployment (init, deploy, list)',
  usage: 'products <subcommand> [--flags]\n  products init --name=MyProduct --port=8902 --category=business_agent\n  products deploy --name=myproduct --subdomain=myproduct\n  products list',
  handler: async (client, args, config) => {
    const sub = args.trim().split(/\s+/)[0] || '';
    const rest = args.trim().slice(sub.length).trim();
    switch (sub) {
      case 'init': return productsInit(client, rest, config);
      case 'deploy': return productsDeploy(client, rest, config);
      case 'list': return productsList(client, rest, config);
      default:
        console.log(chalk.dim('Usage: products <init|deploy|list> [--flags]'));
        console.log(chalk.dim('  init   — scaffold a new product'));
        console.log(chalk.dim('  deploy — deploy a product to subdomain'));
        console.log(chalk.dim('  list   — show registered products'));
    }
  },
};

// ── /ingest — Universal ingestion (route to any agent) ───────────────────────
import { handleKbAgentCommand } from './kb-agent.js';

COMMANDS['ingest'] = {
  description: 'Universal ingestion — ingest a URL or file into any agent',
  usage: '/ingest <url-or-file> [--agent NAME] [--workspace ID]',
  handler: async (client: GenesisClient, args: string) => {
    const tokens = args.trim().split(/\s+/);
    let agent = process.env.AWSH_KB_AGENT || 'kb';
    let workspace = '';
    const targets: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '--agent' && tokens[i + 1]) {
        agent = tokens[++i];
      } else if (tokens[i] === '--workspace' && tokens[i + 1]) {
        workspace = tokens[++i];
      } else if (tokens[i]) {
        targets.push(tokens[i]);
      }
    }

    if (targets.length === 0) {
      console.log(chalk.yellow('Usage:') + ' /ingest <url-or-file> [--agent NAME] [--workspace ID]');
      console.log(chalk.dim(`  Agents: ${agent} (default), workspace`));
      return;
    }

    // Route based on agent
    if (agent !== 'workspace') {
      await handleKbAgentCommand(['ingest', ...targets], agent);
    } else if (agent === 'workspace' && workspace) {
      // Route to Genesis workspace ingestion
      const target = targets[0];
      const isUrl = target.startsWith('http://') || target.startsWith('https://');
      const body = isUrl
        ? { urls: [target], paths: [] }
        : { urls: [], paths: [target] };
      try {
        const resp = await client.post(`/workspace/${workspace}/knowledge/ingest`, body);
        console.log(chalk.green('✓') + ` Ingested into workspace ${workspace}`);
        if (resp?.ingested?.length) {
          for (const item of resp.ingested) {
            console.log(chalk.dim(`  ${item.url || item.path}`));
          }
        }
      } catch (e: any) {
        console.error(chalk.red('Error:') + ` ${e.message}`);
      }
    } else {
      // Try generic agent routing via Genesis
      const target = targets[0];
      try {
        const resp = await client.post('/ingest', {
          urls: target.startsWith('http') ? [target] : [],
          texts: [],
          target_agent: agent,
          target_workspace: workspace || undefined,
        });
        console.log(chalk.green('✓') + ` Ingested via ${agent}`);
        if (resp?.results) {
          for (const r of resp.results) {
            console.log(chalk.dim(`  ${r.title || r.url || 'ok'} (${r.chunk_count} chunks)`));
          }
        }
      } catch (e: any) {
        console.error(chalk.red('Error:') + ` ${e.message}`);
      }
    }
  },
};

// ── Sovereign Install (standalone binary entry point) ──────────────────────
COMMANDS['install'] = {
  description: 'Full AitherOS sovereign install — auth, Docker, pull, boot, extensions',
  usage: '/install [--profile chat-minimal|personal] [--with node,connect] [--non-interactive]',
  handler: async (_client, args, config) => {
    const flags = args.split(/\s+/).filter(Boolean);
    let profile = 'chat-minimal';
    let extensions: string[] = [];
    let nonInteractive = false;

    for (let i = 0; i < flags.length; i++) {
      if ((flags[i] === '--profile' || flags[i] === '-p') && flags[i + 1]) { profile = flags[++i]; }
      else if (flags[i] === '--with' && flags[i + 1]) { extensions = flags[++i].split(','); }
      else if (flags[i] === '--non-interactive' || flags[i] === '--yes') { nonInteractive = true; }
    }

    // Auto-resolve "personal" to sub-profile based on GPU
    if (profile === 'personal') {
      try {
        const gpuOut = execSync(
          'nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits',
          { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).toString().trim();
        const vramMb = parseInt(gpuOut.split('\n')[0], 10);
        if (vramMb >= 7500) {
          profile = 'personal-gpu';
          console.log(chalk.cyan(`  GPU detected (${vramMb}MB) -> vLLM AWQ profile`));
        } else if (vramMb >= 5500) {
          profile = 'personal-ollama';
          console.log(chalk.cyan(`  GPU detected (${vramMb}MB) -> Ollama GPU profile`));
        } else {
          profile = 'personal-cpu';
          console.log(chalk.yellow(`  GPU too small (${vramMb}MB) -> CPU profile`));
        }
      } catch {
        profile = 'personal-cpu';
        console.log(chalk.yellow('  No GPU detected -> CPU inference profile'));
      }
    }

    const spinner = ora('Starting AitherOS sovereign install...').start();

    // Step 1: Auth check
    const token = getActiveToken();
    if (!token) {
      spinner.fail('Not logged in. Run: aither login');
      return;
    }
    spinner.succeed('Authenticated');

    // Step 2: Check Docker
    spinner.start('Checking Docker...');
    try {
      execSync('docker info', { stdio: 'pipe' });
      spinner.succeed('Docker available');
    } catch {
      spinner.fail('Docker not found. Install Docker Desktop first: https://docker.com/get-started');
      return;
    }

    // Step 3: Pull profile
    spinner.start(`Pulling images for profile: ${profile}`);
    try {
      execSync(`docker compose -f docker-compose.aitheros.yml --profile ${profile} pull`, {
        stdio: 'pipe', cwd: process.cwd(), timeout: 600_000,
      });
      spinner.succeed(`Pulled images for ${profile}`);
    } catch (e: any) {
      spinner.warn(`Image pull had warnings (continuing): ${e.message?.slice(0, 100)}`);
    }

    // Step 4: Pull extension images
    if (extensions.length > 0) {
      spinner.start(`Pulling extensions: ${extensions.join(', ')}`);
      for (const ext of extensions) {
        try {
          execSync(`docker pull ghcr.io/aitherium/aither-${ext}:latest`, { stdio: 'pipe', timeout: 300_000 });
        } catch {
          console.log(chalk.yellow(`  ⚠ Failed to pull aither-${ext} (will retry on first use)`));
        }
      }
      spinner.succeed(`Extensions pulled: ${extensions.join(', ')}`);
    }

    // Step 5: Boot
    spinner.start('Starting services...');
    try {
      execSync(`docker compose -f docker-compose.aitheros.yml --profile ${profile} up -d`, {
        stdio: 'pipe', cwd: process.cwd(), timeout: 300_000,
      });
      spinner.succeed('Services started');
    } catch (e: any) {
      spinner.fail(`Boot failed: ${e.message?.slice(0, 200)}`);
      return;
    }

    // Step 6: Wait for Genesis health
    spinner.start('Waiting for Genesis...');
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        execSync('curl -sf http://localhost:8001/health', { stdio: 'pipe', timeout: 5000 });
        healthy = true;
        break;
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 3000));
    }
    if (healthy) {
      spinner.succeed('Genesis is healthy');
    } else {
      spinner.warn('Genesis did not become healthy in 90s (services may still be starting)');
    }

    // Step 6b: Pull Nemotron model for Ollama profiles
    if (profile === 'personal-ollama' || profile === 'personal-cpu') {
      spinner.start('Pulling Nemotron-Orchestrator-8B model...');
      const container = profile === 'personal-cpu'
        ? 'aither-ollama-personal-cpu'
        : 'aither-ollama-personal';
      try {
        execSync(
          `docker exec ${container} ollama pull nemotron-orchestrator:8b-q4_K_M`,
          { timeout: 600_000, stdio: 'pipe' }
        );
        spinner.succeed('Model downloaded');
      } catch {
        spinner.warn('Model will download on first use');
      }
    }

    // Step 7: Install extensions via API
    if (extensions.length > 0 && healthy) {
      spinner.start('Installing extensions...');
      for (const ext of extensions) {
        try {
          execSync(`curl -sf -X POST http://localhost:8001/apps/deploy -H "Content-Type: application/json" -d '{"slug":"${ext}"}'`, {
            stdio: 'pipe', timeout: 30000,
          });
          console.log(chalk.green('  ✓') + ` ${ext} installed`);
        } catch {
          console.log(chalk.yellow('  ⚠') + ` ${ext} install deferred (Genesis still warming up)`);
        }
      }
      spinner.succeed('Extensions installed');
    }

    console.log('');
    console.log(chalk.green.bold('✓ AitherOS installed successfully!'));
    console.log('');
    console.log(`  Dashboard:  ${chalk.cyan('http://localhost:3000')}`);
    console.log(`  Genesis:    ${chalk.cyan('http://localhost:8001')}`);
    console.log(`  Profile:    ${chalk.dim(profile)}`);
    if (extensions.length) {
      console.log(`  Extensions: ${chalk.dim(extensions.join(', '))}`);
    }
    if (profile.startsWith('personal')) {
      console.log(`  Feedback:   ${chalk.dim('/feedback in AitherShell')}`);
      console.log(`  Support:    ${chalk.cyan('https://demo.aitherium.com/support')}`);
      console.log(`  Bug Report: ${chalk.dim('/report-bug in AitherShell')}`);
    }
    console.log('');
    console.log(chalk.dim('Run "aither status" to check service health.'));
  },
};

// =============================================================================
// Feedback, Support & Bug Reporting (Personal Agent)
// =============================================================================

COMMANDS['feedback'] = {
  description: 'Submit feedback on your agent experience',
  usage: '/feedback [thumbs-up | thumbs-down | "comment text"]',
  handler: async (client: GenesisClient, args: string, config: ShellConfig) => {
    const token = getActiveToken();
    if (!token) {
      console.log(chalk.red('  Not logged in. Run: /login'));
      return;
    }

    const trimmed = args.trim();
    let rating = 0;
    let comment = '';
    let category = '';

    if (!trimmed) {
      // Interactive mode
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

      console.log(chalk.bold('\n  Submit Feedback\n'));
      const ratingStr = await ask('  Rating (1=bad, 3=ok, 5=great): ');
      rating = Math.max(-1, Math.min(1, Math.round((parseInt(ratingStr, 10) || 3) / 2.5 - 1)));
      comment = await ask('  Comment (optional): ');
      const catStr = await ask('  Category (bug/feature/performance/other): ');
      category = catStr.trim() || 'other';
      rl.close();
    } else if (trimmed === 'thumbs-up' || trimmed === '+1' || trimmed === 'up') {
      rating = 1;
      comment = 'Thumbs up';
    } else if (trimmed === 'thumbs-down' || trimmed === '-1' || trimmed === 'down') {
      rating = -1;
      comment = 'Thumbs down';
    } else {
      comment = trimmed;
    }

    try {
      const resp = await client.post('/feedback', {
        rating,
        comment,
        category,
        metadata: { source: 'aithershell', plan: 'personal' },
      }) as any;
      const fid = resp?.feedback_id || 'submitted';
      console.log(chalk.green(`  Feedback received (${fid}). Thank you!`));
    } catch (err: any) {
      console.log(chalk.red(`  Failed to submit feedback: ${err.message || err}`));
      console.log(chalk.dim('  You can also submit at: https://demo.aitherium.com/support'));
    }
  },
};

COMMANDS['support'] = {
  description: 'Open support page or show support options',
  usage: '/support [docs | contact | status]',
  handler: async (_client: GenesisClient, args: string) => {
    const sub = args.trim().toLowerCase() || '';
    const urls: Record<string, { url: string; label: string }> = {
      '':        { url: 'https://demo.aitherium.com/support',  label: 'Support Portal' },
      docs:      { url: 'https://docs.aitherium.com',          label: 'Documentation' },
      contact:   { url: 'https://demo.aitherium.com/support',  label: 'Contact Support' },
      status:    { url: 'https://status.aitherium.com',        label: 'System Status' },
      community: { url: 'https://github.com/Aitherium/awdk/discussions', label: 'Community' },
    };

    const entry = urls[sub];
    if (!entry) {
      console.log(chalk.red(`  Unknown option: ${sub}`));
      console.log(chalk.dim('  Options: docs, contact, status, community'));
      return;
    }

    console.log(chalk.bold(`\n  Opening ${entry.label}...`));
    console.log(chalk.cyan(`  ${entry.url}\n`));

    try {
      const platform = process.platform;
      const cmd = platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';
      // Use start "" "url" on Windows to handle URLs with special chars
      const shellCmd = platform === 'win32' ? `start "" "${entry.url}"` : `${cmd} "${entry.url}"`;
      execSync(shellCmd, { stdio: 'ignore' });
    } catch {
      console.log(chalk.dim('  Could not open browser. Visit the URL above manually.'));
    }
  },
};

COMMANDS['report-bug'] = {
  description: 'Report a bug with structured details',
  usage: '/report-bug [--title "..."] [--severity low|medium|high]',
  handler: async (client: GenesisClient, args: string) => {
    const token = getActiveToken();
    if (!token) {
      console.log(chalk.red('  Not logged in. Run: /login'));
      return;
    }

    let title = '';
    let description = '';
    let severity = 'medium';

    const trimmed = args.trim();
    if (!trimmed) {
      // Interactive mode
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

      console.log(chalk.bold('\n  Report a Bug\n'));
      title = await ask('  Bug title: ');
      if (!title.trim()) { console.log(chalk.red('  Title is required.')); rl.close(); return; }
      description = await ask('  Description: ');
      const sevStr = await ask('  Severity (low/medium/high) [medium]: ');
      severity = ['low', 'medium', 'high'].includes(sevStr.trim()) ? sevStr.trim() : 'medium';
      rl.close();
    } else {
      // Parse flags: --title "..." --severity low
      const titleMatch = trimmed.match(/--title\s+"([^"]+)"/);
      const sevMatch = trimmed.match(/--severity\s+(\w+)/);
      title = titleMatch?.[1] || trimmed.replace(/--\w+\s+"[^"]*"/g, '').replace(/--\w+\s+\w+/g, '').trim();
      severity = sevMatch?.[1] || 'medium';
    }

    try {
      const resp = await client.post('/feedback', {
        rating: -1,
        comment: `[BUG] ${title}\n\n${description}`,
        category: 'Bug',
        metadata: {
          source: 'aithershell',
          plan: 'personal',
          severity,
          type: 'bug_report',
        },
      }) as any;
      const fid = resp?.feedback_id || 'submitted';
      console.log(chalk.green(`\n  Bug report submitted (${fid}).`));
      console.log(chalk.dim('  Our team will review this. Track progress at:'));
      console.log(chalk.cyan('  https://demo.aitherium.com/support\n'));
    } catch (err: any) {
      console.log(chalk.red(`  Failed to submit: ${err.message || err}`));
      console.log(chalk.dim('  Submit directly at: https://demo.aitherium.com/support'));
    }
  },
};

// ── /persona command ──
COMMANDS['persona'] = {
  description: 'Control the Persona desktop VRM avatar overlay',
  usage: '/persona [status|start|show|hide|toggle|list|anim <name>|anims|agent <name>|agents|export|<character>]',
  handler: async (_client: GenesisClient, args: string) => {
    const sub = args.trim().toLowerCase();

    if (!sub || sub === 'status') {
      // Show Persona status and available characters
      const spinner = ora('Checking Persona status...').start();
      try {
        const status = await getPersonaStatus();
        spinner.stop();

        if (!status.running) {
          console.log(chalk.yellow('\n  Persona is not running.\n'));
          console.log(chalk.dim('  Start it with: /persona start'));
          console.log('');
          return;
        }

        console.log(chalk.bold('\n  Persona Status\n'));
        console.log(chalk.green('  ✓ Running'));
        if (status.characters && status.characters.length > 0) {
          console.log(chalk.bold('\n  Available Characters:\n'));
          for (const char of status.characters) {
            console.log(`  ${chalk.cyan('•')} ${char}`);
          }
          console.log();
          console.log(chalk.dim(`  Switch: /persona <name>  ·  Show: /persona show  ·  Hide: /persona hide`));
        }
        console.log('');
      } catch (err: any) {
        spinner.fail('Failed to check status');
        console.log(chalk.red(`  ${err?.message || err}\n`));
      }
      return;
    }

    if (sub === 'start') {
      // Start Persona if it's not running
      const spinner = ora('Checking Persona...').start();
      const healthy = await personaHealthy();
      if (healthy) {
        spinner.succeed('Persona is already running');
        return;
      }

      spinner.text = 'Starting Persona...';
      const personaStart = process.env.PERSONA_START_CMD || 'D:\\persona\\persona-start.cmd';
      try {
        // Spawn detached so it runs independently
        spawn('cmd', ['/c', personaStart], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref();

        // POLL, don't peek once. Persona is an Electron app cold-loading a VRM
        // model; measured 2026-08-24 it binds :47831 well after the old fixed
        // 1.5s wait, so this path warned "health check failed" on every cold
        // start that actually succeeded — and the user's next /persona worked,
        // making the warning read as flaky rather than as impatient.
        const deadline = Date.now() + 30_000;
        let nowHealthy = false;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1000));
          nowHealthy = await personaHealthy();
          if (nowHealthy) break;
          const waited = Math.round((Date.now() - (deadline - 30_000)) / 1000);
          spinner.text = `Starting Persona... (${waited}s)`;
        }
        if (nowHealthy) {
          spinner.succeed('Persona started');
        } else {
          spinner.warn('Persona did not answer /health within 30s — check D:\\persona\\electron-launch.log');
        }
      } catch (err: any) {
        spinner.fail('Failed to start Persona');
        console.log(chalk.red(`  ${err?.message || err}`));
        console.log(chalk.dim(`  Ensure D:\\persona\\persona-start.cmd exists`));
      }
      return;
    }

    if (sub === 'show' || sub === 'hide' || sub === 'toggle') {
      const spinner = ora(`${sub === 'toggle' ? 'Toggling' : sub === 'show' ? 'Showing' : 'Hiding'} Persona window...`).start();
      try {
        await personaWindowAction(sub as 'show' | 'hide' | 'toggle');
        spinner.succeed(`Persona window ${sub === 'hide' ? 'hidden' : sub === 'show' ? 'visible' : 'toggled'}`);
      } catch (err: any) {
        spinner.fail(`Failed to ${sub} window`);
        console.log(chalk.red(`  ${err?.message || err}`));
      }
      return;
    }

    if (sub === 'list' || sub === 'ls') {
      const spinner = ora('Reading character roster...').start();
      try {
        const status = await getPersonaStatus();
        spinner.stop();
        const chars = status.characters ?? [];
        if (!chars.length) {
          console.log(chalk.yellow(`\n  No characters reported${status.error ? ` — ${status.error}` : ''}.\n`));
          return;
        }
        console.log(chalk.bold(`\n  ${chars.length} character${chars.length === 1 ? '' : 's'}\n`));
        for (const c of chars) {
          console.log(c === status.active ? chalk.green(`  ● ${c}`) : `  ${chalk.dim('○')} ${c}`);
        }
        console.log(chalk.dim('\n  Switch with /persona <name>\n'));
      } catch (err: any) {
        spinner.fail('Failed to list characters');
        console.log(chalk.red(`  ${err?.message || err}\n`));
      }
      return;
    }

    if (sub === 'anims' || sub === 'animations') {
      const spinner = ora('Reading installed animations...').start();
      try {
        const anims = await listPersonaAnimations();
        spinner.stop();
        console.log(chalk.bold(`\n  ${anims.length} animation${anims.length === 1 ? '' : 's'}\n`));
        for (const a of anims) {
          console.log(a.startsWith('FILE:') ? `  ${chalk.magenta('◆')} ${a}` : `  ${chalk.cyan('•')} ${a}`);
        }
        console.log(chalk.dim('\n  Play one with /persona anim <name>\n'));
      } catch (err: any) {
        spinner.fail('Failed to list animations');
        console.log(chalk.red(`  ${err?.message || err}\n`));
      }
      return;
    }

    if (sub.startsWith('anim ') || sub === 'anim') {
      const name = args.trim().slice(4).trim();   // slice off "anim", keep the ORIGINAL case
      if (!name) {
        console.log(chalk.yellow('\n  Usage: /persona anim <name>   ·   /persona anims to list\n'));
        return;
      }
      const spinner = ora(`Playing ${name}...`).start();
      try {
        const played = await playPersonaAnimation(name);
        spinner.succeed(`Played ${chalk.cyan(played)}`);
      } catch (err: any) {
        spinner.fail('Animation not played');
        console.log(chalk.red(`  ${err?.message || err}\n`));
      }
      return;
    }

    if (sub === 'agents') {
      const spinner = ora('Reading agent avatar assignments...').start();
      try {
        const map = await listPersonaAgentAvatars();
        spinner.stop();
        const entries = Object.entries(map);
        if (!entries.length) {
          console.log(chalk.yellow('\n  No agent has an avatar assigned yet.'));
          console.log(chalk.dim('  Assign one in Persona: Characters > Agents.\n'));
          return;
        }
        console.log(chalk.bold('\n  Agent avatars\n'));
        for (const [agent, character] of entries) {
          console.log(`  ${chalk.cyan(agent.padEnd(12))} ${character}`);
        }
        console.log(chalk.dim('\n  Show one with /persona agent <name>\n'));
      } catch (err: any) {
        spinner.fail('Failed to read assignments');
        console.log(chalk.red(`  ${err?.message || err}\n`));
      }
      return;
    }

    if (sub.startsWith('agent ') || sub === 'agent') {
      const name = args.trim().slice(5).trim();
      if (!name) {
        console.log(chalk.yellow('\n  Usage: /persona agent <name>   ·   /persona agents to list\n'));
        return;
      }
      const spinner = ora(`Showing ${name}'s avatar...`).start();
      try {
        const character = await setPersonaAgent(name);
        if (character) spinner.succeed(`Persona is showing ${chalk.cyan(name)} (${character})`);
        else {
          // NOT an error — the agent simply has no assignment, and saying "failed" would
          // send the user looking for a broken feature instead of an empty setting.
          spinner.warn(`No avatar assigned to ${name}`);
          console.log(chalk.dim('  Assign one in Persona: Characters > Agents.\n'));
        }
      } catch (err: any) {
        spinner.fail('Failed to switch avatar');
        console.log(chalk.red(`  ${err?.message || err}\n`));
      }
      return;
    }

    if (sub === 'export') {
      const spinner = ora('Rendering this character into AitherShell portrait frames...').start();
      try {
        const result = await exportPersonaToShell();
        spinner.succeed('Exported to AitherShell');
        const idle = result.idleFrames ?? result.frames;
        const talk = result.talkFrames;
        if (idle != null) console.log(chalk.dim(`  idle frames: ${idle}`));
        if (talk != null) console.log(chalk.dim(`  talk frames: ${talk}`));
        if (result.dir) console.log(chalk.dim(`  written to: ${result.dir}`));
        console.log(chalk.dim('\n  Dock it with /avatar <name>\n'));
      } catch (err: any) {
        spinner.fail('Export failed');
        console.log(chalk.red(`  ${err?.message || err}\n`));
      }
      return;
    }

    // Otherwise, treat it as a character name to switch to
    const charName = sub;
    const spinner = ora(`Switching to character: ${charName}...`).start();
    try {
      await setPersonaCharacter(charName);
      spinner.succeed(`Switched to ${chalk.cyan(charName)}`);
    } catch (err: any) {
      spinner.fail('Failed to switch character');
      console.log(chalk.red(`  ${err?.message || err}`));
      console.log(chalk.dim(`  Run /persona status to see available characters`));
    }
  },
};

// ── Workspace/Project Management ──

COMMANDS['cd'] = {
  description: 'Change working directory (set project path)',
  usage: '/cd [path]   — switch to a directory and load its context files (interactive picker if no path given)',
  handler: async (_client: GenesisClient, args: string, _config: ShellConfig) => {
    const path = args.trim();
    if (!path) {
      // Show interactive directory picker
      const selected = await pickDirectory();
      if (selected) {
        switchProject(selected);
      }
      return;
    }
    switchProject(path);
  },
};

COMMANDS['workspace'] = {
  description: 'Manage workspaces and project contexts',
  usage: `/workspace list · /workspace pick · /workspace add <name> <path> · /workspace switch <name> · /workspace remove <name> · /workspace info`,
  handler: async (_client: GenesisClient, args: string, _config: ShellConfig) => {
    const [sub, ...rest] = args.trim().split(/\s+/);

    if (!sub || sub === 'list') {
      listProjects();
      return;
    }

    if (sub === 'pick') {
      // Interactive directory picker
      const selected = await pickDirectory();
      if (selected) {
        switchProject(selected);
      }
      return;
    }

    if (sub === 'add') {
      if (rest.length < 2) {
        console.log(chalk.yellow('  Usage: /workspace add <name> <path>'));
        return;
      }
      const name = rest[0];
      const path = rest.slice(1).join(' ');
      addProject(name, path);
      return;
    }

    if (sub === 'switch') {
      if (rest.length < 1) {
        console.log(chalk.yellow('  Usage: /workspace switch <name|path>'));
        return;
      }
      const nameOrPath = rest.join(' ');
      switchProject(nameOrPath);
      return;
    }

    if (sub === 'remove') {
      if (rest.length < 1) {
        console.log(chalk.yellow('  Usage: /workspace remove <name>'));
        return;
      }
      const name = rest[0];
      removeProject(name);
      return;
    }

    if (sub === 'info') {
      const ws = getActiveWorkspace();
      if (!ws.project) {
        console.log(chalk.dim('  No active workspace. Use /workspace switch to activate one.'));
        return;
      }
      console.log();
      console.log(chalk.bold('  Active Workspace'));
      console.log(chalk.cyan(`    Project:  ${ws.project}`));
      console.log(chalk.cyan(`    Path:     ${ws.path}`));
      if (ws.context) {
        console.log(chalk.cyan(`    Files:    ${ws.context.files.length}`));
        console.log(chalk.cyan(`    Sections: ${ws.context.files.reduce((n, f) => n + f.sections.length, 0)}`));
      }
      console.log();
      return;
    }

    console.log(chalk.yellow('  Usage:'));
    console.log(chalk.dim('    /workspace list                     — list all projects'));
    console.log(chalk.dim('    /workspace pick                     — interactive directory picker'));
    console.log(chalk.dim('    /workspace add <name> <path>        — register a new project'));
    console.log(chalk.dim('    /workspace switch <name|path>       — switch to a project'));
    console.log(chalk.dim('    /workspace remove <name>            — unregister a project'));
    console.log(chalk.dim('    /workspace info                     — show active workspace'));
  },
};

COMMANDS['bug'] = COMMANDS['report-bug'];
COMMANDS['draw'] = COMMANDS['imagine'];
COMMANDS['gen'] = COMMANDS['imagine'];

export function getCommand(name: string): Command | undefined {
  return COMMANDS[name.toLowerCase()];
}

export function getCommandNames(): string[] {
  return Object.keys(COMMANDS);
}