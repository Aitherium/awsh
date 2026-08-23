/**
 * Timeline renderer: ingest SSE events into a live trace tree, render with
 * box-drawing rails + aligned metrics gutter, single-accent coloring.
 *
 * Single-writer: only ingest() mutates state. render() is read-only.
 */
import chalk from 'chalk';
import { detectGlyphs, COLORS, LAYOUT, type GlyphSet } from './theme.js';
import {
  classifyEventToStage, extractMetrics, HIDDEN_EVENT_TYPES,
  type TraceEvent, type TraceStage, type TraceTurn,
} from './event-schema.js';
import { renderMeter, renderSparkline } from './sparkline.js';
import type { SSEEvent } from '../client.js';

export interface TimelineRenderResult {
  lines: string[];
  rowToNodeMap: Map<number, { type: 'tool' | 'stage' | 'turn'; data: any }>;  // row index → node
}

export class TimelineRenderer {
  private glyphs: GlyphSet;
  private verbose: boolean;
  private currentTurn: TraceTurn | null = null;
  private turns: TraceTurn[] = [];
  private eventSequenceNum = 0;
  private lastEventType = '';
  private lastStageKind: string | null = null;
  private stagesCollapsed: Set<string> = new Set();  // stage kinds that are collapsed

  constructor() {
    this.glyphs = detectGlyphs();
    this.verbose = process.env.AITHER_TRACE_VERBOSE === '1';
  }

  /**
   * Start a new turn with a user-provided label (e.g. clipped user message).
   */
  public startTurn(label: string): void {
    if (this.currentTurn) this.turns.push(this.currentTurn);
    this.currentTurn = {
      label: label || 'turn',
      stages: [],
      collapsed: false,
      status: 'running' as const,
      startedAt: Date.now(),
    };
  }

  /** The current (running) turn's stages — for the pipeline animator strip. */
  public currentStages(): TraceStage[] {
    return this.currentTurn?.stages ?? [];
  }

  /** The current turn's status (running/done/error) — for the avatar face. */
  public currentStatus(): 'running' | 'done' | 'error' | null {
    return this.currentTurn?.status ?? null;
  }

  /**
   * Toggle all stages between collapsed and expanded.
   */
  public toggleAllStages(): void {
    if (!this.currentTurn) return;
    const allCollapsed = this.currentTurn.stages.every(s => s.collapsed);
    for (const stage of this.currentTurn.stages) {
      stage.collapsed = !allCollapsed;
    }
  }

  /**
   * Ingest an SSE event, classify it into a stage, and update internal state.
   */
  public ingest(event: SSEEvent): void {
    const eventType = event.type;
    const data = event.data || {};

    // Turn lifecycle (BEFORE the hidden check).
    //
    // The controller already opens a turn for the prompt via startTurn(), so a
    // session_start must NOT blindly push+replace it — that orphaned the
    // prompt-labelled turn behind a second, unlabelled "turn" (the stray
    // "⟳ turn" row seen next to the real prompt). Reuse the current turn when it
    // hasn't accumulated real work yet; only roll to a fresh turn when the
    // current one already has stages (a genuine subsequent turn in the session).
    const freshTurn = () => ({
      label: data.prompt || 'turn',
      stages: [] as TraceStage[],
      collapsed: false,
      status: 'running' as const,
      startedAt: Date.now(),
    });
    if (eventType === 'session_start') {
      if (this.currentTurn && this.currentTurn.stages.length > 0) {
        this.turns.push(this.currentTurn);
        this.currentTurn = freshTurn();
      } else if (!this.currentTurn) {
        this.currentTurn = freshTurn();
      } else if (data.prompt) {
        this.currentTurn.label = data.prompt;   // adopt an explicit label if given
      }
      return;
    }
    if (!this.currentTurn) this.currentTurn = freshTurn();

    // Hidden events (heartbeat, keepalive, debug) unless verbose
    if (HIDDEN_EVENT_TYPES.has(eventType) && !this.verbose) return;

    if (!this.currentTurn) return;

    const stageKind = classifyEventToStage(eventType);

    // Verdict events stamp the turn complete/error (but don't overwrite error status)
    if (stageKind === 'verdict') {
      // Only set to 'done' if not already in error state
      if (this.currentTurn.status !== 'error') {
        this.currentTurn.status = 'done' as const;
      }
      this.currentTurn.durationMs = Date.now() - this.currentTurn.startedAt;
      // Finalise stages: most stages never emit a per-stage *_done event, so
      // without this they'd stay 'running' forever (muted dots + a spinning
      // pipeline strip on a finished turn). Promote running → done on verdict.
      for (const s of this.currentTurn.stages) if (s.status === 'running') s.status = 'done';
    } else if (stageKind === 'error') {
      this.currentTurn.status = 'error' as const;
      this.currentTurn.durationMs = Date.now() - this.currentTurn.startedAt;
    }

    // Find or create the stage for this event
    let stage = this.currentTurn.stages.find(s => s.kind === stageKind);
    if (!stage) {
      stage = {
        kind: stageKind,
        title: this.titleForStageKind(stageKind),
        events: [],
        status: 'running',
        metrics: {},
        collapsed: false,
        repeatCount: 0,
      };
      this.currentTurn.stages.push(stage);
    }

    // Format the event as a trace line
    const text = this.formatEventLine(eventType, data);
    if (!text) return;  // skip if formatter returns null

    // Extract metrics
    const metrics = extractMetrics(eventType, data);

    // Create trace event
    const traceEvent: TraceEvent = {
      raw: event,
      type: eventType,
      text,
      severity: stageKind === 'error' ? 'error' : 'info',
      metadata: { ...data },
    };

    // Check for tool result and attach as toolDetail — pairs with the preceding
    // tool_call event in this stage. Genesis emits a FLAT {name,tool,result_count,ok}
    // shape; other backends emit {results:[{tool,output,...}]}. Handle both.
    if (eventType === 'tool_result') {
      const toolEvent = stage.events[stage.events.length - 1];
      const meta = toolEvent?.metadata || {};
      if (meta.tool || meta.name) {
        if (Array.isArray(data.results) && data.results.length) {
          const result = data.results[0];
          toolEvent.toolDetail = {
            name: meta.tool || meta.name,
            args: meta.args || {},
            result: result.output || result,
            ok: result.success !== false && result.ok !== false,
            ms: result.duration_ms,
          };
        } else {
          toolEvent.toolDetail = {
            name: meta.tool || meta.name,
            args: meta.args || {},
            result: { result_count: data.result_count, ok: data.ok !== false },
            ok: data.ok !== false && data.success !== false,
            ms: data.elapsed_ms,
          };
        }
      }
    }

    // Deduplicate: if this line is identical to the last line, increment repeatCount
    if (stage.events.length > 0) {
      const last = stage.events[stage.events.length - 1];
      if (last.text === text) {
        last.metadata.repeatCount = (last.metadata.repeatCount || 1) + 1;
        return;
      }
    }

    // Merge metrics into stage
    Object.assign(stage.metrics, metrics);

    // Update stage status
    if (eventType.endsWith('_done') || eventType.endsWith('_end') || stageKind === 'verdict') {
      stage.status = 'done';
    } else if (eventType.includes('error')) {
      stage.status = 'error';
    }

    stage.events.push(traceEvent);
    this.eventSequenceNum++;
    this.lastEventType = eventType;
    this.lastStageKind = stageKind;
  }

  /**
   * Render the trace pane: return lines + row→node mapping for click handlers.
   * `now` drives the live elapsed readout on the running turn (defaults to
   * Date.now(); tests pass a fixed clock).
   */
  public render(width: number, now?: number): TimelineRenderResult {
    const lines: string[] = [];
    const rowToNodeMap = new Map<number, { type: 'tool' | 'stage' | 'turn'; data: any }>();
    const clock = now ?? Date.now();

    // Don't render if pane too narrow
    if (width < LAYOUT.tracePaneMinWidth) {
      lines.push(COLORS.muted('(trace pane too narrow)'));
      return { lines, rowToNodeMap };
    }

    // Render all turns, collapsing old ones
    for (let i = 0; i < this.turns.length; i++) {
      this.renderTurn(this.turns[i], lines, width, false, rowToNodeMap, clock);  // collapsed
    }

    // Render current turn (expanded)
    if (this.currentTurn) {
      this.renderTurn(this.currentTurn, lines, width, true, rowToNodeMap, clock);
    }

    return { lines, rowToNodeMap };
  }

  /**
   * Render a single turn with its stages.
   */
  private renderTurn(turn: TraceTurn, lines: string[], width: number, expanded: boolean, rowToNodeMap: Map<number, any>, now: number): void {
    // Fix turn status: check if any stage has error status
    let turnStatus = turn.status;
    if (turnStatus === 'running' && turn.stages.some(s => s.status === 'error')) {
      turnStatus = 'error';
    }

    const status = turnStatus === 'done' ? '✓' : turnStatus === 'error' ? '✗' : '⟳';
    // Running turns show a live ticking elapsed; finished turns show final duration.
    const duration = turnStatus === 'running'
      ? ` · ${(Math.max(0, now - turn.startedAt) / 1000).toFixed(1)}s`
      : (turn.durationMs ? ` · ${(turn.durationMs / 1000).toFixed(1)}s` : '');
    const header = `${COLORS.accent(status)} ${COLORS.accent(turn.label)}${COLORS.muted(duration)}`;
    const headerLineIdx = lines.length;
    lines.push(header);
    rowToNodeMap.set(headerLineIdx, { type: 'turn', data: turn });

    if (!expanded || turn.collapsed) return;

    // Render stages
    for (const stage of turn.stages) {
      this.renderStage(stage, lines, width, rowToNodeMap);
    }
  }

  /**
   * Render a single stage with its events.
   */
  private renderStage(stage: TraceStage, lines: string[], width: number, rowToNodeMap: Map<number, any>): void {
    const stageIcon = this.iconForStageKind(stage.kind);
    const status = stage.status === 'done' ? COLORS.success('●') :
                   stage.status === 'error' ? COLORS.error('●') :
                   COLORS.muted('●');

    // Stage header with metrics in a MODEST right gutter.
    const indent = '  ';
    const metricsStr = this.formatMetrics(stage.metrics);
    const label = `${indent}${status} ${stage.title}`;

    // Align metrics to a capped gutter column — NOT the full pane width. On a wide
    // trace pane, aligning to `width` shoved the metrics to the far edge with a huge
    // empty gap that read as "text bleeding". `label` carries ANSI (coloured ●), so
    // measure its VISIBLE length before padding.
    const visibleLabelLen = label.replace(/\x1b\[[0-9;]*m/g, '').length;
    const metricsWidth = metricsStr.length;
    let headerLine: string;
    if (metricsWidth === 0) {
      headerLine = label;
    } else {
      const gutter = Math.min(width - 1, 46);  // align column, capped so metrics stay near the label
      const pad = Math.max(1, gutter - visibleLabelLen - metricsWidth);
      headerLine = label + ' '.repeat(pad) + COLORS.muted(metricsStr);
    }

    const stageHeaderIdx = lines.length;
    lines.push(headerLine);
    rowToNodeMap.set(stageHeaderIdx, { type: 'stage', data: stage });

    // Render events (indented) — skip if stage is collapsed
    if (stage.collapsed) return;

    for (const event of stage.events) {
      const repeatSuffix = event.metadata.repeatCount ? COLORS.muted(` ×${event.metadata.repeatCount}`) : '';
      const eventLineIdx = lines.length;
      lines.push(`    ${event.text}${repeatSuffix}`);
      // Map tool events to their ToolDetail for viewer
      if (event.toolDetail) {
        rowToNodeMap.set(eventLineIdx, { type: 'tool', data: event.toolDetail });
      }
    }
  }

  /**
   * Format an SSE event into a trace line.
   * Returns null if the event should be skipped.
   */
  private formatEventLine(eventType: string, data: any): string | null {
    const scalar = (v: any): string => {
      if (v == null) return '';
      if (typeof v === 'object') {
        return String(v.type ?? v.name ?? v.value ?? v.label ?? v.recommended_model ?? v.level ?? '');
      }
      return String(v);
    };

    const clip = (s: string, n = 50): string => (s.length > n ? s.slice(0, n) + '…' : s);

    switch (eventType) {
      case 'context_start':
        return `gathering context${data.sources ? ` (${Array.isArray(data.sources) ? data.sources.join(', ') : String(data.sources)})` : ''}…`;

      case 'context_stage':
        // Map to human-friendly stage detail instead of raw type
        const detail = scalar(data.stage ?? data.message ?? data.detail);
        return detail ? detail : null;

      case 'context_done':
      case 'context_assembly':
        const tok = data.total_tokens ?? data.context_tokens ?? 0;
        return `context ${tok} tokens`;

      case 'llm_start':
        const m = scalar(data.model) || 'auto';
        return `${m}…`;

      case 'llm_done':
      case 'llm_end': {
        const ms = data.llm_time_ms ?? data.duration_ms ?? 0;
        const toks = data.tokens_used ?? data.tokens ?? data.completion_tokens ?? 0;
        const mod = scalar(data.model_used ?? data.model) || 'default';
        return `${mod} → ${toks} tok (${this.fmtDuration(Number(ms))})`;
      }

      case 'llm_error':
        return COLORS.error(`error: ${clip(scalar(data.error ?? data.message))}`);

      case 'tool_selection': {
        const names = Array.isArray(data.tool_names) ? data.tool_names.join(', ') : scalar(data.tools);
        return `tools [${names}]`;
      }

      case 'tool_call': {
        const tools = data.tools || data.tool_calls;
        if (Array.isArray(tools) && tools.length) {
          return tools.map((t: any) => t.name || t.function?.name || 'tool').join(', ');
        }
        // Genesis emits a FLAT shape: {name, tool, args} (no `tools` array).
        return scalar(data.name ?? data.tool) || null;
      }

      case 'tool_result': {
        const results = data.results;
        if (Array.isArray(results) && results.length) {
          const summaries = results.map((r: any) => {
            const nm = r.tool || r.name || 'tool';
            const ok = r.success !== false && r.ok !== false;
            const icon = ok ? '✓' : '✗';
            if (ok && r.output) {
              return `${icon} ${nm} · ${String(r.output).length} chars`;
            } else if (!ok) {
              return `${icon} ${nm} · ${COLORS.error(clip(String(r.error || r.output || 'error'), 40))}`;
            }
            return `${icon} ${nm}`;
          });
          return summaries.join(' | ');
        }
        // Genesis flat shape: {name, tool, result_count, ok} (no `results` array).
        const nm = scalar(data.name ?? data.tool) || 'tool';
        const ok = data.ok !== false && data.success !== false;
        const icon = ok ? '✓' : '✗';
        if (!ok) return `${icon} ${nm} · ${COLORS.error(clip(scalar(data.error ?? 'error'), 40))}`;
        const rc = data.result_count ?? data.results_count;
        return `${icon} ${nm}${rc != null ? ` · ${rc} results` : ''}`;
      }

      case 'plan_ready':
      case 'plan_refined': {
        const n = Array.isArray(data.steps) ? data.steps.length : (data.step_count ?? '');
        return `plan ${n ? n + ' steps' : 'ready'}`;
      }

      // ── Rich telemetry the backend already emits (P1) ────────────────────
      case 'neuron_fire': {
        const src = scalar(data.source) || 'neuron';
        const ch = data.chunks_count ?? data.chunks;
        const tk = data.total_tokens ?? data.tokens;
        return `${src}${ch != null ? ` · ${ch}ch` : ''}${tk != null ? ` · ${tk} tok` : ''}`;
      }
      case 'neurons_start':
        return `firing neurons…`;
      case 'neurons_done': {
        const nf = data.neurons_fired ?? data.count ?? data.total_fired;
        const tk = data.total_tokens ?? data.tokens;
        return `${nf != null ? nf + ' neurons' : 'neurons done'}${tk != null ? ` · ${tk} tok` : ''}`;
      }
      case 'thought': {
        const conf = Number(data.confidence);
        const meter = isFinite(conf) ? COLORS.accent(renderMeter(conf, 8)) + ' ' : '';
        const gist = clip(scalar(data.summary ?? data.reasoning ?? data.have_enough), 44);
        const q = Array.isArray(data.search_queries) && data.search_queries.length
          ? COLORS.muted(` »${clip(String(data.search_queries[0]), 30)}`) : '';
        return `${meter}${gist}${q}` || null;
      }
      case 'context_flame_graph': {
        const tok = data.total_tokens ?? 0;
        const q = data.quality_score != null ? ` · q${Number(data.quality_score).toFixed(2)}` : '';
        const nf = data.neurons_fired ? ` · ${data.neurons_fired}n` : '';
        const cache = data.cache_warm ? COLORS.success(' · cache✓') : '';
        const ev = data.evictions ? COLORS.warn(` · ${data.evictions} evict`) : '';
        return `flame ${tok} tok${q}${nf}${cache}${ev}  ${COLORS.muted('(^F)')}`;
      }
      case 'context_eviction': {
        const ev = data.evicted ?? 0;
        const freed = data.tokens_freed ? ` · freed ${data.tokens_freed} tok` : '';
        return COLORS.warn(`evicted ${ev}${freed}`);
      }
      case 'memory_recall': {
        const mem = data.memories ?? data.count ?? 0;
        return `recalled ${mem} ${mem === 1 ? 'memory' : 'memories'}${data.spirit ? ' · spirit' : ''}`;
      }
      case 'source': {
        const ch = data.chunks ?? 0;
        const srcN = Array.isArray(data.sources) ? data.sources.length : (data.total ?? null);
        const q = data.search_query ? COLORS.muted(` »${clip(scalar(data.search_query), 28)}`) : '';
        return `${ch} chunks${srcN != null ? ` · ${srcN} sources` : ''}${q}`;
      }

      case 'complete':
      case 'done':
        return 'complete';

      case 'error':
        return COLORS.error(`${clip(scalar(data.message ?? data.error))}`);

      case 'pipeline_timeout':
      case 'pipeline_error':
      case 'guard_rescue':
        // These were previously invisible noise — render as visible warnings
        return COLORS.warn(`${eventType}: ${clip(scalar(data.message ?? data.reason))}`);

      default:
        // Unknown events → muted, never crash
        return COLORS.muted(`${clip(eventType, 30)}`);
    }
  }

  /**
   * Return a title string for a stage kind.
   */
  private titleForStageKind(kind: string): string {
    const titles: Record<string, string> = {
      context: 'Context',
      think: 'Thinking',
      llm: 'LLM',
      tools: 'Tools',
      plan: 'Plan',
      orchestration: 'Orchestration',
      verdict: 'Verdict',  // changed from 'Result' to match coordinator spec
      error: 'Error',
      neurons: 'Neurons',
      memory: 'Memory',
      other: 'Other',
    };
    return titles[kind] || kind;
  }

  /**
   * Return an icon for a stage kind.
   */
  private iconForStageKind(kind: string): string {
    const icons: Record<string, string> = {
      context: '📦',
      think: '🧠',
      llm: '⚡',
      tools: '🔧',
      plan: '📋',
      orchestration: '👥',
      verdict: '✓',
      error: '✗',
      other: '•',
    };
    // Remove emoji; use glyphs only
    return '●';
  }

  /**
   * Format metrics into a right-aligned gutter string.
   */
  private formatMetrics(metrics: any): string {
    const parts: string[] = [];
    if (metrics.tokens) parts.push(`${metrics.tokens} tok`);
    if (metrics.neurons) parts.push(`${metrics.neurons}n`);
    if (metrics.qualityScore != null) parts.push(`q${Number(metrics.qualityScore).toFixed(2)}`);
    if (metrics.ms) parts.push(this.fmtDuration(Number(metrics.ms)));
    if (metrics.model) parts.push(metrics.model);
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  /** Render a millisecond duration compactly: raw ms under 10s, seconds above. */
  private fmtDuration(ms: number): string {
    if (!isFinite(ms) || ms < 0) return '0ms';
    return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  }
}

/**
 * Factory function.
 */
export function createTimeline(): TimelineRenderer {
  return new TimelineRenderer();
}
