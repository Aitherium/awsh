/**
 * Pure event → string formatters shared by the renderers.
 *
 * Field paths mirror the working plain renderer (`renderer.ts`) exactly — the
 * pipeline emits NESTED objects (e.g. `data.intent.type`, `data.effort.level`,
 * `data.model_selection.recommended_model`), so a naive `data.intent` renders as
 * "[object Object]". `scalar()` is a last-line guard against that.
 *
 * blessed renders ANSI SGR codes (what chalk emits) inside box content, so the
 * colored strings work unchanged in the TUI.
 */
import chalk from 'chalk';
import type { SSEEvent } from './client.js';

const dim = chalk.dim;

/** Coerce a possibly-nested value to a short scalar string (never "[object Object]"). */
function scalar(v: any): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    return String(v.type ?? v.name ?? v.value ?? v.label ?? v.recommended_model ?? v.level ?? '');
  }
  return String(v);
}

const clip = (s: string, n = 70): string => (s.length > n ? s.slice(0, n) + '…' : s);

/**
 * Format an event as a single TRACE-pane line, or null if it isn't a
 * trace-worthy event (answer/token are OUTPUT; heartbeat/keepalive/debug are
 * STATUS-only or silent; tool_call/tool_result are handled by the controller).
 */
export function formatTrace(event: SSEEvent): string | null {
  const d = event.data || {};
  switch (event.type) {
    case 'classify': {
      const intent = scalar(d.intent?.type ?? d.intent) || '?';
      const effort = scalar(d.effort?.level ?? d.effort) || '?';
      const tier = scalar(d.effort?.tier ?? d.tier);
      const oneshot = d.effort?.oneshot ? ' ⚡oneshot' : '';
      return chalk.magenta(`  📋 ${intent} · E${effort}${tier ? ' · ' + tier : ''}${oneshot}`);
    }

    case 'classify_update': {
      const intent = scalar(d.intent?.type ?? d.intent) || '?';
      const effort = scalar(d.effort?.level ?? d.effort) || '?';
      return chalk.magenta(`  📋 ${intent} · E${effort}` + (d.reason ? dim(` (${scalar(d.reason)})`) : ''));
    }

    case 'model_select': {
      const m = scalar(d.model_selection?.recommended_model ?? d.model ?? d.recommended) || 'auto';
      const tier = scalar(d.model_selection?.tier ?? d.tier);
      return chalk.cyan(`  🎯 ${m}` + (tier ? dim(` (${tier})`) : ''));
    }

    case 'think_start': {
      const eff = scalar(d.effort_level ?? d.effort) || '?';
      const reasoning = d.use_reasoning ? 'reasoning' : 'standard';
      return dim(`  ⚙ think E${eff} ${reasoning}` + (d.model ? ` · ${scalar(d.model)}` : ''));
    }

    case 'context_start': {
      const src = Array.isArray(d.sources) ? d.sources.join(', ') : '';
      return dim(`  📦 gathering${src ? ' ' + clip(src, 40) : ' context'}…`);
    }

    case 'context_stage':
      return dim(`  · ${scalar(d.stage ?? d.message ?? d.detail)}`);

    case 'context_done':
    case 'context_assembly': {
      const tok = d.total_tokens ?? d.context_tokens ?? d.system_prompt_tokens ?? 0;
      const ms = d.gather_time_ms ?? d.elapsed_ms ?? 0;
      const neurons = d.neurons_fired ? ` · ${d.neurons_fired} neurons` : '';
      return chalk.green(`  📦 context ${tok} tok${neurons}` + (ms ? dim(` (${ms}ms)`) : ''));
    }

    case 'context_summary': {
      const o = d.original_tokens ?? 0; const s = d.summary_tokens ?? 0;
      return o ? dim(`  📝 compressed ${o}→${s} tok`) : null;
    }

    case 'llm_start': {
      const m = scalar(d.model) || 'auto';
      const tok = d.prompt_tokens_est ? ` (${d.prompt_tokens_est} tok${d.has_tools ? ' +tools' : ''})` : '';
      const turn = d.turn ? `turn ${d.turn} · ` : '';
      return chalk.blue(`  🧠 ${turn}LLM ${m}…${tok}`);
    }

    case 'llm_done':
    case 'llm_end': {
      const ms = d.llm_time_ms ?? d.duration_ms ?? 0;
      const tok = d.tokens_used ?? d.tokens ?? 0;
      const m = scalar(d.model_used ?? d.model) || 'default';
      const reason = d.has_thinking ? ' +reasoning' : '';
      const calls = d.has_tool_calls ? ' +tools' : '';
      return chalk.blue(`  ⚡ LLM ${m} → ${tok} tok ${dim(`${Math.round(ms)}ms`)}${reason}${calls}`);
    }

    case 'llm_error':
      return chalk.red(`  ✗ LLM error ${scalar(d.model)}: ${clip(scalar(d.error ?? d.message))}`);

    case 'tool_selection': {
      const names = Array.isArray(d.tool_names) ? d.tool_names.join(', ')
        : Array.isArray(d.tools) ? d.tools.map((t: any) => t?.name || t).join(', ')
        : scalar(d.tools);
      return chalk.yellow(`  🔧 tools [${names}]` + (d.strategy ? dim(` ${scalar(d.strategy)}`) : ''));
    }

    case 'plan_ready':
    case 'plan_refined': {
      const n = Array.isArray(d.steps) ? d.steps.length : (d.step_count ?? '');
      return chalk.cyan(`  📋 plan ${n ? n + ' steps' : 'ready'}` +
        (d.method ? dim(` · ${scalar(d.method)}`) : ''));
    }

    case 'plan_start':
      return dim(`  📐 planning ${scalar(d.tier)}…`);

    case 'plan_phase':
      return dim(`  📐 ${scalar(d.phase)}` + (d.elapsed_ms ? ` ${Math.round(d.elapsed_ms)}ms` : ''));

    case 'plan_step': {
      const done = d.status === 'done' || d.done === true;
      return (done ? chalk.green('  ✓') : dim('  →')) + ` ${clip(scalar(d.step ?? d.task ?? d.description))}`;
    }

    case 'plan_complete':
    case 'plan_status': {
      const st = scalar(d.status ?? d.outcome);
      const benign = st === 'timeout' || st === 'no_plan';
      return (benign ? dim('  ○') : chalk.green('  ✓')) + ` ${st || 'plan complete'}`;
    }

    case 'mcts_plan':
      return chalk.cyan(`  🌲 MCTS ${Array.isArray(d.steps) ? d.steps.length + ' steps' : 'plan'}`);

    case 'mcts_iteration':
      return dim(`  🌲 mcts ${d.iteration ?? d.i ?? '?'}/${d.total ?? d.iterations ?? '?'}` +
        (d.best_value != null ? ` best=${scalar(d.best_value)}` : ''));

    case 'reasoning_start':
    case 'reasoning_engage':
      return chalk.magenta(`  🧠 reasoning ${scalar(d.depth)}` +
        (d.reason ? dim(` · ${clip(scalar(d.reason), 50)}`) : ''));

    case 'reasoning_strategy':
      return chalk.magenta(`  🧠 ${scalar(d.name ?? d.strategy)}`);

    case 'reasoning_step':
    case 'reasoning_trace':
      return dim(`  🧠 ${clip(scalar(d.content ?? d.step), 80)}`);

    case 'reasoning_depth':
      return dim(`  🧠 depth ${scalar(d.level ?? d.depth)}`);

    case 'checkpoint': {
      const t = scalar(d.turn); const max = scalar(d.max_turns ?? d.max);
      return dim(`  ── turn ${t}/${max}` + (d.tool_calls ? ` · ${d.tool_calls} calls` : ''));
    }

    case 'ooda_observe':
      return dim(`  🔍 observe turn ${scalar(d.turn)}/${scalar(d.max_turns ?? d.max)}`);

    case 'user_activity':
      return dim(`  👤 ${scalar(d.app_name ?? d.app ?? 'activity')} · ${scalar(d.action ?? 'opened')}`);

    case 'ooda_decide':
      return dim(`  🔄 decide ${clip(scalar(d.reason), 50)}`);

    case 'ooda_delegate':
      return chalk.yellow(`  🤝 delegate → ${scalar(d.target)}`);

    case 'facet_start':
      return chalk.cyan(`  ── facet ${scalar(d.facet ?? d.type ?? d.index)}`);

    case 'facet_end':
      return chalk.green(`  ✓ facet ${scalar(d.facet ?? d.type)} done`);

    case 'facet_crystallize':
      return chalk.yellow(`  💎 ${clip(scalar(d.summary ?? d.findings), 70)}`);

    case 'neuron_fire':
      return dim(`  🧬 neurons ${scalar(d.chunks)} · ${scalar(d.tokens)} tok`);

    case 'escalation':
      return chalk.yellow(`  ⬆ escalation ${clip(scalar(d.reason), 50)}`);

    case 'agentic_upgrade':
    case 'agentic_promotion':
      return chalk.cyan(`  🔀 agentic ${clip(scalar(d.reason), 50)}`);

    case 'council':
    case 'council_perspective':
      return chalk.magenta(`  👥 ${scalar(d.agent)}: ${clip(scalar(d.perspective ?? d.content), 50)}`);

    case 'council_review':
      return chalk.magenta(`  👥 council ${scalar(d.verdict)}`);

    case 'agent_message':
      return chalk.blue(`  🤖 ${scalar(d.agent)}: ${clip(scalar(d.content), 50)}`);

    case 'steering':
    case 'steering_guide':
      return chalk.yellow(`  🔄 ${clip(scalar(d.hook ?? d.reason), 50)}`);

    case 'speculative_fire':
      return dim(`  🚀 pre-firing ${scalar(d.tools)}`);

    case 'speculative_result':
    case 'prefire_result':
      return dim(`  ✓ pre-fetched ${scalar(d.tool ?? d.tools)}`);

    case 'loop_guard':
      return chalk.red(`  ⛔ loop guard ${scalar(d.tool)}: ${clip(scalar(d.reason), 40)}`);

    case 'middleware_progress':
      return dim(`  ⚙ ${scalar(d.middleware ?? d.name ?? d.stage)}` +
        (d.detail ? ` ${clip(scalar(d.detail), 30)}` : '') +
        (d.elapsed_ms ? ` ${Math.round(d.elapsed_ms)}ms` : ''));

    case 'image_gen_start':
      return chalk.cyan('  🎨 generating image…');

    case 'image_gen_failed':
      return chalk.red(`  ✗ image gen failed: ${clip(scalar(d.error), 50)}`);

    case 'progress':
    case 'status': {
      const msg = scalar(d.message ?? d.phase ?? d.stage);
      return msg ? dim(`  ⚙ ${clip(msg, 60)}`) : null;
    }

    case 'error':
      return chalk.red(`  ✗ ${clip(scalar(d.message ?? d.error) || 'error', 60)}`);

    // OUTPUT-pane / status-only / silent — not trace lines (controller owns these).
    case 'token':
    case 'answer':
    case 'answer_segment':
    case 'segment_end':
    case 'message':
    case 'final_answer':
    case 'partial':
    case 'complete':
    case 'done':
    case 'tool_call':
    case 'tool_result':
    case 'artifact_delivered':
    case 'clarification_needed':
    case 'approval_required':
    case 'image_gen_complete':
    case 'heartbeat':
    case 'keepalive':
    case 'debug':
    case 'thinking':
    case 'thinking_end':
    case 'session_start':
      return null;

    default: {
      // Pipeline substages are discriminated by `stage` (wire type is often
      // 'pipeline'); label by stage and prefer a human field, else a compact
      // scalar dump so telemetry (llm_route/thinking_budget/reasoning_summary)
      // is never silently swallowed in the TRACE pane.
      const label = scalar(d.stage) || event.type;
      let msg = scalar(d.message ?? d.content ?? d.detail ?? d.summary ?? d.status);
      if (!msg && (d.stage || event.type === 'pipeline')) {
        msg = Object.entries(d)
          .filter(([k, v]) => k !== 'type' && k !== 'stage' &&
            (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
          .slice(0, 8)
          .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
          .join(' ');
      }
      // The trace pane wraps (screen.ts), so don't pre-bake a `…` here — a low
      // clip was the real reason telemetry lines showed cut off. Keep a generous
      // upper bound only as a runaway guard; wrapping handles the rest.
      return msg ? dim(`  [${label}] ${clip(msg, 240)}`) : null;
    }
  }
}

/** Short STATUS-bar fragment for an event (the current stage), or null. */
export function formatStatus(event: SSEEvent): string | null {
  const d = event.data || {};
  switch (event.type) {
    case 'heartbeat':
    case 'keepalive': {
      const ms = d.elapsed_ms;
      const stage = scalar(d.stage ?? d.phase);
      return `working ${ms ? Math.round(Number(ms) / 1000) + 's' : ''}${stage ? ' · ' + stage : ''}`.trim();
    }
    case 'llm_start':
      return `LLM ${scalar(d.model) || ''}…`.trim();
    case 'progress':
    case 'status':
      return scalar(d.message ?? d.phase ?? d.stage) || null;
    case 'middleware_progress':
      return scalar(d.middleware ?? d.stage) || null;
    case 'plan_start':
      return 'planning…';
    case 'context_start':
      return 'gathering context…';
    default:
      return null;
  }
}

/** Extract {agent, model, effort, tier} updates from an event for the status bar. */
export function statusUpdate(event: SSEEvent): { agent?: string; model?: string; effort?: string; tier?: string } {
  const d = event.data || {};
  switch (event.type) {
    case 'session_start':
      return { agent: scalar(d.agent) || undefined };
    case 'classify':
    case 'classify_update':
      return {
        effort: scalar(d.effort?.level ?? d.effort) || undefined,
        tier: scalar(d.effort?.tier ?? d.tier) || undefined,
      };
    case 'model_select':
      return { model: scalar(d.model_selection?.recommended_model ?? d.model) || undefined };
    case 'llm_start':
    case 'llm_done':
    case 'llm_end': {
      const m = scalar(d.model_used ?? d.model);
      return m && m !== 'auto' && m !== 'unknown' ? { model: m } : {};
    }
    default:
      return {};
  }
}
