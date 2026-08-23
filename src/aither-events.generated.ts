/**
 * AitherEvent v1 — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Source of truth: AitherOS/lib/core/AitherEventSpine.py
 * Regenerate:      python AitherOS/dev/tools/gen_event_protocol_ts.py
 *
 * Editing this file is pointless: check_event_protocol_parity.py (AE004) re-runs the
 * generator and fails the build if this file differs from its output.
 */


export const PROTOCOL_VERSION = 1;

/** The six engines. Every cognition event lands in exactly one lane. */
export type Pillar = 'intent' | 'context' | 'reasoning' | 'orchestration' | 'learning' | 'automation';

/** Lane order for rendering — matches the cognitive cycle, not the alphabet. */
export const PILLARS: Pillar[] = ['intent', 'context', 'reasoning', 'orchestration', 'learning', 'automation'];

/** Which service level produced the event. `host` survives a wedged Docker. */
export type Tier = 'host' | 'fleet';

export type ActorKind =
  | 'human'
  | 'claude_code'
  | 'adk_agent'
  | 'sovereign'
  | 'kernel'
  | 'service'
  | 'acp'
  | 'a2a';

export interface Actor {
  kind: ActorKind;
  id: string;
  name: string;
}

export interface AitherEvent {
  v: number;
  id: string;
  /** Assigned by the sink, never the producer. 0 means 'not yet stamped'. */
  seq: number;
  ts: number;
  room: string;
  session: string;
  actor: Actor;
  /** null for conversation-surface events (tokens, keepalives, lifecycle). */
  pillar: Pillar | null;
  tier: Tier;
  type: string;
  stage: string;
  payload: Record<string, unknown>;
  correlation_id: string;
  causation_id: string;
}

/** Shell trace event type -> pillar. Mirrors formatters.ts case labels. */
export const SHELL_EVENT_PILLARS: Record<string, Pillar> = {
  'classify': 'intent',
  'classify_update': 'intent',
  'clarification_needed': 'intent',
  'context_start': 'context',
  'context_stage': 'context',
  'context_done': 'context',
  'context_assembly': 'context',
  'context_summary': 'context',
  'neuron_fire': 'context',
  'ooda_observe': 'context',
  'user_activity': 'context',
  'think_start': 'reasoning',
  'thinking': 'reasoning',
  'thinking_end': 'reasoning',
  'reasoning_start': 'reasoning',
  'reasoning_engage': 'reasoning',
  'reasoning_strategy': 'reasoning',
  'reasoning_step': 'reasoning',
  'reasoning_trace': 'reasoning',
  'reasoning_depth': 'reasoning',
  'mcts_plan': 'reasoning',
  'mcts_iteration': 'reasoning',
  'facet_start': 'reasoning',
  'facet_end': 'reasoning',
  'facet_crystallize': 'reasoning',
  'checkpoint': 'reasoning',
  'plan_start': 'reasoning',
  'plan_ready': 'reasoning',
  'plan_refined': 'reasoning',
  'ooda_decide': 'reasoning',
  'speculative_fire': 'reasoning',
  'speculative_result': 'reasoning',
  'prefire_result': 'reasoning',
  'loop_guard': 'reasoning',
  'model_select': 'orchestration',
  'llm_start': 'orchestration',
  'llm_done': 'orchestration',
  'llm_end': 'orchestration',
  'llm_error': 'orchestration',
  'tool_selection': 'orchestration',
  'tool_call': 'orchestration',
  'tool_result': 'orchestration',
  'plan_phase': 'orchestration',
  'plan_step': 'orchestration',
  'plan_status': 'orchestration',
  'plan_complete': 'orchestration',
  'ooda_delegate': 'orchestration',
  'agent_message': 'orchestration',
  'council': 'orchestration',
  'council_perspective': 'orchestration',
  'council_review': 'orchestration',
  'escalation': 'orchestration',
  'agentic_upgrade': 'orchestration',
  'agentic_promotion': 'orchestration',
  'approval_required': 'orchestration',
  'steering': 'orchestration',
  'steering_guide': 'orchestration',
  'middleware_progress': 'orchestration',
  'task_created': 'orchestration',
  'task_completed': 'orchestration',
  'teammate_idle': 'orchestration',
  'image_gen_start': 'automation',
  'image_gen_complete': 'automation',
  'image_gen_failed': 'automation',
  'artifact_delivered': 'automation',
  'kernel.node_started': 'automation',
  'kernel.node_ready': 'automation',
};

/** FluxEmitter EventType value -> pillar. Partial by design; see the Python doc. */
export const FLUX_PILLARS: Record<string, Pillar> = {
  'usr.m': 'intent',
  'usr.a': 'intent',
  'usr.u': 'intent',
  'usr.s': 'intent',
  'emo.d': 'intent',
  'tms.u': 'intent',
  'ctx.r': 'context',
  'mem.r': 'context',
  'mem.q': 'context',
  'mem.sp': 'context',
  'rfx.i': 'context',
  'rfx.b': 'context',
  'spr.m': 'context',
  'sns.a': 'context',
  'vis.a': 'context',
  'vis.r': 'context',
  'vox.t': 'context',
  'tms.s': 'context',
  'rsn.s': 'reasoning',
  'rsn.+': 'reasoning',
  'rsn.d': 'reasoning',
  'jdg.e': 'reasoning',
  'jdg.s': 'reasoning',
  'jdg.+': 'reasoning',
  'jdg.x': 'reasoning',
  'jdg.f': 'reasoning',
  'llm.p': 'orchestration',
  'llm.r': 'orchestration',
  'llm.t': 'orchestration',
  'llm.tr': 'orchestration',
  'orc.d': 'orchestration',
  'a2a.s': 'orchestration',
  'a2a.u': 'orchestration',
  'a2a.d': 'orchestration',
  'ccl.c': 'orchestration',
  'ccl.d': 'orchestration',
  'ccl.t': 'orchestration',
  'wil.a': 'orchestration',
  'mem.s': 'learning',
  'mem.+': 'learning',
  'mem.x': 'learning',
  'mem.^': 'learning',
  'mem.-': 'learning',
  'mem.pr': 'learning',
  'jdg.r': 'learning',
  'emo.m': 'learning',
  'day.s': 'learning',
  'day.t': 'learning',
  'day.e': 'learning',
  'day.i': 'learning',
  'day.w': 'learning',
  'user.feedback': 'learning',
  'user.bug_report': 'learning',
  'svc.r': 'automation',
  'svc.e': 'automation',
  'gpu.ml': 'automation',
  'gpu.mu': 'automation',
  'gpu.ms': 'automation',
  'gpu.pe': 'automation',
  'gpu.ag': 'automation',
  'gpu.ad': 'automation',
  'gpu.aq': 'automation',
  'msh.j': 'automation',
  'msh.l': 'automation',
};

/** SixPillarsKernel tick phase -> pillar. P5 is 'Creation' there, Automation here. */
export const KERNEL_PHASE_PILLARS: Record<string, Pillar> = {
  'P1': 'intent',
  'P2': 'context',
  'P3': 'reasoning',
  'P4': 'orchestration',
  'P5': 'automation',
  'P6': 'learning',
};

/** Conversation surface, not cognition — rendered in the output pane. */
export const SHELL_SURFACE_EVENTS: ReadonlySet<string> = new Set([
  'answer',
  'answer_segment',
  'complete',
  'debug',
  'done',
  'error',
  'final_answer',
  'heartbeat',
  'keepalive',
  'message',
  'partial',
  'progress',
  'segment_end',
  'session_start',
  'status',
  'token',
]);

/**
 * Resolve a pillar for a shell event type or a Flux code.
 *
 * Returns null for surface events and anything unrecognised. Callers must treat
 * null as 'output pane', never as a default lane — putting unknown events in a
 * lane is how a lane stops meaning anything.
 */
export function pillarFor(eventType: string): Pillar | null {
  return SHELL_EVENT_PILLARS[eventType] ?? FLUX_PILLARS[eventType] ?? null;
}

/** True when this shell event type has been deliberately placed (AE001). */
export function isClassified(eventType: string): boolean {
  return eventType in SHELL_EVENT_PILLARS || SHELL_SURFACE_EVENTS.has(eventType);
}
