/**
 * Full-featured interactive REPL on the blessed 3-pane surface.
 *
 * Feature parity with the readline REPL (repl.ts): chat streaming + steering,
 * @agent routing, background jobs (`&`, /jobs, auto-bg forge/swarm), a native
 * command picker (`/`), Tab completion, clarification-gate auto-resolve,
 * !shell, history, Strata posting, remote session sync + RLM continuity,
 * GPU status tag and a pre-flight readiness check. Interactive @inquirer
 * pickers inside command handlers don't work under blessed — use AITHER_TUI=0
 * for those; everything else runs in-pane.
 */
import { execSync } from 'node:child_process';
import { isSecretBearing, redactForHistory } from '../secret-input.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import type { GenesisClient } from '../client.js';
import type { ClarificationResponse } from '../client.js';
import type { ShellConfig } from '../config.js';
import { setActiveConfig } from '../config.js';
import { getCommand, getCommandNames } from '../commands.js';
import { getCommandRegistry } from '../command-registry.js';
import {
  loadAgentNames, resolveAgentMention, completer, refreshCommandCompletions, SUBCOMMAND_DEFS,
} from '../completions.js';
import { collectArgs } from '../interactive.js';
import { personaEmotion, personaIdle, personaLevel, personaSpeaking } from '../persona-bridge.js';
import { gatherStatus, formatStatusLines, formatStatusBar, formatWelcomeHeader, type StatusInfo } from '../status-banner.js';
import {
  setJobNotifier, listJobs, getJob, cancelJob, runningCount,
  launchChatJob, launchForgeJob, launchSwarmJob, launchCommandJob,
  formatJobLine, formatJobOutput, type Job,
} from '../jobs.js';
import { configureRemoteSync, recordTurn, loadSession, buildContextSummary } from '../session-store.js';
import type { SessionProfile } from '../renderer.js';
import { openLocalImage } from '../renderer.js';
import { loadDoc, renderDocLines, resolveDocPath } from '../doc-view.js';
import { imageToAnsi, imageDimensions } from '../image-preview.js';
import { createTuiScreen, type PickerItem, type TuiSurface } from './screen.js';
import { createTuiRenderer } from './controller.js';
import { haltMessage } from './queue-halt.js';
import { AffectPoller } from './affect.js';
import { VoiceController } from './voice.js';
import { resolveServiceEndpoint } from './service-endpoint.js';
import { buildAffectPanel } from './aithersense-panel.js';
import { buildFlameGraph } from './flame-graph-overlay.js';
import { buildNeuronPanel, emptyNeuronState } from './neuron-activity-view.js';
import { buildReasoningPanel } from './reasoning-stream-view.js';
import { buildKnowledgeGraph } from './knowledge-graph-overlay.js';
import { buildSessionsPanel } from './sessions-view.js';
import { fetchUnifiedSessions } from '../sessions-client.js';
import { buildRoomPanel } from './room-view.js';
import { fetchRoomSnapshot } from '../room-client.js';
import { renderPortrait, renderPngFile } from './portrait.js';
import { emotionFromAffect } from './avatar.js';
import type { StreamRenderer } from '../renderer.js';
import { setTuiActive } from '../crash-reporter.js';
import { RelayClient, resolveRelayUrl, type RelayMessage, type RelayUser } from '../relay.js';
import { BackgroundJobsListener } from '../background-jobs-listener.js';
import { resolveServerJobId, formatServerJobLine, type ServerExpedition, type BlockingGate } from '../jobs.js';

const AUTO_BG_COMMANDS = new Set(['forge', 'swarm']);
const STRATEGY_TRIGGERS = new Set([
  'think', 'reason', 'research', 'council', 'deliberate', 'swarm', 'plan',
  'agentic', 'compete', 'debug', 'troubleshoot', 'investigate', 'quick',
  'code', 'internal', 'personal', 'chat', 'companion', 'talk', 'story', 'saga',
  'narrative', 'appforge', 'build', 'redteam', 'pentest', 'security', 'hack',
]);
const DEEP_TRIGGERS = new Set([
  'think', 'reason', 'research', 'council', 'agentic', 'deliberate', 'debug',
  'investigate', 'swarm',
]);

function loadHistory(file?: string): string[] {
  if (!file || !existsSync(file)) return [];
  try { return readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).slice(-500); }
  catch { return []; }
}
function saveHistory(file: string | undefined, line: string): void {
  if (!file) return;
  try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, line + '\n'); } catch { /* */ }
}
function stringify(a: any): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}
function sumTokens(events: Array<{ type: string; data: any }>): number {
  let n = 0;
  for (const e of events) if (e.type === 'llm_done' || e.type === 'llm_end') n += Number(e.data?.tokens_used || e.data?.tokens || 0);
  return n;
}
async function postToStrata(client: GenesisClient, profile: SessionProfile): Promise<void> {
  const strataUrl = client.baseUrl.replace(/:\d+$/, ':8136');
  await fetch(`${strataUrl}/api/v1/ingest/ide-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'aither-shell', session_id: profile.session_id, prompt: profile.prompt,
      model: profile.model, agent: profile.agent, event_count: profile.event_count,
      tool_calls: profile.tool_calls.map(t => t.name), errors: profile.errors,
      duration_ms: profile.duration_ms, thinking_traces: profile.thinking_traces.length,
    }),
    signal: AbortSignal.timeout(5000),
  });
}

export async function startTuiRepl(client: GenesisClient, config: ShellConfig): Promise<void> {
  setActiveConfig(config);
  configureRemoteSync(config.genesisUrl, config.authToken);
  let agents: string[] = [];
  try { agents = await loadAgentNames(client); } catch { /* */ }
  const registry = getCommandRegistry();
  try { if (await registry.loadDynamicCommands(client, config)) refreshCommandCompletions(); } catch { /* */ }
  const complete = completer(agents);

  const history = loadHistory(config.historyFile);
  let histIdx = history.length;

  let activeAbort: AbortController | null = null;
  let processing = false;
  // Type-ahead queue: messages typed while a turn is streaming. Run as fresh
  // turns the instant the current one finishes (Claude-Code style) instead of
  // being dropped into a steer that oneshot/trivial turns silently discard.
  let queuedInputs: string[] = [];
  let draining = false;
  let sigintCount = 0;
  let sigintTimer: ReturnType<typeof setTimeout> | null = null;
  let gpuTag = '';
  let pendingGate: { planId: string; gateId: string } | null = null;
  let lastProfile: SessionProfile | null = null;
  // ── Relay (native group chat) state ──
  let relay: RelayClient | null = null;
  let rosterUsers: RelayUser[] = [];
  let relayUnread: Map<string, number> = new Map();  // other channels' unread counts
  let relayKnownChannels: string[] = [];             // for tab-completion
  let relayOldestTs: string | null = null;           // oldest shown msg ts (scrollback)
  let relayLoadingOlder = false;
  let relayTypingThrottle: ReturnType<typeof setTimeout> | null = null;
  // ── Background jobs listener (server-side expeditions) ──
  let jobsListener: BackgroundJobsListener | null = null;
  let serverJobs: Map<string, ServerExpedition> = new Map();  // cache of expeditions from server
  let pendingJobOutput: Array<{ jobId: string; content: string }> = [];  // queued until turn ends
  /** Scrollback: fetch + prepend older history when the output is scrolled to top. */
  async function relayLoadOlder(): Promise<void> {
    if (!relay || relayLoadingOlder || !relayOldestTs) return;
    relayLoadingOlder = true;
    try {
      const older = await relay.loadOlder(relayOldestTs, 50);
      if (older.length) {
        relayOldestTs = String(older[0].timestamp || relayOldestTs);
        surface.prependOutput(older.map(formatRelayMsg).join('\n'));
      } else {
        surface.prependOutput(chalk.dim('  ── beginning of channel ──'));
        relayOldestTs = null;  // nothing older — stop further loads
      }
    } finally { relayLoadingOlder = false; }
  }
  /** Tab-complete a relay channel (#…) or roster nick from the last token. */
  function relayComplete(value: string): string | null {
    if (!relay) return null;
    const idx = value.lastIndexOf(' ');
    const head = idx >= 0 ? value.slice(0, idx + 1) : '';
    const tok = value.slice(head.length);
    if (!tok) return null;
    if (tok.startsWith('#')) {
      const hits = relayKnownChannels.filter(c => c.toLowerCase().startsWith(tok.toLowerCase()));
      return hits.length === 1 ? head + hits[0] + ' ' : null;
    }
    const bare = tok.replace(/^@/, '');
    if (bare) {
      const hits = rosterUsers.map(u => u.nick).filter(n => n.toLowerCase().startsWith(bare.toLowerCase()));
      if (hits.length === 1) return head + '@' + hits[0] + ' ';
    }
    return null;
  }
  function relayOnType(): void {
    if (!relay || relayTypingThrottle) return;  // throttle to ≤1 typing ping / 2s
    relay.typing();
    relayTypingThrottle = setTimeout(() => { relayTypingThrottle = null; }, 2000);
  }

  function idleStatus(): void {
    const running = runningCount();
    const bits = ['ready', gpuTag, running > 0 ? `${running} job${running > 1 ? 's' : ''}` : '']
      .filter(Boolean).join(' · ');
    surface.setStatus(bits);
  }

  // ── AitherSense affect poller + AitherVoice (opt-in) + portrait art ──
  // Both ride the SAME auth as the main client: local → direct perception ports
  // (internal CA), remote → the gateway origin carrying the aither_sk key.
  const affectEp = resolveServiceEndpoint(config, 'affect');
  const voiceEp = resolveServiceEndpoint(config, 'voice');
  const affectPoller = new AffectPoller({ baseUrl: affectEp.baseUrl, headers: affectEp.headers });
  affectPoller.start();
  const voice = new VoiceController({ baseUrl: voiceEp.baseUrl, fallbackUrl: voiceEp.fallbackUrl, headers: voiceEp.headers });
  // Drive the desktop overlay's mouth from the SAME amplitude envelope the docked pane
  // uses, so the two avatars never disagree. Without this Persona only ever saw the coarse
  // speaking/idle state and flapped on a generic loop while real speech played.
  voice.setLevelSink(personaLevel);
  // Voice settings persist in the shared ~/.aither/config.json (same file the
  // /grid command uses) under a `voice` key: { speed, voice }.
  const aitherConfigPath = join(homedir(), '.aither', 'config.json');
  function readAitherConfig(): Record<string, any> {
    try { if (existsSync(aitherConfigPath)) return JSON.parse(readFileSync(aitherConfigPath, 'utf-8')); } catch { /* */ }
    return {};
  }
  function saveVoiceSettings(): void {
    try {
      const cfg = readAitherConfig();
      cfg.voice = { ...(cfg.voice || {}), speed: voice.getSpeed(), voice: voice.getVoice() };
      mkdirSync(join(homedir(), '.aither'), { recursive: true });
      writeFileSync(aitherConfigPath, JSON.stringify(cfg, null, 2), 'utf-8');
    } catch { /* persistence is best-effort — never break the REPL */ }
  }
  {
    const saved = readAitherConfig().voice;
    if (saved && typeof saved.speed === 'number') voice.setSpeed(saved.speed);
    if (saved && typeof saved.voice === 'string' && saved.voice) voice.setVoice(saved.voice);
  }
  affectPoller.onUpdate((a) => {
    voice.setAffect({ valence: a.valence, arousal: a.arousal });
    // React the docked avatar to Aither's mood: swap to the matching emotion clip when it changes.
    try {
      updateAvatarEmotion(emotionFromAffect({
        valence: a.valence, arousal: a.arousal, mood: a.mood, dominant_sensation: a.dominantSensation,
      }));
    } catch { /* avatar is best-effort; never let it break the poll */ }
  });
  // Idle heartbeat: between turns, keep Aither alive — blinking/breathing when
  // idle, mouth moving while she speaks. Gated so it never fights the live turn
  // ticker (renderIdleFrame no-ops while that's active) or overlays/pickers.
  const idleTimer = setInterval(() => {
    try {
      if (processing || surface.pickerOpen()) return;
      currentRenderer?.renderIdleFrame?.(voice.isSpeaking() ? 'talking' : 'idle');
    } catch { /* */ }
  }, 320);
  // Portrait frames live in assets/<name>-portrait/. A "character" is that name
  // (aither, bunny, …). Resolution order: env override > persisted /avatar choice
  // (~/.aither/config.json "avatar") > default 'aither'. Switchable live via
  // `/avatar <name>` — no env var needed. renderPortrait() → null on empty dir → ASCII.
  const assetsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
  const avatarDirOf = (name: string): string => join(assetsRoot, `${name}-portrait`);
  function listAvatars(): string[] {
    try {
      return readdirSync(assetsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.endsWith('-portrait'))
        .map(d => d.name.replace(/-portrait$/, '')).sort();
    } catch { return []; }
  }
  function saveAvatarChoice(name: string): void {
    try {
      const cfg = readAitherConfig(); cfg.avatar = name;
      mkdirSync(join(homedir(), '.aither'), { recursive: true });
      writeFileSync(aitherConfigPath, JSON.stringify(cfg, null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }
  let portraitDir = process.env.AITHER_PORTRAIT_DIR || (() => {
    const saved = readAitherConfig().avatar;
    return (typeof saved === 'string' && saved && existsSync(avatarDirOf(saved)))
      ? avatarDirOf(saved) : avatarDirOf('aither');
  })();
  let currentRenderer: StreamRenderer | null = null;

  /** Map the poller's Affect (camelCase) to the avatar's Affect shape. */
  function avatarAffect() {
    const af = affectPoller.current();
    return af ? { valence: af.valence, arousal: af.arousal, mood: af.mood, dominant_sensation: af.dominantSensation } : null;
  }

  let avatarPaneOn = false;
  let lastStatusInfo: StatusInfo | null = null;

  /** Re-probe the fleet and repaint the persistent status bar (silent — never dumps
   *  into the chat pane). Called at startup and on a bar click. */
  function refreshStatusBar(): void {
    void gatherStatus(client, config).then((info) => {
      lastStatusInfo = info;
      surface.setStatusBar(formatStatusBar(info));
    }).catch(() => { /* status bar is best-effort */ });
  }

  /** Build overlay lines from the live buffers and open the full-screen viewer. */
  async function openOverlay(kind: 'flame' | 'neurons' | 'reasoning' | 'affect' | 'portrait' | 'graph' | 'sessions' | 'room'): Promise<void> {
    const w = Math.max(30, (process.stdout.columns || 100) - 6);
    let title = ''; let lines: string[] = [];

    // Special case: sessions view with live polling
    if (kind === 'sessions') {
      let pollInterval: ReturnType<typeof setInterval> | null = null;
      let lastError: string | null = null;

      async function renderSessions(): Promise<string[]> {
        try {
          const sessions = await fetchUnifiedSessions();
          lastError = null;
          return buildSessionsPanel(sessions, w);
        } catch (e: any) {
          const msg = e instanceof Error ? e.message : String(e);
          lastError = msg;
          // Check if it's a daemon-down error
          if (/no harness token|fetch failed|ECONNREFUSED/i.test(msg)) {
            return [
              chalk.red('Sessions — daemon not reachable'),
              chalk.dim('  start it with:  adk harness serve'),
              '',
              chalk.dim('  Ctrl+S to retry'),
            ];
          }
          return [chalk.red(`sessions error: ${msg}`)];
        }
      }

      // Render once, then set up polling
      lines = await renderSessions();

      // Set up polling: refresh every 2 seconds while viewer is open
      pollInterval = setInterval(async () => {
        try {
          lines = await renderSessions();
          surface.updateViewer?.(lines);
        } catch {
          // Poll errors are silent — don't spam the display
        }
      }, 2000);

      try {
        await surface.showViewer(title || 'Sessions (Ctrl+S)', lines);
      } finally {
        // Clean up poll interval when viewer closes
        if (pollInterval) clearInterval(pollInterval);
      }

      return;
    }

    // Special case: room view with live polling
    if (kind === 'room') {
      let pollInterval: ReturnType<typeof setInterval> | null = null;
      let lastError: string | null = null;
      // 'main' is the daemon's default room and the one every producer publishes
      // to (AeonEmit, the transcript bridge, the hook spool, the kernel tick). This
      // said 'default', which no producer ever writes to, so the panel rendered
      // "room not found" forever against a working daemon.
      const roomId = process.env.AITHER_AEON_ROOM || 'main';

      async function renderRoom(): Promise<string[]> {
        // fetchRoomSnapshot never throws — it returns ok=false with a reason, and
        // buildRoomPanel renders that as a visible DEGRADED banner. A room that is
        // unreachable and a room that is quiet must never look the same.
        const snapshot = await fetchRoomSnapshot(roomId);
        lastError = snapshot.ok ? null : snapshot.reason;
        return buildRoomPanel(snapshot, w);
      }

      // Render once, then set up polling
      lines = await renderRoom();

      // Set up polling: refresh every 2 seconds while viewer is open
      pollInterval = setInterval(async () => {
        try {
          lines = await renderRoom();
          surface.updateViewer?.(lines);
        } catch {
          // Poll errors are silent — don't spam the display
        }
      }, 2000);

      try {
        await surface.showViewer(title || `Room (Ctrl+U) · ${roomId}`, lines);
      } finally {
        // Clean up poll interval when viewer closes
        if (pollInterval) clearInterval(pollInterval);
      }

      return;
    }

    try {
      if (kind === 'affect') { title = 'AitherSense (Ctrl+A)'; lines = buildAffectPanel(affectPoller.current(), w); }
      else if (kind === 'flame') { title = 'Context Flame Graph (Ctrl+F)'; lines = buildFlameGraph(currentRenderer?.getFlameData?.() ?? null, w); }
      else if (kind === 'neurons') { title = 'Neuron Activity (Ctrl+N)'; lines = buildNeuronPanel(currentRenderer?.getNeuronState?.() ?? emptyNeuronState(), w); }
      else if (kind === 'reasoning') { title = 'Reasoning Stream (Ctrl+R)'; lines = buildReasoningPanel(currentRenderer?.getThoughts?.() ?? [], w); }
      else if (kind === 'graph') { title = 'Knowledge Graph (Ctrl+K)'; lines = buildKnowledgeGraph(currentRenderer?.getKnowledgeGraph?.() ?? null, w); }
      else if (kind === 'portrait') {
        // Dock Aither INLINE (truecolor raw-paint corner) rather than taking over the
        // whole terminal — Ctrl+P is a toggle: press again to hide her. Wider than the
        // /avatar corner so she reads clearly while you keep chatting.
        if (avatarPaneOn) { hideAvatar('portrait hidden'); return; }
        const c = Math.max(20, Math.min(40, Math.floor((process.stdout.columns || 100) * 0.3)));
        dockAvatar(c, 'portrait docked — Aither animates while you chat · Ctrl+P to hide');
        return;
      }
    } catch (e: any) { lines = [chalk.red('overlay error: ' + (e?.message || e))]; }
    void surface.showViewer(title, lines);
  }

  /** One-line snapshot of the live voice settings. */
  function voiceSettingsLine(): string {
    return chalk.dim(`  ♪ voice: ${voice.getVoice()} · speed ${voice.getSpeed().toFixed(2)}× · ${voice.isEnabled() ? 'on' : 'off'}`);
  }

  /**
   * /voice [on|off|status|speed <0.25–4>|faster|slower|<voice-name>]
   * Toggle speaking answers aloud via AitherVoice + tune how fast she talks.
   * Speed and voice persist across sessions (~/.aither/config.json).
   */
  async function toggleVoice(arg: string): Promise<void> {
    const parts = arg.trim().split(/\s+/).filter(Boolean);
    const a = (parts[0] || '').toLowerCase();
    if (a === 'off') { voice.disable(); surface.outputLine(chalk.dim('  voice off')); return; }
    if (a === 'status' || a === 'settings') { surface.outputLine(voiceSettingsLine()); return; }
    if (a === 'speed' || a === 'rate') {
      const n = parseFloat(parts[1] || '');
      if (!isFinite(n)) {
        surface.outputLine(voiceSettingsLine());
        surface.outputLine(chalk.dim('  usage: /voice speed <0.25–4>   (1 = normal · try 1.5) · also /voice faster · /voice slower'));
        return;
      }
      voice.setSpeed(n); saveVoiceSettings();
      surface.outputLine(chalk.cyan(`  ♪ speed ${voice.getSpeed().toFixed(2)}×`) + chalk.dim(' — saved'));
      return;
    }
    if (a === 'faster' || a === 'slower') {
      voice.setSpeed(voice.getSpeed() + (a === 'faster' ? 0.25 : -0.25)); saveVoiceSettings();
      surface.outputLine(chalk.cyan(`  ♪ speed ${voice.getSpeed().toFixed(2)}×`) + chalk.dim(' — saved'));
      return;
    }
    if (a && a !== 'on') { voice.setVoice(parts[0]); saveVoiceSettings(); }   // /voice <name> selects a voice + enables
    surface.setStatus('checking AitherVoice…');
    const ok = await voice.available();
    idleStatus();
    if (!ok) {
      surface.outputLine(chalk.yellow(`  voice unavailable — AitherVoice not reachable at ${voiceEp.baseUrl}`));
      return;
    }
    voice.enable();
    voice.setAffect(avatarAffect());
    surface.outputLine(chalk.cyan('  ♪ voice on') +
      chalk.dim(` — voice ${voice.getVoice()} · speed ${voice.getSpeed().toFixed(2)}×. "/voice speed <n>" to tune · "/voice off" to stop.`));
  }

  /** Load a directory of `frame_NN.png` into rendered frames, or [] if the dir is absent/empty. */
  function loadFrameDir(dir: string, cols: number): string[][] {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(f => /^frame_\d+\.png$/i.test(f)).sort();
    return files.map(f => renderPngFile(join(dir, f), cols)).filter((x): x is string[] => !!x);
  }

  /** Load Aither's animation frames at a given width for the docked pane. When an `emotion` is
   *  given and `<portraitDir>/<emotion>/` holds a frame sequence, play THAT clip (the motion
   *  library we rendered per emotion); otherwise fall back to the idle breathing loop, then to
   *  expression stills. Frames are padded to a common height so the painted region stays
   *  rectangular. */
  /** Pad every frame to a common height so the raw-painted region stays rectangular. */
  function padFrames(frames: string[][], cols: number): string[][] {
    if (!frames.length) return frames;
    const h = Math.max(...frames.map(f => f.length));
    for (const f of frames) while (f.length < h) f.push(' '.repeat(cols));
    return frames;
  }

  /** Pad TWO frame sets (idle/emotion + talk) to ONE shared height. The pane swaps between them, and
   *  `paintAvatar` only erases the current frame's rows — so if the sets differed in height the taller
   *  set would leave un-erased ghost rows on swap. For char-5 they're equal, but this guarantees it for
   *  any future character whose talk and emotion clips have different frame dimensions. */
  function reconcileHeights(a: string[][], b: string[][], cols: number): void {
    const h = Math.max(0, ...a.map(f => f.length), ...b.map(f => f.length));
    for (const set of [a, b]) for (const f of set) while (f.length < h) f.push(' '.repeat(cols));
  }

  function loadAvatarFrames(cols: number, emotion?: string): string[][] {
    let frames: string[][] = [];
    if (emotion && emotion !== 'neutral') {
      frames = loadFrameDir(join(portraitDir, emotion), cols);
    }
    if (!frames.length) frames = loadFrameDir(join(portraitDir, 'idle'), cols);
    if (!frames.length) {
      frames = ['neutral', 'happy', 'curious', 'angry']
        .map(e => renderPortrait(portraitDir, e, { cols }))
        .filter((f): f is string[] => Array.isArray(f) && f.length > 0);
    }
    return padFrames(frames, cols);
  }

  /** Load the mouth-sync sequence for the pane: `<portraitDir>/<emotion>-talk-N.png` (falls back to
   *  the generic `neutral-talk-N.png`). Played WHILE Aither is talking so the mouth actually moves. */
  function loadTalkFrames(cols: number, emotion?: string): string[][] {
    const collect = (name: string): string[][] => {
      const out: string[][] = [];
      for (let i = 0; i < 16; i++) {
        const p = join(portraitDir, `${name}-talk-${i}.png`);
        if (!existsSync(p)) break;
        const r = renderPngFile(p, cols);
        if (r) out.push(r);
      }
      return out;
    };
    let frames = emotion ? collect(emotion) : [];
    if (frames.length < 2) frames = collect('neutral');
    return padFrames(frames, cols);
  }

  // The emotion whose clip the docked pane is currently playing — so we only reload frames when
  // the affect actually changes (reloading every 2.5s poll would thrash the terminal).
  let avatarEmotion = 'neutral';
  let avatarCols = 18;
  // Timestamp of the last streamed answer token. Drives the mouth WITHOUT needing TTS: the avatar
  // lip-syncs to the text stream. Bumped in the streamChat loop; a short window means the mouth
  // closes ~0.45s after tokens stop (between tool calls / at end of turn) rather than flapping on.
  let lastAnswerTokenAt = 0;
  const TALK_WINDOW_MS = 450;
  /** Is Aither talking right now? In VOICE mode the answer body is buffered and revealed WITH audio,
   *  so the mouth must follow the audio (not the hidden token stream) — mirrors the controller's own
   *  `suppressBody ? isSpeaking : sawToken` rule. In text mode, lip-sync to the live token stream. */
  function isTalkingNow(): boolean {
    if (voice.isEnabled()) return voice.isSpeaking();
    return Date.now() - lastAnswerTokenAt < TALK_WINDOW_MS;
  }

  /** Dock the truecolor avatar pane at `cols` wide. Status goes to the transient
   *  bottom strip — NOT the chat pane, which is for conversation only. */
  function dockAvatar(requested: number, msg: string): void {
    // The avatar is painted RAW over the terminal's right edge — the trace pane's own
    // columns — so a width the layout has not reserved silently overwrites trace text.
    // That interleaving is what a corrupted-looking TUI actually was.
    const room = surface.maxAvatarCols?.() ?? requested;
    if (room < 8) { surface.setStatus('terminal too narrow for the avatar pane'); return; }
    const cols = Math.max(8, Math.min(requested, room));
    avatarCols = cols;
    avatarEmotion = emotionFromAffect(avatarAffect() ?? undefined) || 'neutral';
    const frames = loadAvatarFrames(cols, avatarEmotion);
    if (!frames.length) {
      surface.setStatus('no portrait art — add PNG frames to assets/aither-portrait/idle/'); return;
    }
    const talk = loadTalkFrames(cols, avatarEmotion);
    reconcileHeights(frames, talk, cols);
    if (cols < requested) msg += ` (${cols} cols — trace pane keeps the rest)`;
    avatarPaneOn = surface.setAvatarPane(frames, { isSpeaking: isTalkingNow, talkFrames: talk });
    surface.setStatus(avatarPaneOn ? '▓ ' + msg : 'avatar pane could not start');
  }

  /** Swap the docked pane to the clip for `emotion` (only when the pane is on and the emotion
   *  actually changed). Called from the affect poller so the avatar reacts to Aither's mood. */
  function updateAvatarEmotion(emotion: string): void {
    if (!avatarPaneOn) return;
    const e = emotion || 'neutral';
    if (e === avatarEmotion) return;
    const frames = loadAvatarFrames(avatarCols, e);
    if (!frames.length) return;
    avatarEmotion = e;
    const talk = loadTalkFrames(avatarCols, e);
    reconcileHeights(frames, talk, avatarCols);
    surface.setAvatarPane(frames, { isSpeaking: isTalkingNow, talkFrames: talk });
    personaEmotion(e);
  }

  /** Hide the docked pane (status to the transient bottom strip). */
  function hideAvatar(msg = 'avatar hidden'): void {
    surface.setAvatarPane(null); avatarPaneOn = false;
    surface.setStatus(msg);
  }

  /** /avatar [on|off|show|hide|toggle|list|<name>] — toggle / SELECT the top-right animated
   *  pane. `/avatar list` shows the roster; `/avatar bunny` switches character live and
   *  persists it (no env var). Ctrl+P docks a wider version of the same pane. */
  function toggleAvatarPane(arg: string): void {
    const a = arg.trim();
    const low = a.toLowerCase();
    const cols = Math.max(14, Math.min(24, Math.floor((process.stdout.columns || 100) / 5)));
    const current = (): string =>
      portraitDir.replace(/[/\\]+$/, '').split(/[/\\]/).pop()!.replace(/-portrait$/, '');

    if (low === 'off' || low === 'hide') { hideAvatar(); return; }
    if (low === 'toggle') {
      if (avatarPaneOn) { hideAvatar(); return; }
      dockAvatar(cols, `avatar on (${current()}) — /avatar list to see all · /avatar off to hide.`);
      return;
    }
    if (low === 'list' || low === 'ls' || low === '?') {
      const names = listAvatars(); const cur = current();
      surface.outputLine(chalk.cyan('Avatars: ')
        + (names.map(n => n === cur ? chalk.green(`${n} ◀`) : n).join(chalk.dim(' · ')) || chalk.dim('(none)'))
        + chalk.dim('   — /avatar <name> to switch'));
      return;
    }
    if (a && low !== 'on' && low !== 'show') {
      // Treat the arg as a character name.
      if (!existsSync(avatarDirOf(low))) {
        // The transient status strip, NOT the chat pane — an error about a typo is not
        // part of the conversation, and printing it there corrupts the transcript.
        surface.setStatus(`unknown avatar "${a}" — available: ${listAvatars().join(', ') || '(none)'}`);
        return;
      }
      portraitDir = avatarDirOf(low); saveAvatarChoice(low);
      if (avatarPaneOn) hideAvatar();
      dockAvatar(cols, `avatar → ${low} — animates top-right while you chat. /avatar off to hide.`);
      return;
    }
    // bare /avatar toggles off if already on; an explicit `show`/`on` always docks.
    if (avatarPaneOn && low !== 'on' && low !== 'show') { hideAvatar(); return; }
    dockAvatar(cols, `avatar on (${current()}) — /avatar list to see all · /avatar off to hide.`);
  }

  const surface: TuiSurface = createTuiScreen({
    title: 'AitherShell',
    onSubmit: (line) => { void onSubmit(line); },
    onOverlay: openOverlay,
    onStatusAction: (key) => {
      // Click a bar segment: brand → command palette; Aither → toggle inline portrait;
      // node/models/fabric → pop the full detail in a viewer (NOT the chat pane) + refresh.
      if (key === 'brand') { void openPicker(); return; }
      if (key === 'portrait') { openOverlay('portrait'); return; }
      if (lastStatusInfo) void surface.showViewer('⬢ FLEET STATUS', formatStatusLines(lastStatusInfo));
      refreshStatusBar();
    },
    onInterrupt: () => onInterrupt(),
    onHistory: (dir) => {
      if (!history.length) return null;
      if (dir === 'up') histIdx = Math.max(0, histIdx - 1);
      else histIdx = Math.min(history.length, histIdx + 1);
      return histIdx >= history.length ? '' : history[histIdx];
    },
    onTab: (value) => {
      if (!value) return null;
      if (relay) { const r = relayComplete(value); if (r != null) return r; }
      const [hits] = complete(value);
      if (!hits || !hits.length) return null;
      if (hits.length === 1) return hits[0];
      // Multiple: show options, complete to longest common prefix.
      surface.traceLine(chalk.dim('  ⇥ ' + hits.slice(0, 12).join('  ')));
      let lcp = hits[0];
      for (const h of hits) { while (!h.startsWith(lcp)) lcp = lcp.slice(0, -1); }
      return lcp || null;
    },
    onSlash: () => { void openPicker(); },
    onType: () => relayOnType(),
    onScrollTop: () => { void relayLoadOlder(); },
  });

  // Tell the global crash reporter the TUI owns the terminal: stray async
  // rejections become non-fatal + silent, and a real uncaught crash restores
  // the terminal (surface.destroy) before printing the report.
  setTuiActive(() => { try { surface.destroy(); } catch { /* */ } });

  // ── Start background jobs listener (persistent SSE) ──
  const parentAbort = new AbortController();
  jobsListener = new BackgroundJobsListener({
    client,
    sessionId: config.sessionId,
    abortSignal: parentAbort.signal,
  });
  jobsListener.onEvent((event) => {
    try {
      switch (event.type) {
        case 'job_started': {
          const id8 = event.job_id.slice(0, 8);
          surface.traceLine(chalk.cyan(`🚀 job ${id8} started: ${event.label}`));
          break;
        }
        case 'job_update': {
          const id8 = event.job_id.slice(0, 8);
          surface.traceLine(chalk.cyan(`⚙ job ${id8}: ${event.stage || event.status}`));
          break;
        }
        case 'job_gate': {
          const id8 = event.job_id.slice(0, 8);
          surface.traceLine(chalk.yellow(`🚦 job ${id8} NEEDS INPUT: ${event.question}`));
          surface.traceLine(chalk.dim(`   reply with: /steer ${id8} <answer>`));
          break;
        }
        case 'job_done': {
          const id8 = event.job_id.slice(0, 8);
          if (event.status === 'completed') {
            const summary = event.result_summary ? event.result_summary.slice(0, 200) : '';
            surface.traceLine(chalk.green(`✅ job ${id8} done`) + (summary ? ` — ${summary}` : ''));
            if (summary && processing) {
              // Queue the output until the turn ends
              pendingJobOutput.push({ jobId: event.job_id, content: summary });
            } else if (summary) {
              surface.outputLine(chalk.dim(summary));
            }
          } else {
            const error = event.error || 'unknown error';
            surface.traceLine(chalk.red(`❌ job ${id8} FAILED — ${error}`));
            surface.outputLine(chalk.red(`  Job ${id8} failed: ${error}`));
          }
          break;
        }
        case 'chat_refinement': {
          // The grounded pipeline was DETACHED from the turn (the turn ends when
          // the answer is final). It finished, and it did MATERIAL work — tools
          // fired or artifacts landed — so it sends the delta here.
          //
          // Render it as a DISTINCT APPENDED BLOCK. It must never look like, or
          // act as, a rewrite of the answer the user already read: that in-place
          // supersede was the "it replaces what it said instead of continuing"
          // bug. The turn is closed; this can only ever add.
          const text = (event.text || '').trim();
          const arts = event.artifacts || [];
          if (!text && !arts.length) break;
          const why = event.reason ? ` · ${event.reason}` : '';
          const emit = () => {
            surface.outputLine(chalk.dim('╭─ ') + chalk.magenta('↻ refined') + chalk.dim(why));
            if (text) surface.outputLine(text);
            for (const a of arts) {
              const name = a?.name || a?.file_path || a?.url || 'artifact';
              surface.outputLine(chalk.cyan(`  📎 ${name}`));
            }
            surface.outputLine(chalk.dim('╰─'));
          };
          // Don't interleave into a turn that's mid-stream — queue it like job output.
          if (processing) pendingJobOutput.push({ jobId: 'refine', content: `↻ refined${why}\n${text}` });
          else emit();
          break;
        }
      }
    } catch (err: any) {
      // Silent — listener faults never crash the TUI
      process.stderr.write(`[jobs-listener] render error: ${err?.message}\n`);
    }
  });
  jobsListener.start();

  // ── Background-job completion notifications → OUTPUT pane ──
  setJobNotifier((job: Job) => {
    const icon = job.status === 'completed' ? chalk.green('✓') : job.status === 'failed' ? chalk.red('✗') : chalk.yellow('—');
    const color = job.status === 'completed' ? chalk.green : job.status === 'failed' ? chalk.red : chalk.yellow;
    surface.outputLine(`${icon} Job ${chalk.bold('#' + job.id)} ${color(job.status)}: ${job.label}`);
    if (job.status === 'completed' && job.output.length) {
      const sepIdx = job.output.indexOf('---');
      const lines = sepIdx >= 0 ? job.output.slice(sepIdx + 1) : job.output.filter(l => !l.startsWith('['));
      const text = lines.join('\n').trim();
      if (text) {
        if (text.length <= 800) surface.outputLine(chalk.dim(text));
        else surface.outputLine(chalk.dim(text.split('\n').slice(0, 6).join('\n') + `\n  … (/jobs ${job.id} for full)`));
      }
    } else if (job.status === 'failed' && job.error) {
      surface.outputLine(chalk.red('  ' + job.error));
    }
    idleStatus();
  });

  // ── GPU status poll (10s) ──
  const gpuTimer = setInterval(async () => {
    try {
      const st = await client.getGpuStatus();
      const zone = st?.zone || '';
      gpuTag = zone.includes('image') ? chalk.yellow('GPU:3D') : st?.active ? chalk.cyan('GPU:R') : '';
      if (!processing) idleStatus();
    } catch { /* */ }
  }, 10_000);
  void gpuTimer;

  // ── Register shell session (best-effort) ──
  client.post('/shell/session/start', {
    client_type: 'ts-shell', session_id: config.sessionId,
    username: config.authUser?.username, user_id: config.authUser?.id,
  }).catch(() => {});

  // ── Resume previous conversation (--continue/--resume) ──
  let seededContext: string | null = null;
  if (config.resumed) {
    const entry = loadSession(config.sessionId);
    if (entry?.messages.length) seededContext = buildContextSummary(entry.messages);
  }

  // ── Welcome ── gradient wordmark + one compact subtitle. The full keymap and the
  //    live-view shortcuts live under `?` so the boot screen stays quiet (sci-fi HUD,
  //    not a wall of legend lines).
  const welcomeHost = (() => { try { return new URL(config.genesisUrl).host; } catch { return config.genesisUrl; } })();
  const resumedMsg = config.resumed
    ? `↩ resumed ${config.sessionId.slice(0, 8)} · ${loadSession(config.sessionId)?.messages.length || 0} msgs`
    : undefined;
  for (const line of formatWelcomeHeader({
    host: welcomeHost,
    user: config.authUser?.display_name || config.authUser?.username,
    resumedMsg,
  })) surface.outputLine(line);
  idleStatus();
  surface.focusInput();

  // Live fleet/backend status paints into the PERSISTENT top bar (not the chat pane),
  // so it never bleeds into the conversation. Fetched async so the prompt stays usable;
  // the bar fills in a moment later. Click a segment for the full detail popup.
  refreshStatusBar();

  function onInterrupt(): void {
    if (activeAbort) {
      activeAbort.abort(); activeAbort = null; surface.setStatus('aborted'); surface.focusInput(); return;
    }
    sigintCount++;
    if (sigintCount >= 2) {
      const q = queuedInputs.length;
      setTuiActive(null);
      try { jobsListener?.close(); } catch { /* */ }
      try { affectPoller.stop(); voice.disable(); clearInterval(idleTimer); } catch { /* */ }
      parentAbort.abort();
      surface.destroy();
      // Write AFTER destroy so it lands in the restored terminal, not the
      // torn-down blessed screen — otherwise the user never sees it.
      if (q) process.stderr.write(`\n⚠ Discarded ${q} queued message(s).\n`);
      process.exit(0);
    }
    surface.setStatus('Ctrl+C again to exit');
    if (sigintTimer) clearTimeout(sigintTimer);
    sigintTimer = setTimeout(() => { sigintCount = 0; idleStatus(); }, 2000);
  }

  // ── Command picker (native blessed list) ──
  function buildPickerItems(): PickerItem[] {
    const names = getCommandNames();
    const dyn = registry.allCommands().map((c: any) => c.name);
    const all = [...new Set([...names, ...dyn, 'jobs'])];
    const categories: [string, string[]][] = [
      ['System', ['status', 'services', 'agents', 'logs', 'model', 'metrics']],
      ['Agents', ['forge', 'sessions', 'resume', 'swarm', 'inbox', 'compose', 'monitor', 'notebook']],
      ['Jobs', ['jobs']],
      ['Search', ['search', 'codegraph', 'scope', 'onboard', 'obsidian', 'tools', 'context']],
      ['AI', ['think', 'research', 'memory', 'soul']],
      ['Ops', ['deploy', 'fleet', 'workflow', 'backup', 'benchmark', 'products', 'docker']],
      ['Security', ['security', 'review', 'train', 'tool-scope', 'rbac']],
      ['Automation', ['run', 'script', 'apps', 'gaming', 'routines']],
      ['Auth', ['login', 'register', 'logout', 'whoami']],
      ['Shell', ['help', 'clear', 'config']],
    ];
    const items: PickerItem[] = [];
    const used = new Set<string>();
    for (const [cat, list] of categories) {
      const avail = list.filter(n => all.includes(n));
      if (!avail.length) continue;
      items.push({ label: `── ${cat} ──`, value: '', separator: true });
      for (const n of avail) {
        used.add(n);
        items.push({ label: `/${n}`, value: n, description: getCommand(n)?.description || '' });
      }
    }
    const extra = all.filter(n => !used.has(n) && n !== 'exit' && n !== 'quit');
    if (extra.length) {
      items.push({ label: '── Other ──', value: '', separator: true });
      for (const n of extra) items.push({ label: `/${n}`, value: n, description: getCommand(n)?.description || registry.resolve(n)?.description || '' });
    }
    return items;
  }

  async function openPicker(): Promise<void> {
    const choice = await surface.showPicker('/ commands', buildPickerItems());
    if (!choice) return;
    // Defer to runCommand: when the command has a subcommand table, runCommand's
    // interactive path picks the subcommand AND prompts for its arguments (the
    // blessed overlay can't do text/enum arg entry). Bare invocation and the
    // picker thus share one fully-interactive flow.
    await runCommand('/' + choice);
  }

  async function onSubmit(input: string): Promise<void> {
    sigintCount = 0;
    if (!input) return;
    if (surface.pickerOpen()) return;
    // Same rule as the readline REPL. There are TWO history writers in this
    // package, and a redaction applied to one is not a fix -- it is a leak
    // that now looks handled, on whichever lane the user happens to be in.
    saveHistory(config.historyFile,
                isSecretBearing(input) ? redactForHistory(input) : input);
    history.push(input); histIdx = history.length;

    if (input === 'exit' || input === 'quit' || input === '/exit' || input === '/quit') {
      setTuiActive(null); try { affectPoller.stop(); clearInterval(idleTimer); } catch { /* */ } surface.destroy(); process.exit(0);
    }
    if (input === '?') { showHelp(); return; }
    if (input.startsWith('!')) { runShell(input.slice(1).trim()); return; }

    const explicitBg = input.endsWith(' &');
    const clean = explicitBg ? input.slice(0, -2).trimEnd() : input;

    if (clean === '/voice' || clean.startsWith('/voice ')) { await toggleVoice(clean.slice(6).trim()); return; }
    if (clean === '/avatar' || clean.startsWith('/avatar ')) { toggleAvatarPane(clean.slice(7).trim()); return; }
    if (clean.startsWith('/')) { await runCommand(clean, explicitBg); return; }

    // Relay mode: plain input is a message to the channel (humans + agents see it).
    if (relay) {
      relay.send(clean);
      // Agents don't emit typing while generating, so hint that a reply is coming.
      if (rosterUsers.some(u => u.is_agent)) relayStatus('sent · agents may reply…');
      return;
    }

    // A turn is in flight. cancel/stop/abort interrupt it; anything else is
    // queued and run as a fresh turn the moment this one finishes. (The old
    // fire-and-forget steer was silently dropped on oneshot/trivial turns —
    // which is every plain question — so the message just vanished.)
    if (activeAbort && processing) {
      const lower = clean.toLowerCase();
      if (lower === 'cancel' || lower === 'stop' || lower === '@abort') { onInterrupt(); return; }
      queuedInputs.push(clean);
      surface.traceLine(chalk.cyan(`  ⏳ queued (${queuedInputs.length}) — sends after this turn`));
      return;
    }
    // Bare digit (1-9) → expand to the Nth follow-up suggestion from the last turn.
    const _pick = clean.match(/^([1-9])$/);
    if (_pick) {
      const fups = surface.getPendingFollowups();
      const idx = parseInt(_pick[1], 10) - 1;
      if (idx >= 0 && idx < fups.length) {
        const chosen = fups[idx];
        surface.setPendingFollowups([]);  // consume
        surface.outputLine(chalk.dim(`  → ${chosen}`));
        await runChatDraining(chosen, explicitBg);
        return;
      }
    }
    surface.setPendingFollowups([]);  // any new message invalidates last turn's chips
    await runChatDraining(clean, explicitBg);
  }

  /** Run a chat turn, then drain any messages the user typed while it streamed,
   *  running each as its own turn in order. The `draining` guard keeps two
   *  rapid submits from spinning up overlapping drain loops. */
  async function runChatDraining(input: string, bg = false): Promise<void> {
    const firstErr = await runChat(input, bg);
    if (draining) return;
    // A hard connection/auth failure means the backend is down or we're not signed in.
    // Replaying the rest of the queue can only reproduce the same error N times (the
    // "endless red waterfall" a multi-line paste used to cause), so halt it here and
    // say so once. The user re-sends after /login or when the backend returns.
    if (firstErr && queuedInputs.length) { haltQueue(firstErr); return; }
    draining = true;
    try {
      while (queuedInputs.length && !processing) {
        const next = queuedInputs.shift()!;
        surface.outputLine(chalk.green('› ') + chalk.dim('(queued) ') + next);
        const err = await runChat(next, false);
        if (err && queuedInputs.length) { haltQueue(err); break; }
      }
    } finally {
      draining = false;
    }
  }

  /** Drop every remaining queued message after a hard failure and tell the user once,
   *  with the right next step (sign in vs. wait for the backend). */
  function haltQueue(reason: string): void {
    const n = queuedInputs.length;
    queuedInputs = [];
    surface.outputLine(chalk.yellow('  ' + haltMessage(n, reason)));
    idleStatus(); surface.focusInput();
  }

  function showHelp(): void {
    surface.outputLine(chalk.bold('Keys: ') + chalk.dim('Edit: ←/→ move · Ctrl+A/E line start/end · Ctrl+W del word · Ctrl+U/K kill · Home/End (empty line=scroll) | Panes: wheel/PgUp scroll · Ctrl+←/→ resize split · Ctrl+T trace · Ctrl+E expand all · click thread | Ctrl+C abort/exit · Tab complete'));
    surface.outputLine(chalk.dim('/ picker · /cmd · @agent route · @think/@research deep · ! shell · cmd & background · /jobs · exit'));
    surface.outputLine(chalk.dim('Live views: Ctrl+A sense · Ctrl+F flame · Ctrl+N neurons · Ctrl+R reasoning · Ctrl+K graph · Ctrl+P portrait (docks Aither inline) · /avatar [list|<name>] · /voice'));
    surface.outputLine(chalk.dim('/relay [#channel]  native group chat (humans + agents) · /relay join #x · /relay channels [scope] · scroll up = older · /relay more · /leave'));
    surface.focusInput();
  }

  function runShell(cmd: string): void {
    if (!cmd) { surface.outputLine(chalk.yellow('Usage: !<command> (PowerShell 7)')); return; }
    surface.outputLine(chalk.dim('$ ' + cmd));
    try {
      const out = execSync(`pwsh -NoProfile -c "${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 300_000 });
      if (out) surface.outputLine(out.replace(/\n$/, ''));
    } catch (err: any) {
      if (err.stdout) surface.outputLine(String(err.stdout).replace(/\n$/, ''));
      surface.outputLine(chalk.red(err.status ? `exit ${err.status}` : `Error: ${err.message}`));
    }
    surface.focusInput();
  }

  async function handleJobs(args: string): Promise<void> {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] || '';

    // ── Refresh server jobs cache ──
    const refreshServerJobs = async () => {
      try {
        const result = await client.listExpeditions();
        if (result && !result.error) {
          const exps = result.expeditions || [];
          serverJobs.clear();
          for (const e of exps) serverJobs.set(e.id, e);
        }
      } catch { /* silent — best-effort cache refresh */ }
    };

    // ── Handle /steer and /cancel subcommands ──
    if (sub === 'steer') {
      const idOrPrefix = parts[1];
      const msg = parts.slice(2).join(' ');
      if (!idOrPrefix || !msg) {
        surface.outputLine(chalk.yellow('Usage: /steer <id-or-prefix> <message...>'));
        return;
      }

      // Refresh and resolve ID
      await refreshServerJobs();
      const expIds = Array.from(serverJobs.values()).map(e => e);
      const resolved = resolveServerJobId(idOrPrefix, expIds);
      if (!resolved) {
        surface.outputLine(chalk.red(`  Expedition not found or ambiguous: ${idOrPrefix}`));
        return;
      }

      // Fetch status to check for blocking gates
      const status = await client.getExpeditionStatus(resolved);
      if (status?.error) {
        surface.outputLine(chalk.red(`  Failed to get expedition status: ${status.error}`));
        return;
      }

      // Respond to first blocking gate if present
      const gates: BlockingGate[] = status.blocking_gates || [];
      if (gates.length > 0) {
        const gate = gates[0];
        const gateResp = await client.postDetailed(
          `/expedition/${resolved}/gates/${gate.id}/respond`,
          { approved: true, response: msg },
        );
        if (gateResp?.error) {
          surface.outputLine(chalk.yellow(`  Gate response: ${gateResp.error}`));
        } else {
          surface.outputLine(chalk.green(`  ✓ Responded to gate ${gate.id}`));
        }
      }

      // Steer the expedition
      const r = await client.steerExpedition(resolved, msg);
      if (r?.error) {
        surface.outputLine(chalk.red(`  Steer failed: ${r.error}`));
      } else {
        surface.outputLine(chalk.green(`  ✓ Expedition steered`));
      }
      return;
    }

    if (sub === 'cancel') {
      const idOrPrefix = parts[1];
      if (!idOrPrefix) {
        surface.outputLine(chalk.yellow('Usage: /cancel <id-or-prefix>'));
        return;
      }

      // Try local job first
      const localId = Number(idOrPrefix);
      if (localId > 0) {
        if (cancelJob(localId)) {
          surface.outputLine(chalk.green(`  ✓ Job #${localId} cancelled`));
          idleStatus();
          return;
        }
      }

      // Try server job
      await refreshServerJobs();
      const expIds = Array.from(serverJobs.values()).map(e => e);
      const resolved = resolveServerJobId(idOrPrefix, expIds);
      if (!resolved) {
        surface.outputLine(chalk.red(`  Job not found: ${idOrPrefix}`));
        return;
      }

      // Cancel the expedition
      const r = await client.postDetailed(`/expedition/${resolved}/cancel`, {});
      if (r?.error) {
        surface.outputLine(chalk.red(`  Cancel failed: ${r.error}`));
      } else {
        surface.outputLine(chalk.green(`  ✓ Expedition cancelled`));
      }
      return;
    }

    // ── Show merged jobs list (default or no args) ──
    if (!sub || sub.toLowerCase() === 'list' || sub.toLowerCase() === 'all') {
      await refreshServerJobs();

      const localJobs = listJobs();
      const serverJobList = Array.from(serverJobs.values());

      // Merge and sort by creation time (recent first)
      const allJobs: Array<{ kind: 'local' | 'server'; obj: any }> = [
        ...localJobs.map(j => ({ kind: 'local' as const, obj: j })),
        ...serverJobList.map(e => ({ kind: 'server' as const, obj: e })),
      ];

      if (allJobs.length === 0) {
        surface.outputLine(chalk.dim('  No background jobs.'));
        return;
      }

      surface.outputLine(chalk.bold('  Background Jobs (Local & Server)'));
      for (const job of allJobs.slice(0, 15)) {
        if (job.kind === 'local') {
          surface.outputLine(formatJobLine(job.obj));
        } else {
          surface.outputLine(formatServerJobLine(job.obj));
        }
      }
      surface.outputLine(
        chalk.dim('  /jobs <id> details · /steer <id> <msg> · /cancel <id>'),
      );
      return;
    }

    // ── Show job detail (numeric local id or server id prefix) ──
    const localId = Number(sub);
    if (localId > 0) {
      const job = getJob(localId);
      if (job) {
        surface.outputLine(formatJobOutput(job));
        return;
      }
    }

    // Try server job
    await refreshServerJobs();
    const expIds = Array.from(serverJobs.values()).map(e => e);
    const resolved = resolveServerJobId(sub, expIds);
    if (resolved) {
      const exp = serverJobs.get(resolved);
      if (exp) {
        surface.outputLine(chalk.bold(`\n  Expedition ${resolved.slice(0, 8)}`));
        surface.outputLine(chalk.dim(`  Title: ${exp.title || '(untitled)'}`));
        surface.outputLine(chalk.dim(`  Status: ${exp.status}`));
        surface.outputLine(chalk.dim(`  Owner: ${exp.owner}`));
        surface.outputLine(chalk.dim(`  Created: ${new Date(exp.created_at).toLocaleString()}`));

        if (exp.result_summary) {
          surface.outputLine(chalk.dim(`  Result:`));
          surface.outputLine(chalk.dim(`    ${exp.result_summary.split('\n').slice(0, 3).join('\n    ')}`));
        }

        // Fetch full status for gates and activity
        const status = await client.getExpeditionStatus(resolved);
        if (status && !status.error) {
          const gates: BlockingGate[] = status.blocking_gates || [];
          if (gates.length > 0) {
            surface.outputLine(chalk.yellow(`\n  Blocking Gates:`));
            for (const g of gates) {
              surface.outputLine(chalk.dim(`    ${g.id}: ${g.description || g.question || '?'}`));
            }
          }

          const activity = status.recent_activity || [];
          if (activity.length > 0) {
            surface.outputLine(chalk.dim(`\n  Recent Activity:`));
            for (const a of activity.slice(0, 3)) {
              surface.outputLine(chalk.dim(`    ${a}`));
            }
          }
        }
        surface.outputLine('');
        return;
      }
    }

    surface.outputLine(chalk.yellow(`  Job not found: ${sub}`));
  }

  // ── Relay (native AitherRelay group chat — humans + agents in a channel) ──
  function relayMentionsMe(content: string): boolean {
    if (!relay) return false;
    const n = relay.nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w])@?${n}\\b`, 'i').test(content || '');
  }
  function formatRelayMsg(m: RelayMessage): string {
    let time = '';
    try {
      const t = typeof m.timestamp === 'number'
        ? new Date(m.timestamp > 1e12 ? m.timestamp : m.timestamp * 1000)
        : (m.timestamp ? new Date(m.timestamp) : null);
      if (t && !isNaN(t.getTime())) time = chalk.dim(t.toTimeString().slice(0, 5) + ' ');
    } catch { /* */ }
    const self = !!relay && m.nick === relay.nick;
    const who = m.agent ? chalk.magenta(`@${m.nick}`) : (self ? chalk.green(m.nick) : chalk.cyan(m.nick));
    const line = `${time}${who}: ${m.content}`;
    // Highlight messages that mention you (not your own).
    return (!self && relayMentionsMe(m.content)) ? chalk.yellow('★ ') + line : line;
  }

  function renderRoster(channel: string): void {
    const humans = rosterUsers.filter(u => !u.is_agent).map(u => `  ${chalk.cyan(u.nick)}`);
    const agents = rosterUsers.filter(u => u.is_agent).map(u => `  ${chalk.magenta('@' + u.nick)}`);
    const lines: string[] = [];
    if (agents.length) { lines.push(chalk.bold('Agents')); lines.push(...agents, ''); }
    lines.push(chalk.bold(`People (${humans.length})`));
    lines.push(...(humans.length ? humans : [chalk.dim('  (just you)')]));
    surface.setTracePanel(`${channel} · ${rosterUsers.length}`, lines);
  }

  function relayStatus(extra?: string): void {
    if (!relay) return;
    const unread = [...relayUnread.entries()].filter(([, n]) => n > 0)
      .map(([c, n]) => `${c}(${n})`).join(' ');
    surface.setStatus(['📡 relay', relay.currentChannel, unread ? `unread ${unread}` : '', extra].filter(Boolean).join(' · '));
  }

  async function startRelay(initialChannel?: string): Promise<void> {
    if (relay) { surface.outputLine(chalk.yellow('Already in relay — /leave first.')); return; }
    const nick = config.authUser?.username || config.authUser?.display_name || `dev_${Math.floor(Math.random() * 9000 + 1000)}`;
    const client = new RelayClient({
      url: resolveRelayUrl(), token: config.authToken || undefined, nick,
      handlers: {
        onStatus: (s) => relayStatus(s === 'open' ? undefined : s),
        onHistory: (ch, msgs) => {
          relayUnread.delete(ch);
          relayOldestTs = msgs.length
            ? msgs.reduce((min, m) => (String(m.timestamp) < min ? String(m.timestamp) : min), String(msgs[0].timestamp))
            : null;
          surface.clearPanes();
          surface.setOutputLabel(`relay ${ch}`);
          surface.outputLine(chalk.dim(`── ${ch} — last ${msgs.length} message(s) · scroll up for more ──`));
          for (const m of msgs) surface.outputLine(formatRelayMsg(m));
          renderRoster(ch);
          relayStatus();
        },
        onMessage: (m) => {
          // Messages for OTHER joined channels become unread badges, not noise.
          if (relay && m.channel && m.channel !== relay.currentChannel) {
            relayUnread.set(m.channel, (relayUnread.get(m.channel) || 0) + 1);
            relayStatus();
            return;
          }
          surface.outputLine(formatRelayMsg(m));
          relayStatus();  // clears any "agents may reply…" hint once a reply lands
        },
        onJoin: (n, ch, isAgent) => { if (!rosterUsers.some(u => u.nick === n)) rosterUsers.push({ nick: n, is_agent: isAgent }); renderRoster(ch); },
        onPart: (n, ch) => { rosterUsers = rosterUsers.filter(u => u.nick !== n); renderRoster(ch); },
        onUserlist: (ch, users) => { rosterUsers = users; renderRoster(ch); },
        onTyping: (n) => relayStatus(`${n} typing…`),
        onError: (msg) => surface.outputLine(chalk.red(`  relay: ${msg}`)),
      },
    });

    let channel = initialChannel;
    if (!channel) {
      surface.setStatus('📡 relay · loading channels…');
      const channels = await client.listChannels();
      relayKnownChannels = channels.map(c => c.name);
      if (channels.length) {
        const items = channels.map(c => ({ label: c.name + (c.topic ? `  —  ${c.topic}` : ''), value: c.name }));
        const picked = await surface.showPicker('Join a relay channel', items);
        if (!picked) { idleStatus(); return; }
        channel = picked;
      } else {
        channel = '#general';
        surface.outputLine(chalk.dim('  (no channel list returned — defaulting to #general)'));
      }
    }
    relay = client;
    rosterUsers = [];
    // Best-effort channel list for tab-completion (covers the /relay #x path).
    if (!relayKnownChannels.length) client.listChannels().then(cs => { relayKnownChannels = cs.map(c => c.name); }).catch(() => {});
    surface.outputLine(chalk.green(`  📡 Joining ${channel} as ${nick}…  (type to chat · /relay join #x · /leave)`));
    client.connect(channel!);
    relayStatus('connecting');
  }

  async function handleRelay(args: string): Promise<void> {
    const a = args.trim();
    const parts = a.split(/\s+/);
    const sub = (parts[0] || '').toLowerCase();
    if (relay) {
      if (sub === 'leave' || sub === 'exit' || sub === 'quit') { leaveRelay(); return; }
      if (sub === 'join') {
        if (parts[1]) { rosterUsers = []; relay.join(parts[1]); } else surface.outputLine(chalk.yellow('Usage: /relay join #channel'));
        return;
      }
      if (sub === 'channels') {
        const scope = parts[1] || 'platform';  // platform | community | workspace:<slug>
        const cs = await relay.listChannels(scope);
        relayKnownChannels = cs.map(c => c.name);
        surface.outputLine(chalk.bold(`Channels (${scope}): `) + chalk.dim(relayKnownChannels.join('  ') || '(none)'));
        return;
      }
      if (sub === 'more' || sub === 'history') { await relayLoadOlder(); return; }
      if (a.startsWith('#')) { rosterUsers = []; relay.join(a); return; }
      surface.outputLine(chalk.dim('In relay: type to chat · /relay join #x · /relay channels [scope] · /relay more · /leave'));
      return;
    }
    await startRelay(a.startsWith('#') ? a : undefined);
  }

  function leaveRelay(): void {
    if (!relay) return;
    try { relay.part(); } catch { /* */ }  // tell the channel before closing
    relay.disconnect(); relay = null; rosterUsers = []; relayUnread = new Map();
    relayOldestTs = null; relayLoadingOlder = false;
    if (relayTypingThrottle) { clearTimeout(relayTypingThrottle); relayTypingThrottle = null; }
    surface.setOutputLabel('output'); surface.setTracePanel('trace', []);
    surface.outputLine(chalk.dim('  📡 Left relay — back to agent chat.'));
    idleStatus();
  }

  /** `/view <path>` — open a file in the in-TUI document viewer. Markdown/code/
   *  text render in a full-screen scrollable overlay; PNG images render inline as
   *  half-blocks on the real terminal (via runDetached, for true 24-bit colour);
   *  other image formats open in the OS viewer. */
  async function handleView(args: string): Promise<void> {
    const path = args.trim();
    if (!path) {
      surface.outputLine(chalk.yellow('Usage: /view <file>') + chalk.dim('  — markdown, code, text, or a PNG image'));
      surface.focusInput(); return;
    }
    const doc = loadDoc(path);
    if (doc.kind === 'missing' || doc.kind === 'binary') {
      surface.outputLine(chalk.yellow(`  ${doc.note || doc.kind}: `) + chalk.dim(doc.absPath));
      surface.focusInput(); return;
    }

    if (doc.kind === 'image') {
      const cols = Math.max(20, (process.stdout.columns || 100) - 4);
      const ansi = imageToAnsi(doc.absPath, Math.min(cols, 120), 50);
      if (ansi) {
        const dims = imageDimensions(doc.absPath);
        await surface.runDetached(`view ${doc.title}`, () => {
          process.stdout.write(chalk.dim(`  ${doc.title}${dims ? `  ${dims.width}×${dims.height}` : ''}\n\n`));
          for (const l of ansi) process.stdout.write('  ' + l + '\n');
        });
        idleStatus();
      } else {
        openLocalImage(doc.absPath);
        surface.outputLine(chalk.dim(`  🖼  ${doc.ext.replace('.', '').toUpperCase()} opened in OS viewer (only PNG renders inline): `) + chalk.dim(doc.absPath));
        surface.focusInput();
      }
      return;
    }

    const width = (process.stdout.columns || 100);
    const { lines, fallbackOpenPath } = renderDocLines(doc, width);
    if (fallbackOpenPath) openLocalImage(fallbackOpenPath);
    await surface.showViewer(doc.title, lines);
    idleStatus();
  }

  /** `/edit <path>` — open a file in the in-TUI editor (notepad/vim-lite). Opens
   *  an empty buffer for a non-existent path (create-on-save). Refuses image/
   *  binary files. Ctrl+S writes the file; Esc/Ctrl+Q closes. */
  async function handleEdit(args: string): Promise<void> {
    const path = args.trim();
    if (!path) {
      surface.outputLine(chalk.yellow('Usage: /edit <file>') + chalk.dim('  — opens the in-shell editor (^S save · ^Q quit)'));
      surface.focusInput(); return;
    }
    const absPath = resolveDocPath(path);
    let initial = '';
    if (existsSync(absPath)) {
      const doc = loadDoc(path);
      if (doc.kind === 'image' || doc.kind === 'binary') {
        surface.outputLine(chalk.yellow(`  cannot edit a ${doc.kind} file: `) + chalk.dim(absPath));
        surface.focusInput(); return;
      }
      initial = doc.text ?? '';
    } else {
      surface.outputLine(chalk.dim(`  new file: ${absPath}`));
    }

    const title = absPath.split(/[/\\]/).pop() || path;
    await surface.showEditor(title, initial, async (text) => {
      try {
        const dir = dirname(absPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(absPath, text, 'utf-8');
        return null;
      } catch (e: any) {
        return e?.message || 'write failed';
      }
    });
    surface.outputLine(chalk.dim(`  edited ${absPath}`));
    idleStatus();
  }

  async function runCommand(input: string, bg = false): Promise<void> {
    const sp = input.indexOf(' ');
    const name = sp > 0 ? input.slice(1, sp) : input.slice(1);
    const args = sp > 0 ? input.slice(sp + 1).trim() : '';
    if (!name) { await openPicker(); return; }
    if (name === 'clear' || name === 'cls') { surface.clearPanes(); idleStatus(); surface.focusInput(); return; }
    if (name === 'help') { showHelp(); return; }
    if (name === 'view' || name === 'open' || name === 'cat') { await handleView(args); return; }
    if (name === 'edit' || name === 'e' || name === 'nano') { await handleEdit(args); return; }
    if (name === 'jobs') { await handleJobs(args); return; }
    if (name === 'steer') { await handleJobs(`steer ${args}`); return; }
    if (name === 'cancel') { await handleJobs(`cancel ${args}`); return; }
    if (name === 'relay') { await handleRelay(args); return; }
    if ((name === 'leave' || name === 'unrelay') && relay) { leaveRelay(); return; }

    const cmd = getCommand(name);
    if (!cmd) {
      surface.outputLine(chalk.yellow(`Unknown command: ${name}`) + chalk.dim('  (/ picker, or AITHER_TUI=0 for full UX)'));
      surface.focusInput(); return;
    }
    // Background variants.
    if ((bg || AUTO_BG_COMMANDS.has(name))) {
      if (name === 'forge') { bgForge(args); return; }
      if (name === 'swarm') { bgSwarm(args); return; }
      if (bg) {
        const job = launchCommandJob(`/${name} ${args}`.trim(), () => cmd.handler(client, args, config));
        surface.outputLine(chalk.dim(`Background job #${job.id}: /${name}`)); idleStatus(); return;
      }
    }
    // Foreground: suspend the TUI and run the command on the REAL terminal, so
    // its console.log / ora spinners / @inquirer prompts (e.g. /login) all work
    // and can't corrupt or deadlock the blessed screen. Returns on a keypress.
    // When invoked bare (no args) and the command has a subcommand table, collect
    // its arguments interactively first — same detached session, so the prompts
    // and the handler output share one suspend/restore cycle.
    const subDefs = SUBCOMMAND_DEFS['/' + name];
    const interactive = !args && !!subDefs?.length;
    await surface.runDetached(name, async () => {
      let finalArgs = args;
      if (interactive) {
        const collected = await collectArgs(name, subDefs!);
        if (collected === null) { console.log(chalk.dim('\n  (cancelled)\n')); return; }
        finalArgs = collected;
      }
      await cmd.handler(client, finalArgs, config);
    });
    idleStatus();
  }

  function bgForge(args: string): void {
    let task = args; let agent: string | undefined; let effort: number | undefined;
    const am = args.match(/--agent\s+(\S+)/); if (am) { agent = am[1]; task = task.replace(am[0], ''); }
    const em = args.match(/--effort\s+(\d+)/); if (em) { effort = Number(em[1]); task = task.replace(em[0], ''); }
    task = task.replace(/^["']|["']$/g, '').trim();
    if (!task) { surface.outputLine(chalk.yellow('Usage: /forge "task" [--agent name] [--effort N]')); return; }
    const job = launchForgeJob(client, task, { agent, effort });
    surface.outputLine(chalk.dim(`${agent ? '@' + agent : 'Forge'} → background job #${job.id} (effort ${effort ?? 5})`));
    idleStatus();
  }
  function bgSwarm(args: string): void {
    let task = args; let mode = 'llm';
    const mm = args.match(/--mode\s+(\S+)/); if (mm) { mode = mm[1]; task = task.replace(mm[0], ''); }
    task = task.replace(/^["']|["']$/g, '').trim();
    if (!task) { surface.outputLine(chalk.yellow('Usage: /swarm <task> [--mode forge|llm|plan_only]')); return; }
    const job = launchSwarmJob(client, task, mode);
    surface.outputLine(chalk.dim(`Swarm (${mode}) → background job #${job.id}`)); idleStatus();
  }

  async function runChat(input: string, bg = false): Promise<string | null> {
    // Resolve @mentions (agent routes) vs @strategy triggers.
    let agent = config.defaultAgent;
    const resolved: string[] = [];
    const mentions = input.match(/@(\S+)/g) || [];
    for (const m of mentions) {
      const raw = m.slice(1);
      if (STRATEGY_TRIGGERS.has(raw.toLowerCase())) continue;
      const { resolved: r, unknown } = resolveAgentMention(raw);
      if (r && !resolved.includes(r)) resolved.push(r);
      else if (unknown) surface.traceLine(chalk.yellow(`  ⚠ unknown agent @${unknown}`));
    }
    if (resolved.length) agent = resolved[0];
    const hasDeep = mentions.some(m => DEEP_TRIGGERS.has(m.slice(1).toLowerCase()));

    if (bg) {
      const label = agent !== config.defaultAgent ? `@${agent}: ${input.slice(0, 40)}` : `Chat: ${input.slice(0, 50)}`;
      const job = launchChatJob(client, input, { agent, sessionId: config.sessionId, model: config.model, label });
      surface.outputLine(chalk.dim(`Background job #${job.id}: ${label}`)); idleStatus(); return null;
    }

    // Pre-flight readiness — a WARNING, so it must not sit on the hot path. This
    // was `await`ed before every turn: a flat tax of up to 2s (its own timeout)
    // before the message was even sent, on a turn we send "anyway" regardless of
    // the result. Fire-and-forget; the warning still lands in the trace pane.
    void fetch(`${config.genesisUrl}/health`, { signal: AbortSignal.timeout(2000) })
      .then(async (h) => {
        if (!h.ok) return;
        const hd = await h.json();
        if (hd.generation_ready === false) surface.traceLine(chalk.yellow('  ⚠ LLM pool busy (0 slots) — sending anyway'));
      })
      .catch(() => surface.traceLine(chalk.yellow('  ⚠ pre-flight check failed (backend slow or down) — sending anyway')));

    surface.outputLine(chalk.green('› ') + input);
    surface.setStatus('working…');
    // Open a fresh, collapsible trace thread for this turn (older turns collapse).
    surface.startTraceTurn(input.length > 32 ? input.slice(0, 32) + '…' : input);

    // Clarification gate auto-resolve.
    let clarification: ClarificationResponse | undefined;
    if (pendingGate) { clarification = { plan_id: pendingGate.planId, gate_id: pendingGate.gateId, answers: input }; pendingGate = null; }
    // RLM continuity: prior turn this session, or the resumed transcript summary.
    const prevCtx = lastProfile ? {
      summary: `Previous: "${lastProfile.prompt.slice(0, 160)}" → ${lastProfile.model}, ${lastProfile.tool_calls.length} tools`,
      tools_used: lastProfile.tool_calls.map(t => t.name), model: lastProfile.model, errors: lastProfile.errors,
    } : seededContext ? {
      summary: seededContext, tools_used: [] as string[], model: config.model || '', errors: [] as string[],
    } : undefined;
    seededContext = null;  // consume once

    activeAbort = new AbortController();
    processing = true;
    let aborted = false;
    // Non-null when the turn ended in a hard connection/auth failure (never reached
    // the backend, or the stream died and could not recover). The drain loop reads
    // this to HALT the whole queue instead of replaying every message into a dead
    // endpoint — one bad multi-line paste must not become 30 failing turns.
    let turnError: string | null = null;
    let renderer = createTuiRenderer(surface, config.sessionId, input, {
      getAffect: avatarAffect, suppressAnswerBody: voice.isEnabled(), isSpeaking: () => voice.isSpeaking(),
    });
    currentRenderer = renderer;   // expose buffers to the live overlays (Ctrl+F/N/R)
    // Set the timeline instance for new-trace rendering (when AITHER_NEW_TRACE=1)
    const timeline = renderer.getTimeline?.();
    if (timeline) surface.setTimeline(timeline);

    // Auto-retry once when the connection is severed mid-turn (Genesis or the
    // LB recreated under us — a deploy rolling the stack). Only when NO tools
    // fired yet (no double side-effects) and only after the backend is
    // reachable again. A soft stream_timeout (agent may still be working) is
    // NOT retried — that path keeps its "check forge status" semantics.
    const MAX_ATTEMPTS = 2;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          renderer = createTuiRenderer(surface, config.sessionId, input, {
            getAffect: avatarAffect, suppressAnswerBody: voice.isEnabled(), isSpeaking: () => voice.isSpeaking(),
          });
          currentRenderer = renderer;
          // Update timeline for retry
          const retryTimeline = renderer.getTimeline?.();
          if (retryTimeline) surface.setTimeline(retryTimeline);
          surface.startTraceTurn((input.length > 32 ? input.slice(0, 32) + '…' : input) + ' (retry)');
        }
        let sawTerminal = false;   // complete/done/error/timeout/interrupt arrived
        let interrupted = false;   // transport died mid-turn
        let toolFired = false;     // tools ran — retry could double side-effects
        try {
          for await (const ev of client.streamChat(input, {
            agent, mentions: resolved.length > 1 ? resolved : undefined,
            sessionId: config.sessionId, model: config.model, signal: activeAbort.signal,
            clarificationResponse: clarification, sessionContext: prevCtx,
            effort: config.effort, safetyLevel: config.safetyLevel, privateMode: config.privateMode,
            attachments: config.imageAttachments, maxEffort: hasDeep ? undefined : (config.effort || 5),
          })) {
            renderer.onEvent(ev);
            // Drive the docked avatar's mouth from the answer stream (lip-sync without TTS).
            if (ev.type === 'token' || ev.type === 'answer') lastAnswerTokenAt = Date.now();
            if (ev.type === 'complete' || ev.type === 'done' || ev.type === 'error'
                || ev.type === 'llm_error' || ev.type === 'stream_timeout') sawTerminal = true;
            if (ev.type === 'stream_interrupted') { sawTerminal = true; interrupted = true; }
            if (ev.type === 'tool_call' || ev.type === 'tool_result') toolFired = true;
            if (ev.type === 'clarification_needed' && ev.data.plan_id) {
              pendingGate = { planId: ev.data.plan_id, gateId: ev.data.gate_id || '' };
            }
          }
          if (config.imageAttachments?.length) config.imageAttachments = undefined;
        } catch (err: any) {
          if (err?.name === 'AbortError') { aborted = true; surface.outputLine(chalk.dim('  (interrupted)')); }
          else {
            // First line only, bounded — never spray a raw stack/JSON at the user.
            const raw = typeof err?.message === 'string' ? err.message : String(err);
            turnError = raw.split('\n')[0].slice(0, 200);
            surface.outputLine(chalk.red(`  Error: ${turnError}`));
          }
          renderer.finish(aborted);
          break;
        }
        renderer.finish(aborted);

        const lostMidTurn = interrupted || !sawTerminal;
        if (!lostMidTurn || aborted || toolFired || attempt === MAX_ATTEMPTS - 1) {
          // Broke out with the stream still dead (last attempt, or tools fired so we
          // won't retry): a hard failure the drain loop must see so a queued flood halts.
          if (lostMidTurn && !aborted) turnError = turnError || 'connection closed mid-turn';
          break;
        }

        surface.setStatus('connection lost — waiting for backend…');
        const back = await waitForBackend(config.genesisUrl, 120_000, activeAbort.signal);
        if (!back) {
          surface.outputLine(chalk.yellow('  Backend still unreachable after 2 minutes — resend when it returns.'));
          turnError = turnError || 'backend unreachable';
          break;
        }
        surface.outputLine(chalk.cyan('↻ Backend is back — retrying the turn once…'));
      }
    } finally {
      activeAbort = null; processing = false;
      // Flush any job_done outputs that were queued while the turn was in flight
      for (const pending of pendingJobOutput) {
        surface.outputLine(chalk.dim(pending.content));
      }
      pendingJobOutput = [];
      lastProfile = renderer.getSessionProfile();
      postToStrata(client, lastProfile).catch(() => {});
      // Persist the full turn (user + assistant) locally + remote → /export, --continue.
      try {
        recordTurn(config.sessionId, lastProfile.agent || agent, input, renderer.getContent(), {
          model: lastProfile.model, tools: lastProfile.tool_calls.map(t => t.name),
          tokens: sumTokens(lastProfile.events),
        });
      } catch { /* */ }
      // Voice on: reveal the answer text IN SYNC with the spoken audio (the
      // controller suppressed the instant body). Off: the controller already
      // printed it. Blocks until she finishes — she's speaking, then you continue.
      if (!aborted && voice.isEnabled()) {
        const answer = renderer.getContent();
        if (answer.trim()) {
          const now = new Date();
          const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          surface.outputLine(chalk.dim('╭─ ') + chalk.bold('aither') + chalk.dim(` · ${t}`));
          let vres: { ok: boolean; error?: string } = { ok: true };
          personaSpeaking();
          try { vres = await voice.speakSynced(answer, (delta) => surface.appendOutput(delta)); }
          catch { surface.appendOutput(answer); }
          finally { personaIdle(); }
          surface.appendOutput('\n');
          surface.outputLine(chalk.dim(`╰─ ${[lastProfile.agent || agent, lastProfile.model].filter(Boolean).join(' · ')}`));
          // Be honest when TTS didn't actually produce audio — don't silently fake it.
          if (vres && !vres.ok) {
            voice.disable();
            surface.outputLine(chalk.yellow('  ♪ voice: no reachable TTS backend — showing text only, voice off.'));
            surface.outputLine(chalk.dim('     AitherVoice has no OFFLINE backend and the container can\'t reach cloud TTS (DNS). "/voice on" to retry.'));
          }
        }
      }
      idleStatus(); surface.focusInput();
    }
    return turnError;
  }
}

/** Poll /health until the backend answers 200, the timeout elapses, or the
 *  user aborts. Genesis cold-boots in ~110s after a recreate, so the budget
 *  must cover a full container roll, not just a blip. */
async function waitForBackend(baseUrl: string, timeoutMs: number, signal?: AbortSignal | null): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (signal?.aborted) return false;
    try {
      const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* still down */ }
    await new Promise(res => setTimeout(res, 2500));
  }
  return false;
}
