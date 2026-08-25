/**
 * Interactive REPL — readline, streaming, history, Ctrl+C,
 * shell escape (!), interactive slash-command picker (/), agent routing (@).
 *
 * NON-BLOCKING: Long-running tasks (forge, swarm, agent chat with &) run
 * as background jobs. The REPL stays interactive — you can chat, queue more
 * tasks, or check job status while agents work.
 *
 * "/" on an empty line immediately launches a searchable command picker
 * (via @inquirer/prompts) WITHOUT pressing Enter. This is achieved by
 * monkey-patching readline's _ttyWrite to intercept before the character
 * is added to the line buffer.
 */

import * as readline from 'node:readline';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import { search, Separator } from '@inquirer/prompts';
import type { GenesisClient } from './client.js';
import type { ShellConfig } from './config.js';
import { setActiveConfig, deepseekProvider, kimiProvider, roleProvider, getActiveConfig } from './config.js';
import { RelayClient, resolveRelayUrl, type RelayMessage, type RelayUser } from './relay.js';
import { createStreamRenderer, SteeringBar, type SessionProfile } from './renderer.js';
import { getCommand, getCommandNames, invokeMcpTool } from './commands.js';
import { getCommandRegistry } from './command-registry.js';
import { loadAgentNames, resolveAgentMention, completer, refreshCommandCompletions, SUBCOMMANDS, SUBCOMMAND_DEFS } from './completions.js';
import { collectArgs } from './interactive.js';
import {
  setJobNotifier, listJobs, getJob, cancelJob, runningCount,
  launchChatJob, launchForgeJob, launchSwarmJob,
  formatJobLine, formatJobOutput,
  type Job,
} from './jobs.js';
import { configureRemoteSync, recordTurn, loadSession, buildContextSummary } from './session-store.js';
import { personaSpeaking, personaIdle } from './persona-bridge.js';
import { setCurrentCommand, withCrashReporting } from './crash-reporter.js';
import { askHidden, isSecretBearing, redactForHistory } from './secret-input.js';

/** Commands that are long-running and auto-background. */
const AUTO_BG_COMMANDS = new Set(['forge', 'swarm']);

/** Post session profile to Strata for observability (best-effort). */
async function postToStrata(client: GenesisClient, profile: SessionProfile): Promise<void> {
  const strataUrl = client.baseUrl.replace(/:\d+$/, ':8136');
  await fetch(`${strataUrl}/api/v1/ingest/ide-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'aither-shell',
      session_id: profile.session_id,
      prompt: profile.prompt,
      model: profile.model,
      agent: profile.agent,
      event_count: profile.event_count,
      tool_calls: profile.tool_calls.map(t => t.name),
      errors: profile.errors,
      duration_ms: profile.duration_ms,
      thinking_traces: profile.thinking_traces.length,
    }),
    signal: AbortSignal.timeout(5000),
  });
}

/** Save a key-value pair to ~/.aither/shell.yaml (flat format). Creates the file if absent.
 *  Updates in-place if the key already exists, appends otherwise. */
function saveConfigKey(key: string, value: string): void {
  const configDir = join(homedir(), '.aither');
  const configFile = join(configDir, 'shell.yaml');
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    let content = existsSync(configFile) ? readFileSync(configFile, 'utf-8') : '';
    // Split on /\r?\n/ so an existing CRLF file is normalized to LF on write —
    // the readers anchor with '$', and a stray '\r' makes them drop the line.
    const lines = content.split(/\r?\n/);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(\w+):\s*/);
      if (match && match[1] === key) {
        lines[i] = `${key}: ${value}`;
        found = true;
        break;
      }
    }
    if (!found) lines.push(`${key}: ${value}`);
    // Trim trailing empty lines
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
    let out = lines.join("\n");
  } catch (err) {
    console.log(chalk.yellow('  Failed to save config:'), err instanceof Error ? err.message : String(err));
  }
}

/**
 * process.stdin.ref(), but only when it exists.
 *
 * ref/unref are socket methods. On a TTY or pipe stdin they are present; when stdin is a
 * plain file, /dev/null, or a non-interactive spawn they are NOT, and the bare call throws
 * `TypeError: process.stdin.ref is not a function` — which killed the REPL before its first
 * turn in every scripted/automated launch. Keeping stdin referenced is only ever an
 * event-loop-liveness optimisation, so skipping it where it does not apply is correct
 * behaviour, not a workaround.
 */
function refStdin(): void {
  const maybeRef = (process.stdin as NodeJS.ReadStream & { ref?: () => void }).ref;
  if (typeof maybeRef === 'function') maybeRef.call(process.stdin);
}

export async function startRepl(client: GenesisClient, config: ShellConfig): Promise<void> {
  // Publish config process-wide so deep helpers (MCP tool routing) can resolve
  // mcpUrl/authToken without threading config through every call site.
  setActiveConfig(config);

  // ── The native line-mode shell is the DEFAULT. The blessed multi-pane TUI is
  //    OPT-IN with AITHER_TUI=1 (owner decision, 2026-08-21). ──
  //
  // WHY THE DEFAULT FLIPPED. The full-screen TUI takes the alt screen and with
  // it everything the terminal already does well: scrollback, selection and
  // copy/paste, ctrl-r, the user's own prompt, tmux. In exchange it drew two
  // panes that were ~90% empty on a real session, and every defect reported on
  // 2026-08-21 was one it created rather than one it surfaced:
  //
  //   * an interactive /login prompt painted on top of the previous frame and
  //     could not be answered (runDetached never cleared the screen);
  //   * a launched brain pack was invisible, so `awsh gobbonet` looked like it
  //     had failed;
  //   * the emoji cell-width shim exists ONLY because blessed miscounts wide
  //     characters and scrambles the line.
  //
  // Line mode has none of those failure modes by construction: it writes lines
  // to a terminal, which is a thing terminals are good at. The feature people
  // actually reach for -- typing a question where a command goes -- is the
  // omnibox, which runs in the user's own shell and never wanted a TUI at all.
  //
  // The TUI is KEPT, not deleted: the per-turn trace pane is genuinely useful
  // for a long agent run, and deleting it would be an irreversible answer to a
  // reversible question.
  const _tuiEnv = (process.env.AITHER_TUI || '').toLowerCase();
  const _tuiOn = ['1', 'true', 'on', 'yes'].includes(_tuiEnv);
  if (process.stdout.isTTY && process.stdin.isTTY && _tuiOn) {
    try {
      const { startTuiRepl } = await import('./tui/repl-tui.js');
      await startTuiRepl(client, config);
      return;
    } catch (err: any) {
      console.error(chalk.yellow(
        `  TUI unavailable (${err?.message || err}) — using classic shell.`,
      ));
      // fall through to the readline REPL
    }
  }

  // Enable cross-client session sync (local CLI ↔ tunnel.aitherium.com)
  configureRemoteSync(config.genesisUrl, config.authToken);

  const agents = await loadAgentNames(client);

  // Auto-discover commands from Genesis (MCP tools, ADK groups, tagged endpoints)
  const registry = getCommandRegistry();
  const dynamicCount = await registry.loadDynamicCommands(client, config);
  if (dynamicCount > 0) {
    refreshCommandCompletions();
  }

  const history = loadHistory(config.historyFile);

  /** GPU status tag — updated by background poller. */
  let gpuTag = '';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
    completer: completer(agents),
    history,
    historySize: 500,
    terminal: true,
  });

  // ── Keep event loop alive ──
  // inquirer and AbortSignal.timeout can drop stdin refs.
  // This interval prevents premature exit in TTY mode.
  //
  // ref() only exists on socket-backed stdin. When stdin is neither a TTY nor a pipe — a
  // file, /dev/null, or a non-interactive spawn, which is exactly how automation and any
  // scripted launch runs the shell — process.stdin.ref is UNDEFINED and calling it throws
  // "process.stdin.ref is not a function", killing the REPL before its first turn.
  // Measured on node v25.2.1: non-TTY non-pipe stdin => typeof ref === 'undefined'.
  refStdin();
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  if (process.stdin.isTTY) {
    keepAlive = setInterval(() => {}, 2_147_483_647);
  }

  let gpuPollTimer: ReturnType<typeof setInterval> | null = null;

  function cleanExit(code = 0): void {
    if (keepAlive) clearInterval(keepAlive);
    if (gpuPollTimer) clearInterval(gpuPollTimer);
    process.exit(code);
  }

  // Catch unhandled rejections (orphan AbortSignal.timeout)
  process.on('unhandledRejection', (err: any) => {
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return;
    console.error(chalk.red(`  Unhandled error: ${err?.message || err}`));
  });

  let activeAbort: AbortController | null = null;
  const steeringBar = new SteeringBar();
  let sigintCount = 0;
  let pendingClose = false;
  let closed = false;
  let lastShellCmd = '';
  let menuActive = false;

  // ── Relay (native group chat) — linear readline variant of the TUI mode ──
  let relayRl: RelayClient | null = null;
  function relayPrint(line: string): void {
    // Print above the prompt without mangling the user's in-progress input.
    process.stdout.write('\r\x1b[K' + line + '\n');
    try { rl.prompt(true); } catch { /* */ }
  }
  function relayFmt(m: RelayMessage): string {
    const who = m.agent ? chalk.magenta('@' + m.nick) : chalk.cyan(m.nick);
    return `  ${who}: ${m.content}`;
  }
  async function startRelayReadline(arg: string): Promise<void> {
    const a = arg.trim();
    const sub = a.split(/\s+/)[0]?.toLowerCase() || '';
    if (relayRl) {
      if (sub === 'leave' || sub === 'exit' || sub === 'quit') { leaveRelayReadline(); return; }
      if (sub === 'join' && a.split(/\s+/)[1]) { relayRl.join(a.split(/\s+/)[1]); return; }
      if (sub === 'channels') { const cs = await relayRl.listChannels(a.split(/\s+/)[1] || 'platform'); console.log(chalk.bold('  Channels: ') + chalk.dim(cs.map(c => c.name).join('  '))); return; }
      if (sub === 'who') { console.log(chalk.dim('  (roster updates print on join/part)')); return; }
      if (a.startsWith('#')) { relayRl.join(a); return; }
      console.log(chalk.dim('  In relay: type to chat · /relay join #x · /relay channels · /leave')); return;
    }
    const nick = config.authUser?.username || config.authUser?.display_name || `dev_${Math.floor(Math.random() * 9000 + 1000)}`;
    const client = new RelayClient({
      url: resolveRelayUrl(), token: config.authToken || undefined, nick,
      handlers: {
        onStatus: (s) => { if (s !== 'open') relayPrint(chalk.dim(`  📡 relay: ${s}`)); },
        onHistory: (ch, msgs) => { relayPrint(chalk.dim(`── ${ch} — last ${msgs.length} ──`)); for (const m of msgs) relayPrint(relayFmt(m)); },
        onMessage: (m) => relayPrint(relayFmt(m)),
        onJoin: (n, _ch, isAgent) => relayPrint(chalk.dim(`  → ${isAgent ? '@' : ''}${n} joined`)),
        onPart: (n) => relayPrint(chalk.dim(`  ← ${n} left`)),
        onUserlist: (ch, users: RelayUser[]) => relayPrint(chalk.dim(`  ${ch}: ${users.length} here (${users.filter(u => u.is_agent).length} agents)`)),
        onError: (msg) => relayPrint(chalk.red(`  relay: ${msg}`)),
      },
    });
    const channel = a.startsWith('#') ? a : '#general';
    relayRl = client;
    console.log(chalk.green(`  📡 Joining ${channel} as ${nick}…  (type to chat · /relay join #x · /leave)`));
    client.connect(channel);
  }
  function leaveRelayReadline(): void {
    if (!relayRl) return;
    try { relayRl.part(); } catch { /* */ }
    relayRl.disconnect(); relayRl = null;
    console.log(chalk.dim('  📡 Left relay — back to agent chat.'));
  }

  /** Pending clarification gate from the last plan response. */
  let pendingGate: { planId: string; gateId: string; questions: any[] } | null = null;

  /** Last session profile for RLM context injection across turns. */
  let lastSessionProfile: SessionProfile | null = null;

  /** The actual conversation, for continuity across turns.
   *
   * lastSessionProfile IS assigned each turn -- but the summary built from
   * so prevCtx was always undefined and every turn reached the model with no
   * context -- "how do you know that?" had nothing to resolve "that"
   * against. And the summary it would have built is telemetry ("N tools, N
   * errors"), not conversation: it never contained what the assistant SAID,
   * which is the only part a follow-up question refers to.
   *
   * Bounded on purpose. Unbounded history on a bare completions path grows
   * the prompt every turn until it is rejected or expensive, and that
   * failure arrives as a mysterious mid-conversation error rather than as
   * anything recognisably about history. */
  const _turnHistory: { user: string; assistant: string }[] = [];
  const HISTORY_TURNS = 6;
  const HISTORY_CHARS = 4000;

  function historySummary(): string | null {
    if (!_turnHistory.length) return null;
    const lines: string[] = [];
    for (const turn of _turnHistory.slice(-HISTORY_TURNS)) {
      lines.push(`User: ${turn.user}`);
      if (turn.assistant) lines.push(`Assistant: ${turn.assistant}`);
    }
    let out = lines.join("\n");
    if (out.length > HISTORY_CHARS) out = out.slice(-HISTORY_CHARS);
    return out;
  }

  /** Seeded conversation summary when launched with --continue/--resume. */
  let seededContext: string | null = null;
  if (config.resumed) {
    const _entry = loadSession(config.sessionId);
    if (_entry?.messages.length) {
      seededContext = buildContextSummary(_entry.messages);
      console.log(chalk.green(`  ↩ Resumed session ${config.sessionId.slice(0, 8)} (${_entry.messages.length} messages)`));
    }
  }

  /** Build prompt with running job count and GPU status. */
  function buildPrompt(): string {
    const running = runningCount();
    const parts: string[] = [];
    if (running > 0) parts.push(String(running));
    if (gpuTag) parts.push(gpuTag);
    const suffix = parts.length > 0
      ? chalk.dim(`[${parts.join('|')}]`)
      : '';
    return chalk.green('awsh') + suffix + chalk.green('> ');
  }

  /** Update the prompt to reflect current job count / GPU state. */
  function refreshPrompt(): void {
    rl.setPrompt(buildPrompt());
  }

  /** Poll MicroScheduler GPU zone every 10s and update prompt tag. */
  gpuPollTimer = setInterval(async () => {
    try {
      const st = await client.getGpuStatus();
      const zone = st?.zone || '';
      const prev = gpuTag;
      if (zone.includes('image')) {
        gpuTag = chalk.yellow('GPU:3D');
      } else if (st?.active) {
        gpuTag = chalk.cyan('GPU:R');
      } else {
        gpuTag = '';
      }
      if (gpuTag !== prev) refreshPrompt();
    } catch {}
  }, 10_000);

  /** Restore readline + stdin after inquirer or any handler that disturbs them. */
  function restoreReadline(): void {
    refStdin();
    process.stdin.resume();
    rl.resume();
    // inquirer turns off raw mode; readline needs it on for _ttyWrite to fire
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true);
    }
  }

  /**
   * Print a notification above the current prompt line without disrupting
   * what the user is typing. Clears the line, prints, then re-renders prompt.
   * If a foreground task is active (readline paused), just print inline.
   */
  function notifyAbovePrompt(text: string): void {
    if (closed) return;

    if (activeAbort || processing) {
      // Foreground task active — just print, don't touch readline
      console.log(text);
      return;
    }

    // Save current line content
    const currentLine = (rl as any).line || '';
    // Move to start, clear line, print notification
    process.stdout.write('\r\x1B[2K');
    console.log(text);
    // Re-render prompt + whatever the user was typing
    refreshPrompt();
    rl.prompt(true);
    // Restore the user's in-progress input
    if (currentLine) {
      (rl as any).line = currentLine;
      (rl as any).cursor = currentLine.length;
      process.stdout.write(currentLine);
    }
  }

  // ── Background job notifications ──
  setJobNotifier((job: Job) => {
    const icon = job.status === 'completed' ? chalk.green('\u2713')
      : job.status === 'failed' ? chalk.red('\u2717')
        : chalk.yellow('\u2015');
    const statusColor = job.status === 'completed' ? chalk.green
      : job.status === 'failed' ? chalk.red
        : chalk.yellow;

    const header = `  ${icon} Job ${chalk.bold('#' + job.id)} ${statusColor(job.status)}: ${job.label}`;

    // Show content preview for completed jobs so user doesn't need /jobs <id> for short responses
    let preview = '';
    if (job.status === 'completed' && job.output.length > 0) {
      // Find the actual content (after the --- separator, or last non-trace line)
      const sepIdx = job.output.indexOf('---');
      const contentLines = sepIdx >= 0
        ? job.output.slice(sepIdx + 1)
        : job.output.filter(l => !l.startsWith('['));
      const content = contentLines.join('\n').trim();
      if (content.length > 0 && content.length <= 500) {
        // Short enough to show inline
        preview = '\n' + content.split('\n').map(l => `  ${l}`).join('\n');
      } else if (content.length > 500) {
        // Show first few lines + hint
        const firstLines = content.split('\n').slice(0, 4).join('\n');
        preview = '\n' + firstLines.split('\n').map(l => `  ${l}`).join('\n')
          + chalk.dim(`\n  ... (${content.length} chars — /jobs ${job.id} for full output)`);
      }
    } else if (job.status === 'failed' && job.error) {
      preview = '\n' + chalk.red(`  ${job.error}`);
    }

    if (preview) {
      notifyAbovePrompt(header + preview);
    } else {
      notifyAbovePrompt(header + chalk.dim(`  (/jobs ${job.id} for output)`));
    }
  });

  // The header above already prints the user. This printed them AGAIN, then a
  // six-item keybinding row, then a rotating tip -- "47 packs available",
  // "Sync config across machines" -- which is an ad on a tool you already
  // chose to open. Owner, 2026-08-21, on seeing twelve lines of chrome above
  // the cursor: it "feels like dog ass to use".
  //
  // A not-logged-in state is different: that one CHANGES what you can do next,
  // so it stays.
  if (!config.authUser) {
    console.log(chalk.dim('  Not logged in. Use /login to authenticate.'));
  }
  console.log(chalk.dim('  /  commands   !  shell   ?  help'));
  console.log();

  // ── Register shell session with Genesis (best effort) ──
  const _sessionRegistered = client.post('/shell/session/start', {
    client_type: 'ts-shell',
    session_id: config.sessionId,
    username: config.authUser?.username,
    user_id: config.authUser?.id,
  }).catch(() => {});

  // ── Build command choices for the interactive picker ──
  const cmdChoices = buildCommandChoices();

  // ── Monkey-patch _ttyWrite: "/" on empty line opens picker instantly ──
  // Also: update SteeringBar display with current input when active.
  if (process.stdin.isTTY) {
    const origTtyWrite = (rl as any)._ttyWrite;
    (rl as any)._ttyWrite = function (s: string, key: any) {
      if (menuActive) return;  // Block ALL keystrokes while picker is active
      if (s === '/' && this.line.length === 0 && !closed) {
        // ALWAYS open picker for / on empty line — even during steering.
        // Slash commands must never be sent as chat/steer input.
        menuActive = true;
        setImmediate(() => launchCommandPicker());
        return;
      }
      origTtyWrite.call(this, s, key);
      // Keep steering bar in sync with readline's internal buffer
      if (steeringBar.active) {
        steeringBar.setInput(this.line || '');
      }
    };
  }

  // ── Interactive command picker ──
  async function launchCommandPicker(): Promise<void> {
    let selected: string | undefined;
    // Track what the user typed so we can extract trailing args
    let lastSearchInput = '';
    try {
      // Erase the prompt line and pause readline
      process.stdout.write('\r\x1B[2K');
      rl.pause();

      selected = await search<string>({
        message: chalk.green('/'),
        source: (input) => {
          lastSearchInput = input || '';
          // Match on the FIRST word only — rest is args
          const term = lastSearchInput.split(/\s/)[0].toLowerCase();
          if (!term) return cmdChoices;
          return cmdChoices.filter((c: any) => {
            if (c.type === 'separator') return false;
            return c.value.includes(term)
              || c.name!.toLowerCase().includes(term)
              || (c.description || '').toLowerCase().includes(term);
          });
        },
        theme: {
          prefix: ' ',
          style: {
            highlight: (text: string) => chalk.cyan.bold(text),
          },
        },
      });
    } catch {
      // Ctrl+C / Escape — go back to prompt
    }

    menuActive = false;
    // Belt-and-suspenders: clear anything that got through
    (rl as any).line = '';
    (rl as any).cursor = 0;
    restoreReadline();

    if (selected) {
      // Check if the user typed args after the command in the picker
      // e.g. typed "nb list" — selected="nb", trailing args="list"
      const pickerParts = (lastSearchInput || '').trim().split(/\s+/);
      const trailingArgs = pickerParts.length > 1 ? pickerParts.slice(1).join(' ') : '';

      // D-2171 defensive guard: @inquirer/search's Enter handler resolves
      // against `searchResults[active]`, populated by an UNDEBOUNCED async
      // source() call fired on every keystroke (search/dist/index.js:58-91,
      // 94-138) — nothing guarantees the render Enter fires against matches
      // the term actually typed by then. Confirmed live 2026-08-24: typing
      // "/persona start" ran "/soul" instead. Recompute the same filter
      // this picker used; if the returned selection isn't something that
      // term would actually match, it's a stale render — refuse it rather
      // than silently execute the wrong command.
      const guardTerm = pickerParts[0]?.toLowerCase() || '';
      if (guardTerm) {
        const chosen = cmdChoices.find((c: any) => c.type !== 'separator' && c.value === selected);
        const stillMatches = chosen && (
          String(chosen.value).includes(guardTerm) ||
          String(chosen.name || '').toLowerCase().includes(guardTerm) ||
          String(chosen.description || '').toLowerCase().includes(guardTerm)
        );
        if (!stillMatches) {
          console.log(chalk.yellow(
            `  Picker returned "/${selected}" but you typed "${lastSearchInput}" — that's a stale selection, not what you asked for. Not running it; try again.`,
          ));
          refreshPrompt();
          return;
        }
      }

      if (trailingArgs) {
        // User typed command + args in picker — execute immediately
        lineQueue.push('/' + selected + ' ' + trailingArgs);
        drainQueue();
        return;
      }

      // If the command has subcommands, show a second picker. Skip single-entry
      // tables whose name is a positional placeholder (<x>/[x]/"x") — there's no
      // real subcommand to pick; fall through to execute `/selected`, which
      // processLine then collects arguments for interactively.
      const subDefs = SUBCOMMAND_DEFS['/' + selected];
      const isPlaceholderOnly = subDefs?.length === 1 && /^["<[]/.test(subDefs[0][0]);
      if (subDefs && subDefs.length > 0 && !isPlaceholderOnly) {
        let subSelected: string | undefined;
        let subSearchInput = '';
        try {
          process.stdout.write('\r\x1B[2K');
          rl.pause();

          const subChoices = subDefs.map(([name, argHint]) => ({
            name: argHint
              ? `${chalk.cyan(name)} ${chalk.dim(argHint)}`
              : chalk.cyan(name),
            value: name,
            description: '',
          }));

          subSelected = await search<string>({
            message: chalk.green(`/${selected} `),
            source: (input) => {
              subSearchInput = input || '';
              const term = subSearchInput.split(/\s/)[0].toLowerCase();
              if (!term) return subChoices;
              return subChoices.filter((c: any) => c.value.includes(term));
            },
            theme: {
              prefix: ' ',
              style: { highlight: (text: string) => chalk.cyan.bold(text) },
            },
          });
        } catch {
          // Ctrl+C / Escape
        }

        menuActive = false;
        (rl as any).line = '';
        (rl as any).cursor = 0;
        restoreReadline();

        if (subSelected) {
          // Check for trailing args typed in sub-picker
          const subParts = (subSearchInput || '').trim().split(/\s+/);
          const subArgs = subParts.length > 1 ? subParts.slice(1).join(' ') : '';

          if (subArgs) {
            // User typed args in picker — execute immediately
            lineQueue.push(`/${selected} ${subSelected} ${subArgs}`);
            drainQueue();
            return;
          }

          // Check if this subcommand needs args
          const subDef = subDefs.find(([n]) => n === subSelected);
          const needsSubArgs = subDef && subDef[1] !== '';

          if (needsSubArgs) {
            // Prefill so user can type the arg, e.g. "/nb create "
            rl.prompt();
            rl.write(`/${selected} ${subSelected} `);
            return;
          }

          // No args needed — execute immediately
          lineQueue.push(`/${selected} ${subSelected}`);
          drainQueue();
          return;
        }

        rl.prompt();
        return;
      }

      // No subcommands — execute immediately
      // Handle MCP tool selections from the picker
      if (selected.startsWith('mcp:')) {
        const toolName = selected.slice(4);
        lineQueue.push('/' + toolName);
      } else {
        lineQueue.push('/' + selected);
      }
      drainQueue();
      return;
    }

    rl.prompt();
  }

  // ── Line queue — serialize processing but DON'T block on bg tasks ──
  const lineQueue: string[] = [];
  let processing = false;

  async function drainQueue() {
    if (processing) return;
    processing = true;

    try {
      while (lineQueue.length > 0) {
        const input = lineQueue.shift()!;
        await processLine(input);
      }
    } catch (err: any) {
      console.error(chalk.red(`  Internal error: ${err.message}`));
    }

    processing = false;
    menuActive = false;
    if (pendingClose) { cleanExit(0); return; }
    if (!closed) {
      refreshPrompt();
      restoreReadline();
      rl.prompt();
    }
  }

  async function processLine(input: string): Promise<void> {
    if (!input) return;

    // A CREDENTIAL MUST NOT REACH THE HISTORY FILE. This runs before any
    // command is dispatched, so `/password hunter2` was appended verbatim to
    // ~/.aither history -- on disk, surviving the terminal, and re-read into
    // the next session. Scrollback was the visible half of that defect; this
    // was the half that lasted.
    saveHistory(config.historyFile,
                isSecretBearing(input) ? redactForHistory(input) : input);

    // Exit
    if (input === 'exit' || input === 'quit') {
      const running = runningCount();
      if (running > 0) {
        console.log(chalk.yellow(`  ${running} background job(s) still running. They will be cancelled.`));
      }
      console.log(chalk.dim('  Goodbye.'));
      rl.close();
      return;
    }

    // ── ? — quick help ──
    if (input === '?') {
      printHelp(config);
      return;
    }

    // ── ! — shell escape (execute in pwsh 7) ──
    if (input.startsWith('!')) {
      let shellCmd = input.slice(1).trim();

      if (shellCmd === '!' || !shellCmd) {
        if (input === '!!' && lastShellCmd) {
          shellCmd = lastShellCmd;
          console.log(chalk.dim(`  > ${shellCmd}`));
        } else if (!shellCmd) {
          console.log(chalk.yellow('  Usage: !command  (run in PowerShell 7)'));
          console.log(chalk.dim('  !!  repeats last shell command'));
          return;
        }
      }

      lastShellCmd = shellCmd;
      console.log();
      try {
        execSync(`pwsh -NoProfile -c "${shellCmd.replace(/"/g, '\\"')}"`, {
          stdio: 'inherit',
          timeout: 300000,
        });
      } catch (err: any) {
        if (err.status) {
          console.log(chalk.yellow(`  exit ${err.status}`));
        } else {
          console.log(chalk.red(`  Error: ${err.message}`));
        }
      }
      console.log();
      return;
    }

    // ── Check for trailing & — explicit background request ──
    const explicitBg = input.endsWith(' &') || input.endsWith('\t&');
    const cleanInput = explicitBg ? input.slice(0, -2).trimEnd() : input;

    // ── / — slash commands (via Enter, if user typed /command directly) ──
    if (cleanInput.startsWith('/')) {
      const spaceIdx = cleanInput.indexOf(' ');
      const cmdName = spaceIdx > 0 ? cleanInput.slice(1, spaceIdx) : cleanInput.slice(1);
      const cmdArgs = spaceIdx > 0 ? cleanInput.slice(spaceIdx + 1) : '';

      if (cmdName === 'exit' || cmdName === 'quit') {
        console.log(chalk.dim('  Goodbye.'));
        rl.close();
        return;
      }

      // ── pack-declared commands ──
      //
      // Checked BEFORE the shell's own commands so a pack cannot be shadowed
      // into silence by a same-named builtin appearing later: the user asked
      // for the pack, so the pack wins inside it.
      {
        const pc = (config.packCommands || []).find(x => x.name === cmdName);
        if (pc) {
          if (pc.url) {
            // Same spelling commands.ts already uses for this; no new helper.
            const { execSync } = await import('node:child_process');
            const opener = process.platform === 'win32' ? 'start ""'
              : process.platform === 'darwin' ? 'open' : 'xdg-open';
            console.log('  ' + chalk.cyan(pc.url));
            try { execSync(`${opener} "${pc.url}"`, { stdio: 'ignore' }); }
            catch { console.log(chalk.dim('  could not open a browser — copy the URL above')); }
          } else if (pc.run) {
            const { spawn } = await import('node:child_process');
            console.log(chalk.dim(`  ${pc.run}`));
            await new Promise<void>(res => {
              const ch = spawn(pc.run!, { shell: true, stdio: 'inherit' });
              ch.on('close', () => res());
              ch.on('error', e => { console.log('  ' + chalk.red(String(e))); res(); });
            });
          }
          return;
        }
      }

      // ── /password — set the pack app's sign-in password ──
      //
      // `awsh <pack> --set-password` already did this. From inside the shell
      // there was no command, so a user who hits the sign-in page has to quit
      // and re-launch with a flag they must already know about.
      if (cmdName === 'password') {
        if (!config.packName || !config.packSecretFile) {
          console.log(chalk.dim('  this pack declares no app password.'));
          return;
        }
        let pw = cmdArgs.trim();
        if (pw) {
          // Still accepted -- scripts pass it -- but say what just happened. The
          // characters are already on screen and in scrollback by the time this
          // runs; nothing can take them back, so the honest move is to name it
          // and point at the safe form. (History is redacted; the terminal is not.)
          console.log(chalk.yellow('  that password was typed in the clear')
                      + chalk.dim(' — it is in your terminal scrollback.'));
          console.log(chalk.dim('  next time run ') + chalk.cyan('/password')
                      + chalk.dim(' with no argument and it will be hidden.'));
        } else {
          // THE DEFAULT PATH IS THE SAFE ONE. This block used to print usage
          // telling the user to put the secret on the command line -- not merely
          // permitting the unsafe form, instructing it.
          console.log('  ' + chalk.bold('set the app password')
                      + chalk.dim('   at least 4 characters'));
          console.log(chalk.dim(`  stored as a salted hash in ${config.packSecretFile}`));
          // Two different credentials, one letter apart in the menu. This one is
          // the LOCAL app's own gate; /login is Aitherium platform identity and
          // has nothing to do with it. A user who reaches for the wrong one gets
          // a browser SSO round trip and still cannot open their app.
          console.log(chalk.dim('  this is the app\'s own password, not your ')
                      + chalk.cyan('/login') + chalk.dim(' to aitherium.com.'));
          console.log();
          pw = (await askHidden(chalk.cyan('  new password: '))).trim();
          if (!pw) {
            // askHidden returns '' on Ctrl+C. Treating that as a password would
            // set the app's gate to nothing and report success.
            console.log(chalk.dim('  cancelled — password unchanged.'));
            return;
          }
          const again = (await askHidden(chalk.cyan('  confirm      : '))).trim();
          if (again !== pw) {
            // Confirmation matters MORE when input is hidden: a typo cannot be
            // seen, and the failure surfaces later as 'the app rejects my
            // password', which reads as a broken app.
            console.log(chalk.yellow('  they do not match — password unchanged.'));
            return;
          }
        }
        const { findPack } = await import('./packs.js');
        const { setAppPassword } = await import('./pack-app.js');
        const { dirname } = await import('node:path');
        const { existsSync } = await import('node:fs');
        let rr = dirname(config.packManifest || process.cwd());
        while (rr !== dirname(rr) && !existsSync(rr + '/.git')) rr = dirname(rr);
        const pk = findPack(rr, config.packName);
        if (!pk) {
          console.log(chalk.yellow(`  pack ${config.packName} is no longer on disk.`));
          return;
        }
        const res = setAppPassword(rr, pk, pw);
        if (!res.ok) {
          console.log('  ' + chalk.red(res.detail));
          return;
        }
        console.log('  ' + chalk.green('password set') + chalk.dim(' — only the salted hash is stored.'));
        // Said plainly because the opposite is the confusing case: the app is
        // still serving with the old password until it is restarted, and a user
        // who tries the new one immediately will think the command failed.
        console.log(chalk.dim('  restart the app for it to take effect:  ')
                    + chalk.cyan('/gui') + chalk.dim('  (stop it first)'));
        return;
      }

      // ── /gui — open the launched pack's full app ──
      //
      // A pack can declare a whole application (app_script, app_url), and
      // `awsh <pack> --app` starts it. Inside the shell there was no way to
      // reach it and nothing said it existed, so the app was effectively
      // undiscoverable to the people most likely to want it -- already in
      // the shell, talking to the persona. Same shape as a feature behind a
      // flag with no control to set it: shipped, and deleted in practice.
      if (cmdName === 'gui' || cmdName === 'app') {
        if (!config.packName) {
          console.log(chalk.dim('  no pack is loaded — start one with' + chalk.bold(' awsh <pack>')));
          return;
        }
        const { findPack } = await import('./packs.js');
        const { launchPackApp } = await import('./pack-app.js');
        // Derive the repo root from the PACK'S OWN manifest, not process.cwd().
        // The shell is normally launched from the user's home directory, so cwd
        // is not the repo -- and launchPackApp resolves app_script relative to
        // the root, so a wrong root looks like 'the app script is missing'.
        const { dirname } = await import('node:path');
        const { existsSync } = await import('node:fs');
        let rr = dirname(config.packManifest || process.cwd());
        while (rr !== dirname(rr) && !existsSync(rr + '/.git')) rr = dirname(rr);
        const pk = findPack(rr, config.packName);
        if (!pk) {
          console.log(chalk.yellow(`  pack ${config.packName} is no longer on disk.`));
          return;
        }
        console.log(chalk.dim(`  starting ${pk.name}…`));
        const res = await launchPackApp(rr, pk);
        if (!res.ok) {
          console.log('  ' + chalk.red('could not launch') + ' ' + res.detail);
        } else {
          console.log('  ' + chalk.magenta('◈') + ' ' + chalk.bold(pk.title || pk.name)
                      + chalk.dim(res.alreadyRunning ? '  ·  already running' : '  ·  started'));
          console.log('  ' + chalk.cyan(res.url!));
        }
        // A minted password is printed even on failure: only its salted hash
        // is stored, so swallowing it here destroys the only copy.
        if (res.newPassword) {
          console.log('  ' + chalk.yellow('access password (shown once):')
                      + '  ' + chalk.bold(res.newPassword));
        }
        return;
      }
      // ── /jobs — built-in job management ──
      if (cmdName === 'jobs') {
        await handleJobsCommand(cmdArgs);
        return;
      }

      // ── /deepseek — switch to direct DeepSeek inference on the fly ──
      //   /deepseek            → deepseek-chat (flash)
      //   /deepseek reasoner   → deepseek-reasoner (R1)
      //   /deepseek off        → revert to the default backend
      if (cmdName === 'deepseek') {
        const arg = cmdArgs.trim().toLowerCase();
        if (arg === 'off' || arg === 'none' || arg === 'stop') {
          config.provider = undefined;
          console.log(chalk.dim('  DeepSeek off — back to the default backend.'));
        } else {
          config.provider = deepseekProvider(cmdArgs.trim() || 'flash');
          config.inferenceMode = 'raw';
          const p = config.provider;
          console.log(chalk.cyan('  ◈ DeepSeek on') + chalk.dim(` — model ${p.model}`));
          if (!p.apiKey) {
            console.log(chalk.yellow('    No API key — ') + chalk.dim('get one at https://platform.deepseek.com/api_keys'));
            console.log(chalk.dim('    then: export DEEPSEEK_API_KEY=sk-… and retry /deepseek'));
          }
        }
        setActiveConfig(config);
        refreshPrompt();
        return;
      }

      // ── /kimi — switch to direct Moonshot Kimi inference on the fly ──
      //   /kimi                → kimi-k3
      //   /kimi <model>        → explicit Moonshot model id
      //   /kimi off            → revert to the default backend
      if (cmdName === 'kimi' || cmdName === 'moonshot') {
        const arg = cmdArgs.trim().toLowerCase();
        if (arg === 'off' || arg === 'none' || arg === 'stop') {
          config.provider = undefined;
          console.log(chalk.dim('  Kimi off — back to the default backend.'));
        } else {
          config.provider = kimiProvider(cmdArgs.trim() || 'k3');
          config.inferenceMode = 'raw';
          const p = config.provider;
          console.log(chalk.cyan('  ◈ Kimi on') + chalk.dim(` — model ${p.model}`));
          if (!p.apiKey) {
            console.log(chalk.yellow('    No API key — ') + chalk.dim('get one at https://platform.moonshot.ai (Console → API Keys)'));
            console.log(chalk.dim('    then: export MOONSHOT_API_KEY=sk-… and retry /kimi'));
          }
        }
        setActiveConfig(config);
        refreshPrompt();
        return;
      }

      // ── /model — show per-role model config ──
      //   /model                          → print config table
      //   /model set <role> <model> [url] → set model for orchestrator|reasoning|perception
      if (cmdName === 'model') {
        const parts = cmdArgs.trim().split(/\s+/);
        const sub = parts[0];

        if (sub === 'set' && parts[1] && parts[2]) {
          const role = parts[1].toLowerCase() as 'orchestrator' | 'reasoning' | 'perception';
          const model = parts[2];
          const url = parts[3];

          if (!['orchestrator', 'reasoning', 'perception'].includes(role)) {
            console.log(chalk.yellow('  Invalid role:'), chalk.dim('use orchestrator, reasoning, or perception'));
            return;
          }

          if (!config.providers) config.providers = {};
          const provider = (config.providers[role] ||= { name: role, llmUrl: '', model: '', apiKey: undefined });
          provider.model = model;
          if (url) provider.llmUrl = url.replace(/\/+$/, '');

          saveConfigKey(`${role}_model`, model);
          if (url) saveConfigKey(`${role}_url`, provider.llmUrl);

          console.log(chalk.cyan(`  ◈ ${role}`), chalk.dim(`→ ${model}`), url ? chalk.dim(`@ ${provider.llmUrl}`) : '');
          setActiveConfig(config);
          refreshPrompt();
        } else {
          // Print the current table
          console.log();
          const rows: Array<[string, string]> = [];
          const roles = ['orchestrator', 'reasoning', 'perception'] as const;
          for (const role of roles) {
            const prov = config.providers?.[role];
            const modelStr = prov?.model ? chalk.cyan(prov.model) : chalk.dim('(default)');
            const urlStr = prov?.llmUrl ? chalk.dim(`@ ${prov.llmUrl}`) : '';
            const keyStr = prov?.apiKey ? chalk.green('✓') : (prov ? chalk.yellow('—') : chalk.dim('—'));
            rows.push([
              chalk.bold(role),
              `${modelStr} ${urlStr} ${keyStr}`.trim(),
            ]);
          }
          console.log('  Role              Config');
          for (const [r, cfg] of rows) {
            console.log(`  ${r.padEnd(16)}  ${cfg}`);
          }
          console.log();
        }
        return;
      }

      // ── /keys — manage per-role API key configuration ──
      //   /keys set <role> <ENV_VAR_NAME> → set the env var that holds the API key
      if (cmdName === 'keys') {
        const parts = cmdArgs.trim().split(/\s+/);
        const sub = parts[0];

        if (sub === 'set' && parts[1] && parts[2]) {
          const role = parts[1].toLowerCase() as 'orchestrator' | 'reasoning' | 'perception';
          const envVarName = parts[2];

          if (!['orchestrator', 'reasoning', 'perception'].includes(role)) {
            console.log(chalk.yellow('  Invalid role:'), chalk.dim('use orchestrator, reasoning, or perception'));
            return;
          }

          if (!config.providers) config.providers = {};
          const provider = (config.providers[role] ||= { name: role, llmUrl: '', model: '', apiKey: undefined });
          const apiKey = process.env[envVarName];
          provider.apiKey = apiKey;

          saveConfigKey(`${role}_key_env`, envVarName);

          if (apiKey) {
            console.log(chalk.cyan(`  ◈ ${role}`), chalk.green('✓'), chalk.dim(`key from ${envVarName}`));
          } else {
            console.log(chalk.yellow(`  ${role}`), chalk.dim(`key env ${envVarName} is not set`));
          }
          setActiveConfig(config);
          refreshPrompt();
        } else {
          console.log(chalk.dim('  Usage: /keys set <orchestrator|reasoning|perception> <ENV_VAR_NAME>'));
        }
        return;
      }

      // ── /relay — native group chat (humans + agents) ──
      if (cmdName === 'relay') { await startRelayReadline(cmdArgs); return; }
      if ((cmdName === 'leave' || cmdName === 'unrelay') && relayRl) { leaveRelayReadline(); return; }

      // Bare "/" via Enter — launch picker as fallback
      if (!cmdName) {
        if (process.stdin.isTTY && !menuActive) {
          menuActive = true;
          rl.pause();
          await launchCommandPicker();
        } else {
          showCommandList();
        }
        return;
      }

      const cmd = getCommand(cmdName);
      if (cmd) {
        // Auto-background for forge/swarm, or explicit & for any command
        const shouldBg = explicitBg || AUTO_BG_COMMANDS.has(cmdName);

        if (shouldBg && cmdName === 'forge') {
          // Parse forge args and launch as background job
          launchBgForge(client, cmdArgs);
          return;
        }

        if (shouldBg && cmdName === 'swarm') {
          launchBgSwarm(client, cmdArgs);
          return;
        }

        // Other commands with & — wrap in background job
        if (explicitBg) {
          const { launchCommandJob } = await import('./jobs.js');
          const job = launchCommandJob(
            `/${cmdName} ${cmdArgs}`.trim(),
            () => cmd.handler(client, cmdArgs, config),
          );
          console.log(chalk.dim(`  Background job ${chalk.bold('#' + job.id)} started: /${cmdName}`));
          refreshPrompt();
          return;
        }

        try {
          // Fully detach readline from stdin so command handlers that read
          // stdin directly (e.g. /login) get exclusive access to keystrokes.
          // rl.pause() alone doesn't work — readline's internal 'data'/'keypress'
          // listeners still intercept and buffer input.
          rl.pause();
          const stdinListeners = process.stdin.rawListeners('data').slice();
          const keypressListeners = process.stdin.rawListeners('keypress').slice();
          process.stdin.removeAllListeners('data');
          process.stdin.removeAllListeners('keypress');
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.resume();

          // Bare invocation of a command with a subcommand table → collect its
          // arguments interactively (stdin is already detached above, so
          // @inquirer owns the keystrokes). Cancelling aborts the command.
          let finalArgs = cmdArgs;
          let cancelled = false;
          const subDefs = SUBCOMMAND_DEFS['/' + cmdName];
          if (!cmdArgs && subDefs?.length) {
            const collected = await collectArgs(cmdName, subDefs);
            if (collected === null) { cancelled = true; console.log(chalk.dim('  (cancelled)')); }
            else finalArgs = collected;
          }
          if (!cancelled) {
            setCurrentCommand(`/${cmdName} ${finalArgs}`.trim());
            await cmd.handler(client, finalArgs, config);
          }

          // Reattach readline's listeners
          process.stdin.removeAllListeners('data');
          process.stdin.removeAllListeners('keypress');
          for (const fn of stdinListeners) process.stdin.on('data', fn as (...args: any[]) => void);
          for (const fn of keypressListeners) process.stdin.on('keypress', fn as (...args: any[]) => void);
        } catch (err: any) {
          console.log(chalk.red(`  Error: ${err.message}`));
          // Prompt user to send error report
          try {
            await withCrashReporting(async () => { throw err; }, `/${cmdName} ${cmdArgs}`.trim());
          } catch { /* already handled */ }
        } finally {
          restoreReadline();
        }
      } else {
        // Try MCP tool fallback — auto-discovered tools are callable as slash commands
        const mcpTool = registry.getMcpTool(cmdName);
        if (mcpTool) {
          try {
            // Parse args as JSON params or key=value pairs
            let params: Record<string, any> = {};
            const trimmed = cmdArgs.trim();
            if (trimmed.startsWith('{')) {
              try { params = JSON.parse(trimmed); } catch { /* not JSON */ }
            } else if (trimmed) {
              for (const pair of trimmed.split(/\s+/)) {
                const eq = pair.indexOf('=');
                if (eq > 0) {
                  params[pair.slice(0, eq)] = pair.slice(eq + 1);
                } else {
                  params['input'] = pair;
                }
              }
            }
            const spinner = (await import('ora')).default(`Calling ${cmdName}...`).start();
            // Routes to the remote MCP gateway (config.mcpUrl) when set, else
            // the chat backend's REST /tools/call.
            const output = await invokeMcpTool(client, cmdName, params);
            spinner.stop();
            console.log(chalk.cyan(`  [MCP: ${cmdName}]`));
            if (output && typeof output === 'object' && 'error' in output) {
              console.log(chalk.red(`  MCP tool error: ${(output as any).error}`));
            } else {
              console.log(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
            }
          } catch (err: any) {
            console.log(chalk.red(`  MCP tool error: ${err.message}`));
          }
        } else {
          const names = getCommandNames();
          const close = names.filter(n => n.startsWith(cmdName.toLowerCase().slice(0, 2)));
          const hint = close.length
            ? `  Did you mean: ${close.map(n => chalk.cyan('/' + n)).join(', ')}?`
            : `  Type ${chalk.cyan('/')} to open the command picker.`;
          console.log(chalk.yellow(`  Unknown command: /${cmdName}`));
          console.log(hint);
        }
      }
      return;
    }

    // ── HARD GUARD: special prefixes NEVER become chat messages ──
    // If we reach this point with a "/" prefix, something went wrong above
    // (picker edge case, unknown command, etc). Catch it — never send to LLM.
    if (cleanInput.startsWith('/')) {
      const attempted = cleanInput.split(/\s+/)[0];
      console.log(chalk.yellow(`  Unknown command: ${attempted}`));
      console.log(chalk.dim(`  Type / to open the command picker, or /help for a list.`));
      return;
    }

    // "!" prefix should have been caught above — guard just in case
    if (cleanInput.startsWith('!')) {
      console.log(chalk.yellow('  Usage: !command  (run in PowerShell 7)'));
      return;
    }

    // ── Relay mode: plain input is a message to the channel (humans + agents) ──
    if (relayRl) { relayRl.send(cleanInput); return; }

    // @agent routing vs @strategy triggers
    // Strategy triggers (@think, @research, @debug, etc.) should be passed
    // through to Genesis as-is — the StrategyResolver detects them there.
    // Agent routes (@demiurge, @lyra, @atlas, etc.) set the persona.
    const STRATEGY_TRIGGERS = new Set([
      'think', 'reason', 'research', 'council', 'deliberate',
      'swarm', 'plan', 'agentic', 'compete', 'debug',
      'troubleshoot', 'investigate', 'quick',
      // Context-mode directives (ScopeContext)
      'code', 'internal',
      // Personal assistant mode
      'personal',
      // Companion / conversational mode
      'chat', 'companion', 'talk',
      // Creative / story mode
      'story', 'saga', 'narrative',
      // AppForge
      'appforge', 'build',
      // Security testing strategies
      'redteam', 'pentest', 'security', 'hack',
    ]);

    let agent = config.defaultAgent;
    let message = cleanInput;

    // Extract ALL leading @mentions (handles "@aither @demi hi" → agents=["aither","demiurge"])
    // Each mention is resolved against the AitherDirectory. Unknown mentions
    // produce a warning and are dropped. Short aliases (e.g., "demi" → "demiurge")
    // are resolved automatically.
    const allMentions = cleanInput.match(/^(?:@(\S+)\s+)+/);
    const resolvedAgents: string[] = [];
    if (allMentions) {
      const mentionParts = cleanInput.match(/@(\S+)/g) || [];
      for (const m of mentionParts) {
        const raw = m.slice(1); // strip '@'
        if (STRATEGY_TRIGGERS.has(raw.toLowerCase())) continue;
        const { resolved, unknown } = resolveAgentMention(raw);
        if (resolved) {
          if (!resolvedAgents.includes(resolved)) resolvedAgents.push(resolved);
        } else if (unknown) {
          console.log(chalk.yellow(`  ⚠ Unknown agent: @${unknown} — not in directory, skipped`));
        }
      }
      if (resolvedAgents.length > 0) {
        agent = resolvedAgents[0];
        // Keep the FULL message (with all @mentions) so the backend
        // IntentClassifier sees them and prevents trivial classification.
        // The backend strips @mentions internally when building the LLM prompt.
        message = cleanInput;
      }
    }
    // Strategy triggers: keep the full "@think ..." in message for Genesis

    // Detect deep strategy triggers that should remove the effort cap
    const DEEP_TRIGGERS = new Set([
      'think', 'reason', 'research', 'council', 'agentic',
      'deliberate', 'debug', 'investigate', 'swarm',
    ]);
    const triggerParts = cleanInput.match(/@(\S+)/g) || [];
    const hasDeepTrigger = triggerParts.some(m =>
      DEEP_TRIGGERS.has(m.slice(1).toLowerCase())
    );

    // ── Background chat (explicit & suffix) ──
    if (explicitBg) {
      const label = agent !== config.defaultAgent
        ? `@${agent}: ${message.slice(0, 40)}...`
        : `Chat: ${message.slice(0, 50)}...`;
      const job = launchChatJob(client, message, {
        agent,
        sessionId: config.sessionId,
        model: config.model,
        label,
      });
      console.log(chalk.dim(`  Background job ${chalk.bold('#' + job.id)} started: ${label}`));
      refreshPrompt();
      return;
    }

    // ── Foreground stream chat ──
    // Pre-flight readiness check — warn before wasting time on a stalled backend
    try {
      const healthResp = await fetch(`${config.genesisUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (healthResp.ok) {
        const hData = await healthResp.json();
        if (hData.generation_ready === false) {
          console.log(chalk.yellow('  System busy — LLM pool exhausted (0 slots available).'));
          console.log(chalk.dim('  Sending anyway — pool auto-recovers. Use /pool reset to force.'));
        }
      }
    } catch { /* don't block on health check failure */ }

    // Do NOT pause readline — user can type to steer the active session.
    // Lines entered during generation are routed to /chat/steer.
    activeAbort = new AbortController();
    // The SteeringBar gives a fixed bottom input bar, but it does so with a
    // DECSTBM scroll region that destroys native scrollback and EATS long output
    // (the original bug). A fixed bar and terminal scrollback are fundamentally
    // incompatible, so the bar is opt-in (AITHER_STEER=1). DEFAULT: the native
    // readline prompt at the bottom + the renderer's transient ora spinner (which
    // clears itself before each write) — scrollback works, output is never eaten,
    // and steering still works (typing during generation is routed to /chat/steer).
    const _useSteerBar = ['1', 'true', 'on', 'yes'].includes((process.env.AITHER_STEER || '').toLowerCase());
    if (_useSteerBar) {
      steeringBar.activate();
      // Blank readline's prompt so it can't leave a duplicate behind the bar.
      if (process.stdin.isTTY) rl.setPrompt('');
    }
    const renderer = createStreamRenderer(config.sessionId, message, _useSteerBar ? steeringBar : undefined);

    // Build session context from previous turn for RLM continuity
    // Real conversation first. The profile branch below is kept because it
    // carries tool/error telemetry a backend may use, but it is not what a
    // follow-up question needs.
    const _hist = historySummary();
    const prevCtx = _hist ? {
      summary: _hist,
      tools_used: lastSessionProfile?.tool_calls.map(t => t.name) ?? [],
      model: lastSessionProfile?.model ?? (config.model || ''),
      errors: lastSessionProfile?.errors ?? [],
    } : lastSessionProfile ? {
      summary: `Previous prompt: "${lastSessionProfile.prompt.slice(0, 200)}" → ${lastSessionProfile.model}, ${lastSessionProfile.tool_calls.length} tools, ${lastSessionProfile.errors.length} errors`,
      tools_used: lastSessionProfile.tool_calls.map(t => t.name),
      model: lastSessionProfile.model,
      errors: lastSessionProfile.errors,
    } : seededContext ? {
      summary: seededContext, tools_used: [] as string[], model: config.model || '', errors: [] as string[],
    } : undefined;
    seededContext = null;  // consume once

    // If there's a pending clarification gate, auto-attach it so the
    // backend resolves the gate and refines the plan instead of starting
    // a brand new pipeline. The gate is consumed on use.
    let clarificationResponse: import('./client.js').ClarificationResponse | undefined;
    if (pendingGate) {
      clarificationResponse = {
        plan_id: pendingGate.planId,
        gate_id: pendingGate.gateId,
        answers: message,  // user's natural-language answer
      };
      pendingGate = null;  // consume — don't re-send on next message
    }

    try {
      // Only repl-tui.ts drove the Persona desktop overlay before this — the
      // plain `awsh` REPL had no wiring at all, so talking to Aither here
      // never moved the avatar. personaSpeaking()/personaIdle() are
      // fire-and-forget with their own dead-endpoint cooldown (persona-bridge.ts),
      // so this is a no-op when Persona isn't running.
      personaSpeaking();
      const stream = client.streamChat(message, {
        agent,
        mentions: resolvedAgents.length > 1 ? resolvedAgents : undefined,
        sessionId: config.sessionId,
        model: config.model,
        signal: activeAbort.signal,
        clarificationResponse,
        sessionContext: prevCtx,
        effort: config.effort,
        safetyLevel: config.safetyLevel,
        privateMode: config.privateMode,
        attachments: config.imageAttachments,
        maxEffort: hasDeepTrigger ? undefined : (config.effort || 5),
      });

      // Clear image attachments after including them — they're one-shot
      if (config.imageAttachments?.length) {
        config.imageAttachments = undefined;
      }

      let streamTimedOut = false;

      for await (const event of stream) {
        renderer.onEvent(event);

        if (event.type === 'stream_timeout') {
          streamTimedOut = true;
        }

        // Track clarification_needed events so the NEXT message
        // auto-resolves the gate without user having to do anything special.
        if (event.type === 'clarification_needed' && event.data.plan_id) {
          pendingGate = {
            planId: event.data.plan_id,
            gateId: event.data.gate_id || '',
            questions: event.data.questions || [],
          };
        }
      }

      // Stream ended with timeout — check if forge agent is still running
      if (streamTimedOut) {
        console.log(chalk.yellow('\n  ⏱ Stream timed out — no data received for 2 minutes.'));
        console.log(chalk.dim('  Checking if the agent is still working...'));
        try {
          // Check both forge sessions and Genesis status in parallel
          const [forgeData, statusData] = await Promise.all([
            Promise.race([
              client.get('/forge/sessions'),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
            ]),
            Promise.race([
              client.getStatus(),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
            ]),
          ]);

          const sessions = forgeData?.sessions || forgeData?.active || [];
          const active = Array.isArray(sessions) ? sessions.filter((s: any) => s.status === 'running' || s.status === 'active') : [];

          if (active.length > 0) {
            const agentDetails = active.map((s: any) => {
              const name = s.agent || s.agent_id || 'agent';
              const elapsed = s.elapsed_ms ? ` (${Math.round(s.elapsed_ms / 1000)}s)` : '';
              return `${name}${elapsed}`;
            }).join(', ');
            console.log(chalk.cyan(`  ✓ Agent still processing: ${agentDetails}`));
            console.log(chalk.dim('  The work continues in background — send a follow-up or check /forge.'));
          } else if (statusData) {
            const llm = statusData.llm_status || statusData.llm || 'unknown';
            console.log(chalk.dim(`  Genesis: ${statusData.status || 'unknown'} | LLM: ${typeof llm === 'object' ? llm.status || 'unknown' : llm}`));
            console.log(chalk.dim('  No active forge sessions found. The request may have failed server-side.'));
            console.log(chalk.dim('  Try again, or use & suffix to run in background: your message &'));
          } else {
            console.log(chalk.red('  Could not reach Genesis — services may be down.'));
            console.log(chalk.dim('  Check: /status or docker ps'));
          }
        } catch {
          console.log(chalk.dim('  Could not check forge status. The agent may still be processing.'));
          console.log(chalk.dim('  Try sending a follow-up message or check /status.'));
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        process.stdout.write(chalk.dim('\n  (interrupted)\n'));
        // Clear any pending gate — the user intentionally aborted
        pendingGate = null;
      } else {
        const msg = err.message || 'unknown error';
        if (msg.includes('took too long')) {
          console.log(chalk.yellow(`\n  ${msg}`));
          console.log(chalk.dim('  Checking which services are down...'));
          try {
            const svcData = await client.getServices();
            const services = svcData?.services || [];
            const down = services.filter((s: any) => s.status !== 'healthy' && !s.healthy);
            if (down.length) {
              console.log(chalk.dim(`  ${down.length} service(s) unreachable:`));
              for (const s of down.slice(0, 8)) {
                console.log(chalk.red(`    ${s.name}:${s.port || '?'} — ${s.status || 'down'}`));
              }
              if (down.length > 8) console.log(chalk.dim(`    ... and ${down.length - 8} more`));
              console.log(chalk.dim('\n  Tip: Start more services with:'));
              console.log(chalk.cyan('    docker compose -f docker-compose.aitheros.yml --profile chat-full up -d'));
            } else {
              console.log(chalk.dim('  All registered services appear healthy. LLM may be overloaded.'));
            }
          } catch {
            console.log(chalk.dim('  Could not fetch service status.'));
          }
        } else if (msg.includes('Cannot connect') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
          console.log(chalk.red(`  Genesis is not reachable at ${config.genesisUrl}`));
          console.log(chalk.dim('  Start it with: docker compose -f docker-compose.aitheros.yml --profile chat-minimal up -d'));
        } else {
          console.log(chalk.red(`  Error: ${msg}`));
        }
      }
    } finally {
      personaIdle();
      steeringBar.deactivate();
      if (process.stdin.isTTY) refreshPrompt();  // restore the green prompt
      renderer.finish();
      // Capture session profile for RLM and Strata
      lastSessionProfile = renderer.getSessionProfile();
      // Post to Strata (best-effort, non-blocking)
      postToStrata(client, lastSessionProfile).catch(() => {});
      // Persist the full turn (user + assistant) locally + remote → /export, --continue.
      try {
        const _toks = lastSessionProfile.events.reduce((n, e) =>
          n + ((e.type === 'llm_done' || e.type === 'llm_end') ? Number(e.data?.tokens_used || e.data?.tokens || 0) : 0), 0);
        recordTurn(config.sessionId, lastSessionProfile.agent || 'aither', lastSessionProfile.prompt, renderer.getContent(), {
          model: lastSessionProfile.model, tools: lastSessionProfile.tool_calls.map(t => t.name), tokens: _toks,
        });
      } catch { /* */ }
      // The same two strings recordTurn() already persists, kept in memory so
      // the NEXT turn can refer to this one. Without it the model is handed
      // telemetry about the last turn and none of its content.
      try {
        const _a = renderer.getContent();
        if (message) _turnHistory.push({ user: message, assistant: _a || '' });
        while (_turnHistory.length > HISTORY_TURNS) _turnHistory.shift();
      } catch { /* */ }
      activeAbort = null;
      if (!closed) restoreReadline();
    }
  }

  /* ── /jobs command handler ──────────────────────────────────── */

  async function handleJobsCommand(args: string): Promise<void> {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] || '';

    // ── Cloud expeditions ──
    if (sub === 'cloud' || sub === 'cjobs') {
      const expId = parts[1] || '';
      if (expId) {
        // /jobs cloud <id>
        await handleExpeditionDetail(client, expId);
      } else {
        // /jobs cloud
        await handleExpeditionList(client);
      }
      return;
    }

    // ── Steer & hint ──
    if (sub === 'steer' || sub === 'hint') {
      const expId = parts[1];
      if (!expId) {
        console.log(chalk.yellow(`  Usage: /jobs ${sub} <expedition-id> <message...>`));
        return;
      }
      const message = parts.slice(2).join(' ');
      if (!message) {
        console.log(chalk.yellow(`  Usage: /jobs ${sub} <expedition-id> <message...>`));
        return;
      }
      await handleExpeditionSteer(client, expId, message, sub === 'hint' ? 'hint' : 'append');
      return;
    }

    // ── Watch ──
    if (sub === 'watch') {
      const expId = parts[1];
      if (!expId) {
        console.log(chalk.yellow('  Usage: /jobs watch <expedition-id>'));
        return;
      }
      await handleExpeditionWatch(client, expId);
      return;
    }

    // /jobs cancel <id>
    if (sub === 'cancel' || sub === 'kill') {
      const id = Number(parts[1]);
      if (!id) { console.log(chalk.yellow('  Usage: /jobs cancel <id>')); return; }
      if (cancelJob(id)) {
        console.log(chalk.green(`  Job #${id} cancelled.`));
        refreshPrompt();
      } else {
        console.log(chalk.yellow(`  Job #${id} is not running or doesn't exist.`));
      }
      return;
    }

    // /jobs <id> — show output
    const id = Number(sub);
    if (id > 0) {
      const job = getJob(id);
      if (!job) { console.log(chalk.yellow(`  Job #${id} not found.`)); return; }
      console.log(formatJobOutput(job));
      return;
    }

    // /jobs — list all local + help
    const allJobs = listJobs();
    if (allJobs.length === 0) {
      console.log(chalk.dim('  No local background jobs.'));
    } else {
      console.log(chalk.bold('\n  Local Background Jobs\n'));
      for (const job of allJobs) {
        console.log(formatJobLine(job));
      }
    }
    console.log();
    console.log(chalk.bold('  Commands\n'));
    console.log(chalk.dim('  Local jobs:'));
    console.log(`    ${chalk.cyan('/jobs')}              List local background jobs`);
    console.log(`    ${chalk.cyan('/jobs <id>')}         View job output`);
    console.log(`    ${chalk.cyan('/jobs cancel <id>')}  Cancel a running job`);
    console.log();
    console.log(chalk.dim('  Cloud expeditions (durable):'));
    console.log(`    ${chalk.cyan('/jobs cloud')}         List expeditions`);
    console.log(`    ${chalk.cyan('/jobs cloud <id>')}    View expedition details`);
    console.log(`    ${chalk.cyan('/jobs steer <id> msg')} Send message to expedition`);
    console.log(`    ${chalk.cyan('/jobs hint <id> msg')}  Send invisible hint to expedition`);
    console.log(`    ${chalk.cyan('/jobs watch <id>')}    Watch expedition stream live`);
    console.log();
  }

  /* ── Expedition helpers ────────────────────────────────────── */

  async function handleExpeditionList(client: GenesisClient): Promise<void> {
    try {
      const result = await client.listExpeditions();
      if (!result || result.error) {
        console.log(chalk.red(`  Error: ${result?.error || 'Failed to list expeditions'}`));
        return;
      }

      const expeditions = result.expeditions || [];
      if (!expeditions.length) {
        console.log(chalk.dim('  No expeditions.'));
        return;
      }

      console.log(chalk.bold('\n  Cloud Expeditions (Durable Jobs)\n'));
      // Format as a table: ID | Status | Title | Owner
      const headers = ['ID', 'Status', 'Title', 'Owner'];
      const rows = expeditions.map((exp: any) => [
        exp.id.slice(0, 8),
        formatExpeditionStatus(exp.status),
        (exp.title || '').slice(0, 40),
        exp.owner || 'unknown',
      ]);

      // Simple table format
      const maxLens = [8, 12, 40, 15];
      console.log(`  ${headers.map((h: string, i: number) => h.padEnd(maxLens[i])).join(' ')}`);
      console.log(`  ${headers.map(() => '─'.repeat(10)).join(' ')}`);
      for (const row of rows) {
        console.log(`  ${row.map((c: string, i: number) => String(c).padEnd(maxLens[i])).join(' ')}`);
      }
      console.log(chalk.dim(`\n  /jobs cloud <id>  View expedition details`));
      console.log();
    } catch (err: any) {
      console.log(chalk.red(`  Error: ${err.message}`));
    }
  }

  async function handleExpeditionDetail(client: GenesisClient, expId: string): Promise<void> {
    try {
      const status = await client.getExpeditionStatus(expId);
      if (!status || status.error) {
        console.log(chalk.red(`  Expedition not found: ${expId}`));
        return;
      }

      const tasks = await client.getExpeditionTasks(expId);
      const taskList = tasks?.tasks || [];

      console.log(chalk.bold(`\n  Expedition: ${expId}\n`));
      console.log(`  Status: ${formatExpeditionStatus(status.status || 'unknown')}`);
      if (status.title) console.log(`  Title:  ${status.title}`);
      if (status.owner) console.log(`  Owner:  ${status.owner}`);
      if (status.created_at) console.log(`  Created: ${new Date(status.created_at).toLocaleString()}`);

      if (taskList.length > 0) {
        console.log(chalk.bold('\n  Tasks\n'));
        for (const task of taskList) {
          const icon = task.status === 'completed' ? chalk.green('✓') : task.status === 'failed' ? chalk.red('✗') : chalk.blue('•');
          const title = task.title || task.id.slice(0, 8);
          console.log(`    ${icon} ${title.padEnd(30)} ${chalk.dim(task.status)}`);
          if (task.result_summary) {
            const summary = typeof task.result_summary === 'string'
              ? task.result_summary
              : JSON.stringify(task.result_summary, null, 2);
            const lines = summary.split('\n').slice(0, 5);
            for (const line of lines) {
              console.log(`      ${chalk.dim(line)}`);
            }
            if (summary.split('\n').length > 5) {
              console.log(`      ${chalk.dim('...')}`);
            }
          }
          if (task.error) {
            console.log(`      ${chalk.red(task.error)}`);
          }
        }
      }
      console.log();
    } catch (err: any) {
      console.log(chalk.red(`  Error: ${err.message}`));
    }
  }

  async function handleExpeditionSteer(
    client: GenesisClient,
    expId: string,
    message: string,
    action: 'append' | 'hint',
  ): Promise<void> {
    try {
      const result = await client.steerExpedition(expId, message, action);
      if (!result || result.error) {
        console.log(chalk.red(`  Error: ${result?.error || 'Failed to steer expedition'}`));
        return;
      }
      const verb = action === 'hint' ? 'hint sent' : 'message sent';
      console.log(chalk.green(`  ✓ ${verb} to expedition ${result.expedition_id}`));
      refreshPrompt();
    } catch (err: any) {
      console.log(chalk.red(`  Error: ${err.message}`));
    }
  }

  async function handleExpeditionWatch(client: GenesisClient, expId: string): Promise<void> {
    try {
      console.log(chalk.cyan(`  Watching expedition ${expId}... (Ctrl+C to stop)\n`));
      let eventCount = 0;
      for await (const event of client.streamExpeditionEvents(expId)) {
        eventCount++;
        if (event.type === 'error') {
          console.log(chalk.red(`  Error: ${event.data.error}`));
          break;
        }
        // Print event summaries
        const ts = new Date().toLocaleTimeString();
        const typeIcon = event.type === 'EXPEDITION_COMPLETED' ? chalk.green('✓')
          : event.type === 'EXPEDITION_FAILED' ? chalk.red('✗')
          : '•';
        console.log(`  ${ts} ${typeIcon} ${event.type}`);
        if (event.data.message) {
          console.log(`    ${chalk.dim(event.data.message)}`);
        }
        if (event.type === 'EXPEDITION_COMPLETED' || event.type === 'EXPEDITION_FAILED') {
          console.log(chalk.cyan(`\n  Expedition ${event.data.status || 'done'}`));
          break;
        }
      }
      if (eventCount === 0) {
        console.log(chalk.yellow('  No events received (expedition may not exist or is already done).'));
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('abort')) {
        console.log(chalk.yellow('\n  Watch cancelled.'));
      } else {
        console.log(chalk.red(`  Error: ${err.message}`));
      }
    }
  }

  function formatExpeditionStatus(status: string): string {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'completed' || normalized === 'done') return chalk.green(status);
    if (normalized === 'failed' || normalized === 'error') return chalk.red(status);
    if (normalized === 'running' || normalized === 'active') return chalk.blue(status);
    return chalk.yellow(status);
  }

  /* ── Background forge launcher ──────────────────────────────── */

  function launchBgForge(client: GenesisClient, args: string): void {
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

    const job = launchForgeJob(client, task, { agent, effort });
    const who = agent ? `@${agent}` : 'Forge';
    console.log(
      chalk.dim(`  ${who} dispatched as background job ${chalk.bold('#' + job.id)}`)
      + chalk.dim(` (effort ${effort ?? 5})`),
    );
    refreshPrompt();
  }

  /* ── Background swarm launcher ──────────────────────────────── */

  function launchBgSwarm(client: GenesisClient, args: string): void {
    let task = args;
    let mode = 'llm';
    const modeMatch = args.match(/--mode\s+(\S+)/);
    if (modeMatch) { mode = modeMatch[1]; task = task.replace(modeMatch[0], ''); }
    task = task.replace(/^["']|["']$/g, '').trim();

    if (!task) {
      console.log(chalk.dim('  Usage: /swarm <task> [--mode forge|llm|plan_only]'));
      return;
    }

    const job = launchSwarmJob(client, task, mode);
    console.log(
      chalk.dim(`  Swarm (${mode}) dispatched as background job ${chalk.bold('#' + job.id)}`),
    );
    refreshPrompt();
  }

  // ── Ctrl+C handling ──
  rl.on('SIGINT', () => {
    if (activeAbort) {
      steeringBar.deactivate();
      if (process.stdin.isTTY) refreshPrompt();  // restore the green prompt
      activeAbort.abort();
      activeAbort = null;
    } else {
      sigintCount++;
      if (sigintCount >= 2) {
        console.log(chalk.dim('\n  Goodbye.'));
        cleanExit(0);
      }
      const running = runningCount();
      const jobHint = running > 0 ? chalk.dim(` (${running} background job${running > 1 ? 's' : ''} running)`) : '';
      console.log(chalk.dim('\n  Press Ctrl+C again to exit, or type a message.') + jobHint);
      rl.prompt();
      setTimeout(() => { sigintCount = 0; }, 2000);
    }
  });

  // ── Line handler ──
  function onLine(line: string): void {
    sigintCount = 0;
    const input = line.trim();
    if (!input) { refreshPrompt(); rl.prompt(); return; }

    // Slash commands and shell escapes are ALWAYS dispatched locally,
    // even during active generation — never send them as steering input.
    if (input.startsWith('/') || input.startsWith('!')) {
      lineQueue.push(input);
      drainQueue();
      return;
    }

    // If a foreground generation is active, steer instead of queue
    if (activeAbort && !closed) {
      // Special: "cancel" / "stop" / Ctrl+C text → cancel the session
      const lower = input.toLowerCase();
      if (lower === 'cancel' || lower === 'stop' || lower === '@abort') {
        activeAbort.abort();
        return;
      }

      // Steer the active session — inject this input
      steeringBar.clearInput();
      client.steer(config.sessionId, input, 'append').catch(() => {});
      return;
    }

    lineQueue.push(input);
    drainQueue();
  }

  rl.on('line', onLine);

  // ── EOF (Ctrl+D) / stdin close ──
  rl.on('close', () => {
    closed = true;
    // Deregister shell session (best effort, don't block exit)
    client.post('/shell/session/end', { session_id: config.sessionId }).catch(() => {});
    if (processing) {
      pendingClose = true;
    } else if (!process.stdin.isTTY) {
      setTimeout(() => cleanExit(0), 10);
    } else {
      console.log(chalk.dim('\n  Goodbye.'));
      cleanExit(0);
    }
  });

  rl.prompt();
}

/* ── Help text ─────────────────────────────────────────────── */

function printHelp(config: ShellConfig): void {
  console.log(chalk.bold('\n  AitherShell Quick Reference\n'));
  console.log(`  ${chalk.cyan('/')}               Interactive command picker (instant)`);
  console.log(`  ${chalk.cyan('/command')}        Run a command directly`);
  console.log(`  ${chalk.cyan('@agent message')} Route message to specific agent`);
  console.log(`  ${chalk.cyan('@mode message')}  Set processing mode (see below)`);
  console.log(`  ${chalk.cyan('!command')}        Run shell command in PowerShell 7`);
  console.log(`  ${chalk.cyan('!!')}              Repeat last shell command`);
  console.log(`  ${chalk.cyan('message')}         Chat with default agent (${config.defaultAgent})`);
  console.log(`  ${chalk.cyan('exit')} / ${chalk.cyan('Ctrl+D')} Quit`);
  console.log(`  ${chalk.cyan('Ctrl+C')}          Cancel current request / double-tap to quit`);
  console.log();
  console.log(chalk.bold('  @ Directives\n'));
  console.log(chalk.dim('  Context modes — change what gets loaded:'));
  console.log(`  ${chalk.cyan('@code')}           Force code context — codegraph + architecture + tools`);
  console.log(`  ${chalk.cyan('@research')}       Deep web research + synthesis pipeline`);
  console.log(`  ${chalk.cyan('@internal')}       Full AitherOS internal context (platform only)`);
  console.log(chalk.dim('  Processing modes — change how the model thinks:'));
  console.log(`  ${chalk.cyan('@chat')}           Companion mode — fast, natural conversation (persists)`);
  console.log(`  ${chalk.cyan('@quick')}          Fast response, no deliberation (effort 1–3)`);
  console.log(`  ${chalk.cyan('@think')}          Deep reasoning with extended deliberation`);
  console.log(`  ${chalk.cyan('@reason')}         Full reasoning model + structured analysis`);
  console.log(`  ${chalk.cyan('@agentic')}        Force agentic ReAct loop with tools`);
  console.log(chalk.dim('  Multi-agent:'));
  console.log(`  ${chalk.cyan('@debug')}          PRISM-powered debugging — 6 expert personas`);
  console.log(`  ${chalk.cyan('@troubleshoot')}   Systematic service troubleshooting`);
  console.log(`  ${chalk.cyan('@investigate')}    Deep exploratory investigation`);
  console.log(`  ${chalk.cyan('@council')}        6-specialist council review`);
  console.log(`  ${chalk.cyan('@deliberate')}     Parallel thought streams + convergence`);
  console.log(`  ${chalk.cyan('@swarm')}          Full 11-agent swarm coding`);
  console.log(`  ${chalk.cyan('@compete')}        Multiple strategies in parallel — best judged`);
  console.log();
  console.log(chalk.bold('  Background Jobs\n'));
  console.log(`  ${chalk.cyan('message &')}       Run chat in background`);
  console.log(`  ${chalk.cyan('@agent task &')}   Run agent task in background`);
  console.log(`  ${chalk.cyan('/forge task')}     Auto-backgrounds (long-running)`);
  console.log(`  ${chalk.cyan('/swarm task')}     Auto-backgrounds (long-running)`);
  console.log(`  ${chalk.cyan('/command &')}      Background any slash command`);
  console.log(`  ${chalk.cyan('/jobs')}            List all background jobs`);
  console.log(`  ${chalk.cyan('/jobs <id>')}       View job output`);
  console.log(`  ${chalk.cyan('/jobs cancel <id>')} Cancel a running job`);
  console.log();
}

/* ── Build choices for the interactive command picker ──────── */

/** Does the pack this shell was launched with actually ship an app?
 *
 * Read from the manifest rather than hardcoded, so a new pack that declares
 * app_script gets its /gui with no shell change. `gui` was originally written
 * into three lists here, which meant every pack shipping an app would need the
 * same three-place edit.
 *
 * The narrow version of a `commands:` block: it covers the one case the
 * manifest can already express, without inventing a schema nobody agreed. */
/** Names of the commands the launched pack contributes. */
function packCommandNames(): string[] {
  try {
    const cfg = getActiveConfig();
    return (cfg?.packCommands || []).map(c => c.name);
  } catch {
    return [];
  }
}

/** Does the launched pack have a password to manage? */
function packHasSecret(): boolean {
  try {
    const cfg = getActiveConfig();
    return Boolean(cfg && cfg.packName && cfg.packSecretFile);
  } catch {
    return false;
  }
}

function packDeclaresApp(): boolean {
  try {
    const cfg = getActiveConfig();
    return Boolean(cfg && cfg.packName && cfg.packDeclaresApp);
  } catch {
    return false;   // no pack loaded, or config not ready
  }
}

function buildCommandChoices() {
  const commands = getCommandNames();
  const registry = getCommandRegistry();
  const dynamicCmds = registry.allCommands();
  const categories: [string, string[]][] = [
    ['System',     ['status', 'services', 'agents', 'logs', 'model', 'metrics']],
    ['Agents',     ['forge', 'sessions', 'resume', 'swarm', 'inbox', 'compose', 'monitor', 'notebook']],
    ['Jobs',       ['jobs']],
    ['Search',     ['search', 'codegraph', 'scope', 'onboard', 'obsidian', 'tools', 'context']],
    ['AI',         ['think', 'research', 'memory', 'soul']],
    ['Ops',        ['deploy', 'fleet', 'workflow', 'backup', 'benchmark', 'products', 'docker']],
    ['Security',   ['security', 'review', 'train', 'tool-scope', 'rbac']],
    ['Automation', ['run', 'script', 'apps', 'gaming', 'routines']],
    ['Auth',       ['login', 'register', 'logout', 'whoami']],
    ['Shell',      ['help', 'clear', 'config', 'gui', 'password']],   // 'gui' survives the filter above only when the pack declares an app
  ];

  // The launched pack's own commands, in their own section: a user should
  // be able to see which capabilities came from the pack rather than from
  // the shell, because that is what they can change by changing packs.
  const packCmds = (() => {
    try { return getActiveConfig()?.packCommands || []; } catch { return []; }
  })();

  const choices: any[] = [];
  const used = new Set<string>();

  // Merge static + dynamically discovered command names
  const allCommands = [...new Set([...commands, ...dynamicCmds.map((c: { name: string }) => c.name), 'jobs',
    ...(packDeclaresApp() ? ['gui'] : []),
    ...(packHasSecret() ? ['password'] : []),
    ...packCommandNames()])];

  if (packCmds.length) {
    choices.push(new Separator(chalk.bold.dim(' ── Pack ──')));
    for (const pc of packCmds) {
      choices.push({
        name: `/${pc.name}`,
        value: pc.name,
        description: pc.description || (pc.url ? `Open ${pc.url}` : pc.run),
      });
      used.add(pc.name);
    }
  }

  for (const [cat, names] of categories) {
    const available = names.filter(n => allCommands.includes(n));
    if (!available.length) continue;

    choices.push(new Separator(chalk.bold.dim(` ── ${cat} ──`)));

    for (const name of available) {
      if (name === 'password') {
        choices.push({
          name: '/password',
          value: 'password',
          description: "Set the pack app's sign-in password",
        });
        used.add(name);
        continue;
      }
      if (name === 'gui') {
        choices.push({
          name: '/gui',
          value: 'gui',
          description: "Open the launched pack's full app in a browser",
        });
        used.add(name);
        continue;
      }
      if (name === 'jobs') {
        choices.push({
          name: '/jobs',
          value: 'jobs',
          description: 'List and manage background jobs',
        });
        used.add(name);
        continue;
      }
      const cmd = getCommand(name);
      choices.push({
        name: `/${name}`,
        value: name,
        description: cmd?.description || '',
      });
      used.add(name);
    }
  }

  const extra = allCommands.filter(n => !used.has(n) && n !== 'exit' && n !== 'quit');
  if (extra.length) {
    choices.push(new Separator(chalk.bold.dim(' ── Other ──')));
    for (const name of extra) {
      const cmd = getCommand(name);
      const dynCmd = !cmd ? registry.resolve(name) : undefined;
      choices.push({
        name: `/${name}`,
        value: name,
        description: cmd?.description || dynCmd?.description || '',
      });
    }
  }

  // Add discovered MCP tools as a separate section
  const mcpTools = registry.getMcpTools();
  if (mcpTools.length) {
    choices.push(new Separator(chalk.bold.dim(' ── MCP Tools ──')));
    for (const tool of mcpTools.slice(0, 15)) {
      choices.push({
        name: `/${tool.name}`,
        value: `mcp:${tool.name}`,
        description: tool.description || 'MCP tool',
      });
    }
    if (mcpTools.length > 15) {
      choices.push({
        name: chalk.dim(`  ... and ${mcpTools.length - 15} more (/tools to see all)`),
        value: 'tools',
        description: '',
      });
    }
  }

  return choices;
}

/* ── Fallback static command list (non-TTY) ───────────────── */

function showCommandList(): void {
  const registry = getCommandRegistry();
  const commands = getCommandNames();
  console.log(chalk.bold('\n  Commands\n'));
  for (const name of commands) {
    if (name === 'exit' || name === 'quit') continue;
    const cmd = getCommand(name);
    const dynCmd = !cmd ? registry.resolve(name) : undefined;
    const desc = (cmd?.description || dynCmd?.description)
      ? chalk.dim(` — ${cmd?.description || dynCmd?.description}`)
      : '';
    console.log(`    ${chalk.cyan('/' + name)}${desc}`);
  }
  console.log(`    ${chalk.cyan('/jobs')}${chalk.dim(' — List and manage background jobs')}`);
  console.log();
}

/* ── History persistence ──────────────────────────────────── */

function loadHistory(file: string): string[] {
  try {
    if (existsSync(file)) {
      return readFileSync(file, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .slice(-500);
    }
  } catch { /* ignore */ }
  return [];
}

function saveHistory(file: string, line: string): void {
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, line + '\n');
  } catch { /* ignore */ }
}
