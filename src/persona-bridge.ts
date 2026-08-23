/** Mirror AitherShell's avatar state onto the Persona desktop VRM overlay (D:\persona).
 *
 * Persona listens on 127.0.0.1:47831 (see .RESEARCH/INTAKE/persona/DOSSIER.md). The
 * fire-and-forget `/events` calls have a short timeout: if Persona is not installed or not
 * running, the shell behaves exactly as before — no errors, no latency (failures latch a
 * cooldown so a dead endpoint is not re-probed on every token). The `/mcp` calls behind the
 * `/persona` command are request/response and DO surface their errors, because a silent
 * failure there reads as "the feature does nothing". Disable with AITHERSHELL_PERSONA=0.
 *
 * Two vocabularies, deliberately: `/events` takes UPPERCASE names (FINGER_GUN) and the MCP
 * tool schema takes lowercase-hyphenated ones (finger-gun). normalizeAnimationName is the
 * only place that conversion lives.
 */

const PERSONA_URL =
  process.env.AITHERSHELL_PERSONA_URL || 'http://127.0.0.1:47831/events';
const PERSONA_BASE =
  process.env.AITHERSHELL_PERSONA_URL?.replace(/\/events$/, '') || 'http://127.0.0.1:47831';
const PERSONA_MCP_URL = `${PERSONA_BASE}/mcp`;
const ENABLED = process.env.AITHERSHELL_PERSONA !== '0';
const RETRY_COOLDOWN_MS = 30_000;

let deadUntil = 0;

function post(payload: Record<string, unknown>): void {
  if (!ENABLED || Date.now() < deadUntil) return;
  void fetch(PERSONA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(500),
  }).catch(() => { deadUntil = Date.now() + RETRY_COOLDOWN_MS; });
}

function state(activity: 'idle' | 'listening' | 'speaking'): void {
  post({
    type: 'state',
    state: { phase: 'active', activity, microphoneMuted: true, outputMuted: false },
  });
}

/** Voice (or synced reveal) started — Persona begins its talk/lip-sync state. */
export function personaSpeaking(): void { state('speaking'); }

/** Turn finished — Persona settles back to idle. */
export function personaIdle(): void { state('idle'); }

/** Amplitude 0..1 while audio plays; drives Persona's mouth directly. */
export function personaLevel(level: number): void {
  post({ type: 'audio-level', level: Math.max(0, Math.min(1, level)) });
}

// ── Animation vocabulary ──────────────────────────────────────────────────────

/** The `/events` (UPPERCASE) names of Persona's built-in clips, in menu order. The MCP
 *  tool enum is the lowercase-hyphenated form of exactly this set — a test pins that, so a
 *  clip added to one vocabulary and not the other fails rather than silently no-ops. */
export const PERSONA_ANIMATIONS = [
  'IDLE', 'GREETING', 'TALK', 'HAPPY', 'FINGER_GUN', 'DANCE',
] as const;

const MCP_ANIMATIONS: readonly string[] =
  PERSONA_ANIMATIONS.map(a => a.toLowerCase().replace(/_/g, '-'));

/** A custom motion pack: `FILE:<name>.vrma`. Persona's own schema is
 *  `/^FILE:[\w.-]+\.vrma$/` — matching it here is what keeps the shell from offering
 *  something the tool will reject (and `[\w.-]` is also why `../` can never pass). */
const FILE_ANIMATION_RE = /^FILE:[\w.-]+\.vrma$/;

/**
 * Convert whatever the user typed into the name the MCP tool schema accepts.
 *
 * `FILE:` packs keep their case — they are real filenames on disk and `MyPose.vrma` is not
 * `mypose.vrma`. Everything else is lowercased and underscore→hyphen, so `FINGER_GUN`
 * (the `/events` spelling, which is what Persona's docs show) reaches the tool as
 * `finger-gun`.
 */
export function normalizeAnimationName(name: string): string {
  const raw = String(name ?? '').trim();
  if (/^file:/i.test(raw)) return `FILE:${raw.slice(5)}`;
  return raw.toLowerCase().replace(/_/g, '-');
}

/**
 * Is this a clip Persona will actually play?
 *
 * Measured live 2026-07-29: `play_animation` with a junk name returned SUCCESS and played
 * nothing, so `/persona anim <typo>` printed "Played ✓" over a no-op. Persona now refuses
 * unknown clips at source, but the shell validates too — the two halves ship separately and
 * an older Persona is the common case.
 */
export function isValidAnimation(name: string): boolean {
  const n = normalizeAnimationName(name);
  if (!n) return false;
  if (n.startsWith('FILE:')) return FILE_ANIMATION_RE.test(n);
  return MCP_ANIMATIONS.includes(n);
}

/**
 * Built-ins first, then whatever `list_animations` reported that is actually playable.
 *
 * Falls back to the built-ins when the reply is missing or junk (an older Persona has no
 * `list_animations` tool): printing NOTHING would read as "no animations installed", which
 * is the same silent-empty failure the roster parse bug produced.
 */
export function mergeAnimationList(raw: unknown): string[] {
  const out = [...MCP_ANIMATIONS];
  const seen = new Set(out);
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const n = normalizeAnimationName(entry);
      if (!isValidAnimation(n) || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** AitherShell portrait emotion -> Persona's semantic one-shot animations. An emotion with
 *  no unambiguous clip resets to IDLE rather than being dropped: dropping it left the
 *  PREVIOUS pose stuck on screen, so a happy reply kept grinning through the sad one. */
const EMOTION_ANIMATION: Record<string, string> = {
  happy: 'HAPPY',
  cheerful: 'HAPPY',
  love: 'HAPPY',
  excited: 'DANCE',
  proud: 'FINGER_GUN',
};

export function personaEmotion(emotion: string): void {
  post({ type: 'animation', animation: EMOTION_ANIMATION[emotion] ?? 'IDLE' });
}

// ── Persona Command Support (for /persona CLI command) ────────────────────

/** Check if Persona is running and responding to health checks. */
export async function personaHealthy(): Promise<boolean> {
  if (!ENABLED) return false;
  try {
    const resp = await fetch(`${PERSONA_BASE}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Decode an MCP Streamable-HTTP reply, which may be plain JSON *or* SSE.
 *
 * The transport picks per request; a client that assumes JSON gets a parse error on the
 * other shape. The LAST `data:` frame is the answer — earlier ones are keepalives and
 * progress notifications. An event-stream with no data frame THROWS rather than returning
 * undefined, because `undefined` downstream reads as an empty-but-successful result.
 */
export function parseMcpBody(contentType: string, text: string): any {
  if (!/text\/event-stream/i.test(contentType || '')) return JSON.parse(text);
  let last: string | null = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;      // skips ':' comments and 'event:' lines
    last = line.slice(5).trim();
  }
  if (last == null || last === '') {
    throw new Error('Persona MCP returned an empty event-stream (no data frame)');
  }
  return JSON.parse(last);
}

/** Call a Persona MCP tool. Returns {content?, isError?} or throws. */
async function callPersonaMcpTool(
  name: string,
  args: Record<string, any> = {},
): Promise<Record<string, any>> {
  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name, arguments: args },
    id: 1,
  };

  const resp = await fetch(PERSONA_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // BOTH are mandatory. The Streamable-HTTP spec lets the server answer either way, so
      // it rejects a client that cannot accept both — Persona replies 406 and EVERY
      // subcommand fails. Advertising only application/json is why /persona never worked.
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1000),
  });

  if (!resp.ok) {
    throw new Error(`Persona MCP error: HTTP ${resp.status}`);
  }

  const data = parseMcpBody(resp.headers.get('content-type') || '', await resp.text());
  if (data.error) {
    throw new Error(`Persona MCP error: ${data.error?.message || JSON.stringify(data.error)}`);
  }
  return data.result || {};
}

/** The JSON payload a Persona tool wraps in its text content block, or null. */
function toolJson(result: Record<string, any>): any {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** True when the tool reported a refusal (e.g. an animation that is not installed). */
function toolError(result: Record<string, any>): string | null {
  if (!result?.isError) return null;
  const text = result?.content?.[0]?.text;
  return typeof text === 'string' && text ? text : 'Persona refused the request';
}

/**
 * Read `list_characters`, whatever shape it comes back in.
 *
 * Persona returns `{active, characters[]}`; the caller used to ask `Array.isArray(parsed)`
 * and fall back to `[]`, which printed "no characters installed" against a live install
 * holding 71 of them. Junk never throws and never invents entries — an empty roster from
 * junk is honest, an invented one is not.
 */
export function normalizeCharacterList(
  raw: unknown,
): { active: string | null; characters: string[] } {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && c.length > 0) : [];

  if (Array.isArray(raw)) return { active: null, characters: strings(raw) };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return {
      active: typeof obj.active === 'string' && obj.active ? obj.active : null,
      characters: strings(obj.characters),
    };
  }
  return { active: null, characters: [] };
}

/** Get Persona status and available characters. */
export async function getPersonaStatus(): Promise<{
  running: boolean;
  status?: Record<string, any>;
  characters?: string[];
  active?: string | null;
  error?: string;
}> {
  const running = await personaHealthy();
  if (!running) {
    return { running: false, error: 'Persona is not running' };
  }

  try {
    const statusResult = await callPersonaMcpTool('get_status');
    const charsResult = await callPersonaMcpTool('list_characters');
    const roster = normalizeCharacterList(toolJson(charsResult));
    return {
      running: true,
      status: toolJson(statusResult) || {},
      characters: roster.characters,
      active: roster.active,
    };
  } catch (err: any) {
    return {
      running: true,
      error: `Failed to fetch status: ${err?.message || err}`,
    };
  }
}

async function requireRunning(): Promise<void> {
  if (!(await personaHealthy())) throw new Error('Persona is not running');
}

/** Set Persona's displayed character. */
export async function setPersonaCharacter(name: string): Promise<void> {
  await requireRunning();
  await callPersonaMcpTool('set_character', { name });
}

/** Show, hide, or toggle the Persona window. */
export async function personaWindowAction(action: 'show' | 'hide' | 'toggle'): Promise<void> {
  await requireRunning();
  await callPersonaMcpTool('control_window', { action });
}

/** Play one clip. Rejects an unknown name CLIENT-side — see isValidAnimation. */
export async function playPersonaAnimation(name: string): Promise<string> {
  const animation = normalizeAnimationName(name);
  if (!isValidAnimation(animation)) {
    throw new Error(
      `"${name}" is not an installed animation. Try: ${MCP_ANIMATIONS.join(', ')}, ` +
      `or FILE:<filename.vrma>. List them with /persona anims.`,
    );
  }
  await requireRunning();
  const result = await callPersonaMcpTool('play_animation', { animation });
  const refused = toolError(result);
  if (refused) throw new Error(refused);
  return animation;
}

/** Every clip play_animation can play: the built-ins plus installed .vrma packs. */
export async function listPersonaAnimations(): Promise<string[]> {
  await requireRunning();
  try {
    return mergeAnimationList(toolJson(await callPersonaMcpTool('list_animations')));
  } catch {
    // Older Persona has no list_animations tool — the built-ins are still true.
    return mergeAnimationList(null);
  }
}

/** Switch the window to the character assigned to an agent. Returns that character, or
 *  null when the agent has no assignment (which is NOT an error — it is a thing to fix). */
export async function setPersonaAgent(agent: string): Promise<string | null> {
  await requireRunning();
  const result = await callPersonaMcpTool('set_agent', { agent });
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  const m = text.match(/\(([^)]+)\)\.?$/);
  return m ? m[1] : null;
}

/** Read which character each agent is assigned to. */
export async function listPersonaAgentAvatars(): Promise<Record<string, string>> {
  await requireRunning();
  const parsed = toolJson(await callPersonaMcpTool('list_agent_avatars'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [agent, character] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof character === 'string' && character) out[agent] = character;
  }
  return out;
}

/** Render the live 3D character into AitherShell portrait frames. Returns whatever the
 *  exporter reported (frame counts / output dir) so the caller can prove it wrote. */
export async function exportPersonaToShell(): Promise<Record<string, any>> {
  await requireRunning();
  const result = await callPersonaMcpTool('export_to_aithershell');
  const refused = toolError(result);
  if (refused) throw new Error(refused);
  return toolJson(result) || {};
}
