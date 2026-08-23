/**
 * Typed structures for the trace timeline: turns, stages, and individual events.
 * Used by timeline.ts to organize and render per-turn telemetry.
 */
import type { SSEEvent } from '../client.js';

/** Values the backend sends in a `model` field that are NOT a model name. Rendering
 *  these makes a successful turn look broken (`Verdict · unknown`). Mirrors the
 *  footer's rule in `controller.ts`. */
const PLACEHOLDER_MODELS = new Set(['unknown', 'auto', 'default', 'none', 'null', 'n/a', '-']);

/**
 * A tool invocation within a stage, with paired call and result data.
 */
export interface ToolDetail {
  name: string;
  args: Record<string, any>;
  result?: Record<string, any> | string;
  ok: boolean;
  ms?: number;
}

/**
 * Metrics for a stage: token counts, elapsed time, model used, etc.
 */
export interface StageMetrics {
  tokens?: number;
  ms?: number;
  model?: string;
  toolCalls?: number;
  // Rich telemetry the backend already emits (surfaced in P1+):
  neurons?: number;        // neurons_fired / count of neuron_fire events
  qualityScore?: number;   // context_flame_graph.quality_score (0..1)
  cacheWarm?: boolean;     // context_flame_graph.cache_warm
  evictionCount?: number;  // context_eviction.evicted
  confidence?: number;     // thought.confidence (0..1) — last seen
  searchQueries?: string[];// thought.search_queries
}

/**
 * A single event within a trace stage.
 */
export interface TraceEvent {
  raw: SSEEvent;              // original SSE event
  type: string;               // event.type
  text: string;               // formatted line text
  severity: 'info' | 'warn' | 'error';
  metadata: Record<string, any>;
  toolDetail?: ToolDetail;
}

/**
 * A stage (context, think, llm, tools, plan, orchestration, verdict, error, other).
 */
export interface TraceStage {
  kind: 'context' | 'think' | 'llm' | 'tools' | 'plan' | 'orchestration' | 'verdict' | 'error' | 'neurons' | 'memory' | 'other';
  title: string;
  events: TraceEvent[];
  status: 'running' | 'done' | 'error';
  metrics: StageMetrics;
  collapsed: boolean;
  repeatCount: number;  // dedupe: consecutive identical lines
}

/**
 * A complete turn's trace data: grouped into stages with metadata.
 */
export interface TraceTurn {
  label: string;              // user input or turn header
  stages: TraceStage[];
  collapsed: boolean;
  status: 'running' | 'done' | 'error';
  startedAt: number;          // timestamp
  durationMs?: number;
}

/**
 * Schema for events that should be hidden from the trace pane
 * unless verbose mode is enabled (AITHER_TRACE_VERBOSE=1).
 */
export const HIDDEN_EVENT_TYPES = new Set([
  'heartbeat', 'keepalive', 'token', 'debug', 'session_start',
  'received',   // preamble ack ({preamble_ms}); would pollute the turn as an 'other' stage
  'middleware_progress', 'classifier_timing',
  'answer', 'suggested_followups',  // chat-pane content, not trace
  'classify', 'classify_update',      // internal routing, not user-visible
  'answer_segment', 'segment_end',    // streaming control, not telemetry
]);

/**
 * Classify an SSE event type into a stage kind.
 */
export function classifyEventToStage(
  eventType: string,
): 'context' | 'think' | 'llm' | 'tools' | 'plan' | 'orchestration' | 'verdict' | 'error' | 'neurons' | 'memory' | 'other' {
  if (/^neurons?_/.test(eventType)) return 'neurons';               // neuron_fire, neurons_start/done
  if (eventType === 'memory_recall' || eventType === 'source') return 'memory';
  if (eventType.startsWith('context_')) return 'context';           // context_flame_graph/eviction/assembly/chunks
  if (eventType.startsWith('think_') || eventType.startsWith('reasoning_') || eventType === 'thought') return 'think';
  if (/^llm_(start|route|done|end|error)$/.test(eventType)) return 'llm';
  if (/^tool_(selection|call|result|execution)$/.test(eventType)) return 'tools';
  if (/^plan_|^mcts_/.test(eventType)) return 'plan';
  if (/^council_|^steering_|^agent_message|^ooda_|^facet_/.test(eventType)) return 'orchestration';
  if (/^(complete|done|final_answer|verdict)$/.test(eventType)) return 'verdict';
  // Genuine failures fail the turn. But `guard_rescue` is a SUCCESSFUL recovery (the
  // guard delivered a direct answer) and `pipeline_timeout` is the enrich pass being
  // cut off on a turn that still COMPLETES with an answer — neither is a turn failure.
  // Classifying them 'error' set currentTurn.status='error', which the later 'complete'
  // verdict cannot clear (timeline.ts:116) → every ordinary knowledge turn rendered as
  // ✗ / "Verdict unknown". They stay VISIBLE as warnings (formatEventLine renders them),
  // just grouped under orchestration instead of failing the turn.
  if (/^(error|pipeline_error|llm_error)$/.test(eventType)) return 'error';
  if (/^(pipeline_timeout|guard_rescue)$/.test(eventType)) return 'orchestration';
  return 'other';
}

/**
 * Extract metrics from an event if present.
 */
export function extractMetrics(eventType: string, data: any): StageMetrics {
  const m: StageMetrics = {};
  // Token counts
  if (data.tokens_used != null) m.tokens = Number(data.tokens_used);
  else if (data.tokens != null) m.tokens = Number(data.tokens);
  else if (data.total_tokens != null) m.tokens = Number(data.total_tokens);
  // Time
  if (data.llm_time_ms != null) m.ms = Number(data.llm_time_ms);
  else if (data.duration_ms != null) m.ms = Number(data.duration_ms);
  else if (data.elapsed_ms != null) m.ms = Number(data.elapsed_ms);
  else if (data.gather_time_ms != null) m.ms = Number(data.gather_time_ms);
  // Model — placeholders are NOT a model name.
  //
  // The backend sends `model: "unknown"` (and sometimes "auto"/"default") on terminal
  // events, and this took it verbatim, so the trace drawer rendered
  // `● Verdict · 102.2s · unknown` on turns that had SUCCEEDED. That reads as a failed
  // or unrouted turn — it is strictly worse than printing no model at all, and it was
  // reported as "no indication of what's going on".
  // `controller.ts:239` already had exactly this rule for the footer
  // (`m !== 'auto' && m !== 'unknown'`); the stage metrics never got it. Same rule,
  // one place, so a placeholder can't reappear in either surface.
  const _realModel = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
    if (!s) return undefined;
    return PLACEHOLDER_MODELS.has(s.toLowerCase()) ? undefined : s;
  };
  const _m = _realModel(data.model_used) ?? _realModel(data.model);
  if (_m) m.model = _m;
  // Rich telemetry (context flame graph, neurons, reasoning confidence)
  if (data.neurons_fired != null) m.neurons = Number(data.neurons_fired);
  if (data.quality_score != null) m.qualityScore = Number(data.quality_score);
  if (data.cache_warm != null) m.cacheWarm = Boolean(data.cache_warm);
  if (data.evicted != null) m.evictionCount = Number(data.evicted);
  if (data.confidence != null) m.confidence = Number(data.confidence);
  if (Array.isArray(data.search_queries)) m.searchQueries = data.search_queries.map(String);
  return m;
}
