/**
 * TUI stream renderer — same shape as the plain `createStreamRenderer`, but
 * routes events into the blessed 3-pane surface instead of stdout.
 *
 * When AITHER_NEW_TRACE=1: timeline renderer with box-drawing trace tree,
 * ChatFormatter markdown + turn frames, theme-based status bar.
 * Otherwise: legacy formatTrace path (default).
 *
 *   • TRACE pane  ← timeline.render() (new) or formatTrace() events (legacy)
 *   • OUTPUT pane ← ChatFormatter turn frames + markdown (new) or raw streaming (legacy)
 *   • STATUS line ← theme COLORS + model/effort/elapsed (new) or bright cyan (legacy)
 */
import chalk from 'chalk';
import type { SSEEvent } from '../client.js';
import { renderMarkdown, stripOsc8, autoOpenImagesFromText, type StreamRenderer, type SessionProfile } from '../renderer.js';
import { formatStatus, formatTrace, statusUpdate } from '../formatters.js';
import type { TuiSurface } from './screen.js';
import { createTimeline, type TimelineRenderer } from './timeline.js';
import { createChatFormatter } from './chat-formatter.js';
import { COLORS } from './theme.js';
import { renderAvatar, statusFromTurn, type Affect, type AvatarStatus } from './avatar.js';
import { renderPipeline } from './pipeline-animator.js';
import { emptyNeuronState, accumulateNeuron, type NeuronState } from './neuron-activity-view.js';
import { parseThought, type Thought } from './reasoning-stream-view.js';
import type { FlameData } from './flame-graph-overlay.js';
import { emptyGraph, accumulateGraph, mergeGraphEvent, type KnowledgeGraph } from './knowledge-graph-overlay.js';

/** Optional hooks the REPL supplies to enrich the live render (affect → avatar). */
export interface TuiRendererOpts {
  getAffect?: () => Affect | null;
  /** When true, DON'T write the answer body to OUTPUT — the REPL reveals it in
   *  sync with AitherVoice audio instead (still tracks content for getContent). */
  suppressAnswerBody?: boolean;
  /** Voice mode: is audio ACTUALLY playing right now? Gates the talking mouth
   *  so it never flaps during silent token generation. */
  isSpeaking?: () => boolean;
}

export function createTuiRenderer(
  surface: TuiSurface,
  sessionId?: string,
  prompt?: string,
  rendererOpts?: TuiRendererOpts,
): StreamRenderer {
  const useNewTrace = process.env.AITHER_NEW_TRACE !== '0';
  // ── Live extras (P2): avatar + pipeline strip + buffered rich telemetry ──
  let animFrame = 0;                       // increments each ticker flush → drives blink/mouth/spinner
  const thoughts: Thought[] = [];          // for the Ctrl+R reasoning overlay
  let neuronState: NeuronState = emptyNeuronState();  // for the Ctrl+N neuron overlay
  let flameData: FlameData | null = null;  // for the Ctrl+F flame overlay
  const kg: KnowledgeGraph = emptyGraph();  // for the Ctrl+K session knowledge graph
  let sawError = false;
  let sawToken = false;
  const showAvatar = process.env.AITHER_AVATAR !== '0';
  const suppressBody = !!rendererOpts?.suppressAnswerBody;   // voice-synced reveal owns OUTPUT
  const timeline = useNewTrace ? createTimeline() : null;
  // Reflow to the REAL output-pane inner width, not a hardcoded 80 — otherwise
  // blessed's wrap:true re-wraps every line into ragged 1-3 word orphans.
  const chatFormatter = useNewTrace
    ? createChatFormatter({ paneWidth: surface.getOutputWidth?.() ?? 78 })
    : null;

  // Initialize timeline with user message label (clipped to 32 chars)
  if (timeline && prompt) {
    timeline.startTurn(prompt.slice(0, 32));
  }

  let content = '';
  let tokenStreamed = false;
  let eagerActive = false;
  let completePrinted = false;
  let terminalSeen = false;     // complete/error/timeout/interrupt reached us
  let answerCheckpoint: number | null = null;  // OUTPUT offset where the answer text begins
  let pendingFollowups: string[] = [];  // stashed on suggested_followups; rendered AFTER complete
  let userFramePrinted = false;  // track if we printed the user frame header

  const traceEvents: SSEEvent[] = [];
  const toolCalls: SessionProfile['tool_calls'] = [];
  const thinking: string[] = [];
  const errors: string[] = [];

  // ── Live trace ticker (new-trace only) ────────────────────────────────
  // The timeline is a pure state store; without this ticker nothing flushed
  // it to the trace pane until finish() — the pane froze all turn, then the
  // whole tree popped in at once. The ticker renders every 120ms while the
  // turn runs (diffed, so unchanged frames cost nothing) which also makes
  // the running turn's elapsed readout tick.
  const TICKER_INTERVAL_MS = 120;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let tickerActive = false;
  let lastTraceRender = '';

  /** Avatar status from the live turn state (drives the face expression).
   *  Voice mode (suppressBody): tokens stream silently while the answer is held
   *  back for the audio-synced reveal, so "streaming" must NOT open her mouth —
   *  she thinks until audio actually plays (rendererOpts.isSpeaking). */
  function avatarStatusNow(): ReturnType<typeof statusFromTurn> {
    return statusFromTurn({
      running: tickerActive && !terminalSeen,
      streaming: suppressBody ? !!rendererOpts?.isSpeaking?.() : (sawToken && !terminalSeen),
      errored: sawError,
      everRan: terminalSeen || sawToken,
    });
  }

  /**
   * Compose the trace pane: avatar face + animated pipeline strip + the timeline
   * tree. Prepending the header shifts the timeline's clickable row→node map, so
   * we re-key it by the prefix length (else clicking a tool row opens the wrong node).
   */
  function composeTrace(traceWidth: number, now: number, statusOverride?: AvatarStatus): { lines: string[]; rowToNodeMap: Map<number, any> } {
    const tl = timeline!.render(traceWidth, now);
    if (!showAvatar) return tl;
    const affect = rendererOpts?.getAffect?.() ?? undefined;
    const avatarLines = renderAvatar({ status: statusOverride ?? avatarStatusNow(), affect: affect || undefined }, animFrame);
    const pipeLines = renderPipeline(timeline!.currentStages(), traceWidth, animFrame);
    const prefix = [
      ...avatarLines,
      ...(pipeLines.length ? ['', ...pipeLines] : []),
      COLORS.muted('─'.repeat(Math.max(4, Math.min(traceWidth, 16)))),
    ];
    const rowToNodeMap = new Map<number, any>();
    for (const [row, node] of tl.rowToNodeMap) rowToNodeMap.set(row + prefix.length, node);
    return { lines: [...prefix, ...tl.lines], rowToNodeMap };
  }

  function tickerFlush(): void {
    if (!tickerActive || !timeline) return;
    try {
      animFrame++;
      const traceWidth = surface.getTraceWidth?.() ?? 40;
      const result = composeTrace(traceWidth, Date.now());
      const rendered = result.lines.join('\n');
      if (rendered !== lastTraceRender) {
        lastTraceRender = rendered;
        surface.setTracePanel(' trace ', result.lines);
        surface.setTraceRowToNodeMap?.(result.rowToNodeMap);
      }
    } catch { /* transient render fault — next tick recovers */ }
  }

  function startTicker(): void {
    if (ticker || !timeline) return;
    tickerActive = true;
    ticker = setInterval(tickerFlush, TICKER_INTERVAL_MS);
  }

  function stopTicker(): void {
    tickerActive = false;
    if (ticker) { clearInterval(ticker); ticker = null; }
  }
  let model = '';
  let agent = '';
  let effort = '';
  let tier = '';
  let stage = '';
  let answerTokens = 0;  // track answer token count for footer
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  function pushStatus(): void {
    const elapsed = `${((Date.now() - startTime) / 1000).toFixed(0)}s`;
    if (useNewTrace) {
      // New theme-based status: grouped segments with visual hierarchy
      // LEFT: agent identity (accent-colored); CENTER: model + effort; RIGHT: elapsed
      const agentStr = agent || 'aither';
      const modelStr = model || '…';
      const effortStr = effort ? `E${effort}` : '';
      const center = [modelStr, effortStr].filter(Boolean).join(' ');
      // Format: aither  ·  qwen3.6 E10  ║  277s
      const statusText = [
        COLORS.accent(agentStr),
        COLORS.muted('·'),
        center,
        COLORS.muted('║'),
        COLORS.muted(elapsed),
      ].join('  ');
      surface.setStatus(statusText);
    } else {
      // Legacy: bright cyan background block
      const bits = [agent || 'aither', model || '…', effort ? `E${effort}` : '', tier, stage, elapsed]
        .filter(Boolean).join(' · ');
      surface.setStatus(bits);
    }
  }

  function header(kind: string, reason?: string): string {
    const r = reason ? chalk.dim(`  (${reason})`) : '';
    if (kind === 'continuation') return chalk.cyan('↳ Continuing') + r;
    if (kind === 'refinement') return chalk.cyan('↻ Refining') + r;
    return chalk.cyan('💬 Initial') + r;
  }

  /** Summarize a tool_result into the TRACE pane (keeps OUTPUT answer-only). */
  function traceToolResult(result: any): void {
    const name = result.tool || 'tool';
    const ok = result.success !== false;
    const icon = ok ? chalk.green('✓') : chalk.red('✗');
    if (ok && result.output) {
      try {
        const parsed = JSON.parse(result.output);
        if (Array.isArray(parsed.results) && parsed.results.length) {
          surface.traceLine(`  ${icon} ${chalk.bold(name)} — ${parsed.results.length} results`);
          parsed.results.slice(0, 3).forEach((r: any, i: number) =>
            surface.traceLine(chalk.dim(`     ${i + 1}. ${String(r.title || r.url || 'result').slice(0, 50)}`)));
        } else if (parsed.content) {
          surface.traceLine(`  ${icon} ${chalk.bold(name)} ${chalk.dim(String(parsed.title || '').slice(0, 40))}`);
        } else {
          surface.traceLine(`  ${icon} ${chalk.bold(name)} ${chalk.dim(JSON.stringify(parsed).slice(0, 60))}`);
        }
      } catch {
        surface.traceLine(`  ${icon} ${chalk.bold(name)} ${chalk.dim(String(result.output).replace(/\s+/g, ' ').slice(0, 60))}`);
      }
    } else if (!ok) {
      surface.traceLine(`  ${icon} ${chalk.bold(name)} ${chalk.red(String(result.output || result.error || 'error').slice(0, 50))}`);
    } else {
      surface.traceLine(`  ${icon} ${name}`);
    }
  }

  return {
    onEvent(event: SSEEvent) {
      traceEvents.push(event);
      const d = event.data || {};

      // Route to timeline if new trace is enabled; the ticker flushes it to
      // the trace pane live (started on the first ingested event).
      if (timeline) {
        timeline.ingest(event);
        startTicker();
      }

      // Capture rich telemetry for the overlays (Ctrl+F/N/R) + avatar status.
      switch (event.type) {
        case 'token': sawToken = true; break;
        case 'thought': thoughts.push(parseThought(d)); break;
        case 'neuron_fire': case 'neurons_start': case 'neurons_done':
          accumulateNeuron(neuronState, event.type, d); break;
        case 'context_flame_graph': flameData = d as FlameData; break;
        case 'error': case 'llm_error': case 'stream_timeout': case 'stream_interrupted':
          sawError = true; break;
      }
      // Session knowledge graph (Ctrl+K): merge the backend event when present,
      // else accumulate client-side from the events we already see.
      if (event.type === 'knowledge_graph') mergeGraphEvent(kg, d);
      else accumulateGraph(kg, event.type, d);

      const su = statusUpdate(event);
      if (su.agent) agent = su.agent;
      const _realModel = (m: any) => typeof m === 'string' && m && m !== 'auto' && m !== 'unknown';
      if (_realModel(su.model)) model = su.model!;
      // Generic capture: any event that carries a real model id (model_select,
      // llm_route, llm_done, plan) sets it — so the footer isn't 'unknown'.
      else if (_realModel(d.model)) model = d.model;
      else if (_realModel(d.model_used)) model = d.model_used;
      if (su.effort) effort = su.effort;
      if (su.tier) tier = su.tier;
      const st = formatStatus(event);
      if (st && !useNewTrace) stage = st;  // legacy only: stage in status bar
      pushStatus();

      switch (event.type) {
        case 'session_start':
          if (d.agent) agent = d.agent;
          if (d.model && d.model !== 'auto' && d.model !== 'unknown') model = d.model;
          break;

        case 'answer_segment': {
          eagerActive = true;
          // A later segment (grounded/refinement/continuation) supersedes the
          // eager first-pass preview ("Let me check my memory…"): clear the
          // already-streamed preview back to the answer checkpoint so the two
          // don't concatenate live ("Let me check…The provided…"). `complete`
          // re-renders the authoritative answer via replaceOutputFrom anyway.
          const segIdx = Number(d.segment_index ?? 0);
          // A continuation with `append:true` KEEPS the standing first-pass answer
          // and adds to it (Genesis already streams a "\n\n" break + only the new
          // material, and sends the full accumulated text on `complete`). Only a
          // NON-append later segment supersedes a throwaway eager preview — clearing
          // there stops "Let me check…The provided…" from concatenating live.
          if (segIdx > 0 && answerCheckpoint != null && !d.append) {
            surface.replaceOutputFrom(answerCheckpoint, '');
            content = '';
          }
          if (!userFramePrinted && useNewTrace && !suppressBody) {
            // Opens the ASSISTANT's answer frame — the body that follows is the
            // model's, not the user's. It was labelled 'you' (hardcoded, never a
            // role lookup) which put every answer under a "you" header while the
            // user's own prompt was echoed separately above it by the REPL.
            userFramePrinted = true;
          } else if (!useNewTrace && !suppressBody) {
            surface.outputLine(header(d.kind || 'initial', d.reason));
          }
          tokenStreamed = false;
          break;
        }

        case 'token': {
          const t = d.t || d.token || '';
          if (t) {
            content += t; tokenStreamed = true;
            if (!suppressBody) {
              if (answerCheckpoint == null) answerCheckpoint = surface.markCheckpoint();
              surface.appendOutput(t);
            }
          }
          break;
        }

        case 'segment_end':
          if (!suppressBody) surface.appendOutput('\n');
          break;

        case 'partial':
          if (!tokenStreamed && d.content && !suppressBody) {
            if (answerCheckpoint == null) answerCheckpoint = surface.markCheckpoint();
            surface.appendOutput(String(d.content));
          }
          break;

        case 'message':
        case 'answer':
        case 'final_answer': {
          const text = d.answer || d.content || d.message || '';
          if (!eagerActive && !tokenStreamed && text) {
            content += String(text);
            if (!suppressBody) {
              if (answerCheckpoint == null) answerCheckpoint = surface.markCheckpoint();
              surface.appendOutput(String(text));
            }
          } else if (text) {
            // The grounded follow-up answer (ran tools + gathered context) arrives
            // here AFTER the eager fast-pass streamed. It supersedes that throwaway
            // preview — capture it so `complete` re-renders the authoritative answer
            // (replaceOutputFrom) instead of leaving the weak first pass on screen.
            // Matches renderer.ts (the plain REPL) which does `content = data.answer`.
            content = String(text);
            // If this eager segment printed a header ("💬 Initial …") but never
            // streamed any tokens (the engine returned the answer as one event,
            // e.g. the search fastpath), show it NOW rather than waiting for
            // 'complete' — an interrupted/timed-out stream would otherwise leave
            // the user staring at just the preamble. 'complete' re-renders via
            // replaceOutputFrom(answerCheckpoint).
            if (!tokenStreamed && answerCheckpoint == null && !suppressBody) {
              answerCheckpoint = surface.markCheckpoint();
              surface.appendOutput(String(text));
            }
          }
          break;
        }

        case 'thinking': {
          const thought = d.thought || d.content || '';
          if (thought) thinking.push(String(thought));
          break;
        }

        case 'tool_call': {
          // Genesis emits a flat {name, tool, args}; some backends emit {tools:[…]}.
          const list = Array.isArray(d.tools) ? d.tools
            : Array.isArray(d.tool_calls) ? d.tool_calls
            : [{ name: d.name || d.tool, args: d.args || d.arguments }];
          for (const tool of list) {
            const name = tool.name || tool.function?.name || tool.tool || 'tool';
            const args = tool.args || tool.arguments;
            toolCalls.push({ name, args: args || {}, timestamp: Date.now() });
            if (!useNewTrace) {   // legacy pane only; timeline ingests tool_call itself
              let arg = '';
              if (args) {
                const key = args.query || args.url || args.task || args.prompt || args.path || args.code;
                arg = key ? chalk.dim(` → ${String(key).slice(0, 60)}`) : '';
              }
              surface.traceLine(chalk.yellow(`  ⚡ ${name}`) + arg);
            }
          }
          break;
        }

        case 'tool_result':
          // Legacy pane only; the timeline ingests tool_result itself.
          if (!useNewTrace) for (const r of (d.results || [])) traceToolResult(r);
          break;

        case 'artifact_delivered': {
          const fn = d.filename || d.file || d.path || 'artifact';
          const idx = d.index != null ? ` (/get ${d.index})` : '';
          surface.outputLine(chalk.cyan(`📦 ${fn}`) + chalk.dim(idx));
          break;
        }

        case 'clarification_needed':
        case 'approval_required': {
          const q = Array.isArray(d.questions)
            ? d.questions.map((x: any) => (typeof x === 'string' ? x : x.question || x.text || '?')).join('  •  ')
            : (d.action || d.message || '');
          surface.outputLine(chalk.yellow(`⏸ ${event.type === 'approval_required' ? 'Approval' : 'Clarify'}: `) + q);
          break;
        }

        case 'image_gen_complete':
          surface.outputLine(chalk.green('✓ image: ') + chalk.dim(d.url || d.path || ''));
          break;

        case 'error':
        case 'llm_error': {
          terminalSeen = true;
          const msg = d.message || d.error || 'error';
          errors.push(String(msg));
          surface.outputLine(chalk.red('✗ ' + msg));
          if (!useNewTrace) {   // timeline ingests error/llm_error itself (→ error stage)
            const line = formatTrace(event); if (line) surface.traceLine(line);
            surface.finishTraceTurn('error');
          }
          tickerFlush(); stopTicker();  // last live frame shows the error, then stop
          break;
        }

        case 'stream_timeout':
        case 'stream_interrupted': {
          // The transport died mid-turn (backend/LB restart, network reset) or
          // went silent past the chunk timeout. Without this case the turn was
          // stamped ✓ done and the grounded follow-up answer vanished — say so.
          terminalSeen = true;
          const why = event.type === 'stream_timeout'
            ? `no data for ${Math.round((Number(d.timeout_ms) || 120000) / 1000)}s`
            : String(d.error || 'connection lost');
          errors.push(`stream ${event.type === 'stream_timeout' ? 'timeout' : 'interrupted'}: ${why}`);
          surface.outputLine(chalk.yellow(`⚠ stream ${event.type === 'stream_timeout' ? 'timed out' : 'interrupted'} — ${why}`));
          surface.outputLine(chalk.dim('  The backend connection dropped mid-turn (Genesis/LB restart?) — any text above is partial.'));
          if (!useNewTrace) surface.finishTraceTurn('error');
          tickerFlush(); stopTicker();  // last live frame shows the interruption, then stop
          break;
        }

        case 'llm_done':
        case 'llm_end':
          if (_realModel(d.model_used)) model = d.model_used; else if (_realModel(d.model)) model = d.model;
          if (!useNewTrace) { const line = formatTrace(event); if (line) surface.traceLine(line); }
          break;

        case 'complete':
        case 'done': {
          terminalSeen = true;
          if (completePrinted) break;
          completePrinted = true;
          // Don't let a terminal 'unknown'/'auto' clobber the model we already saw.
          if (d.model && d.model !== 'unknown' && d.model !== 'auto') model = d.model;
          // Track answer tokens for new trace footer
          if (d.tokens_used != null) answerTokens = Number(d.tokens_used);
          // Defensive: if the terminal event itself carries the authoritative
          // answer (and no separate `answer` event landed), prefer it over the
          // eager fast-pass so the grounded result is what gets rendered.
          { const fin = d.answer || d.response || d.content || ''; if (fin) content = String(fin); }

          if (suppressBody) {
            // Voice-synced mode: the REPL reveals the answer in time with the
            // audio, so we skip the instant body/footer here. Still expose
            // follow-ups so digit-select works on the next input.
            if (pendingFollowups.length) surface.setPendingFollowups(pendingFollowups);
          } else if (useNewTrace && chatFormatter) {
            // New trace path: use ChatFormatter for turn frame + markdown body + footer.
            // Refresh the reflow width each turn so a terminal resize is respected.
            chatFormatter.setPaneWidth(surface.getOutputWidth?.() ?? 78);
            const ms = d.duration_ms != null ? Number(d.duration_ms) : 0;
            const turn = chatFormatter.formatTurn(prompt || '', content, {
              agent, model, tokensUsed: answerTokens, durationMs: ms,
            });
            // Replace streamed answer with formatted body
            if (content && answerCheckpoint != null) {
              const bodyText = '\n' + turn.body.join('\n');
              surface.replaceOutputFrom(answerCheckpoint, bodyText);
            }
            // Print footer (muted, right-aligned metrics)
            surface.outputLine(turn.footer);
            // Print followups if any
            if (pendingFollowups.length) {
              const followupLines = chatFormatter.formatFollowups(pendingFollowups);
              followupLines.forEach(l => surface.outputLine(l));
              surface.setPendingFollowups(pendingFollowups);
            }
          } else {
            // Legacy path: original markdown + footer rendering
            if (content && answerCheckpoint != null) {
              surface.replaceOutputFrom(answerCheckpoint, '\n' + stripOsc8(renderMarkdown(content)).replace(/\n$/, ''));
            } else if (content && answerCheckpoint == null) {
              surface.outputLine(stripOsc8(renderMarkdown(content)).replace(/\n$/, ''));
            }
            const ms = d.duration_ms != null ? `${(Number(d.duration_ms) / 1000).toFixed(1)}s` : '';
            surface.outputLine(chalk.dim(`── ${[agent, model, ms].filter(Boolean).join(' · ')}`));
            // Follow-up chips AFTER the answer (complete just rewrote the answer
            // region via replaceOutputFrom, so they couldn't be printed earlier).
            if (pendingFollowups.length) {
              surface.outputLine(chalk.dim('  Next →'));
              pendingFollowups.forEach((t, i) =>
                surface.outputLine('  ' + chalk.cyan(`[${i + 1}]`) + ' ' + chalk.dim(String(t))));
              surface.setPendingFollowups(pendingFollowups);  // enable digit-select for next input
            }
          }
          autoOpenImagesFromText(content);  // pop generated images in the OS viewer
          if (!useNewTrace) surface.finishTraceTurn('done');  // legacy only
          break;
        }

        case 'suggested_followups': {
          // Stash now; render in 'complete' (after the answer is finalised).
          const items = Array.isArray(d.followups) ? d.followups.map((x: any) => String(x)) : [];
          if (items.length) pendingFollowups = items;
          break;
        }

        case 'notebook_ready': {
          // A clarified plan was turned into a notebook. formatTrace drops this
          // (no message/stage field), so surface the id or the user never knows.
          const id = String(d.notebook_id || d.plan_id || '').trim();
          surface.outputLine(chalk.cyan(`  📓 Notebook ready${id ? `: ${id}` : ''}`));
          break;
        }

        case 'stream_warning':
          // 60s+ of stream silence (e.g. reasoning model cold-start). Reassure
          // the user the turn isn't dead. Legacy pane only — in new-trace the
          // running turn's live ticking elapsed already signals it's alive.
          if (!useNewTrace) surface.traceLine(chalk.yellow(`  ⏳ ${d.message || 'still working — model may be warming up…'}`));
          break;

        case 'backend_switch':
          // Mid-turn failover to the cloud gateway. Significant (the backend
          // changed under the turn) → surface in BOTH trace modes.
          surface.outputLine(chalk.yellow(`  ⚠ ${d.message || 'Switched to the cloud gateway.'}`));
          break;

        case 'answer':
        case 'suggested_followups':
          // New trace: these are handled in ChatFormatter, not trace pane
          if (useNewTrace) break;
          // Legacy: formatTrace handles these
          { const line = formatTrace(event); if (line) surface.traceLine(line); }
          break;

        case 'heartbeat':
        case 'keepalive':
        case 'debug':
        case 'thinking_end':
          break;

        default: {
          // Legacy trace path only
          if (!useNewTrace) {
            const line = formatTrace(event);
            if (line) surface.traceLine(line);
          }
        }
      }
    },

    getContent() { return content; },

    finish(aborted?: boolean) {
      surface.appendOutput('\n');

      // Stop the live ticker BEFORE the final render (no writes after finish).
      stopTicker();

      // New trace path: final composed render (avatar + pipeline + timeline).
      if (useNewTrace && timeline) {
        const traceWidth = surface.getTraceWidth?.() ?? 40;
        const result = composeTrace(traceWidth, Date.now());
        surface.setTracePanel(' trace ', result.lines);
        surface.setTraceRowToNodeMap?.(result.rowToNodeMap);
      }

      if (aborted) {
        if (!useNewTrace) surface.finishTraceTurn('error');  // legacy only
      } else if (!terminalSeen) {
        // Stream EOF'd with no complete/error/timeout event at all — a clean
        // TCP close from a backend that died mid-turn looks exactly like this.
        // Marking it ✓ done hid the loss; flag it so the user knows to resend.
        surface.outputLine(chalk.yellow('⚠ stream ended before completion — the connection closed mid-turn.'));
        surface.outputLine(chalk.dim('  Any text above is partial (the refined answer never arrived).'));
        errors.push('stream ended before completion (no terminal event)');
        if (!useNewTrace) surface.finishTraceTurn('error');  // legacy only
      } else {
        if (!useNewTrace) surface.finishTraceTurn('done');  // legacy only
      }
      stage = ''; pushStatus(); surface.render();
    },

    getTrace() { return traceEvents; },

    getSessionProfile(): SessionProfile {
      return {
        session_id: sessionId || '', prompt: prompt || '', started_at: startedAt,
        duration_ms: Date.now() - startTime, event_count: traceEvents.length,
        model, agent, events: traceEvents, tool_calls: toolCalls,
        thinking_traces: thinking, context_sources: {}, errors,
      };
    },

    /** Return the timeline instance (new-trace only, null otherwise). */
    getTimeline() { return timeline; },

    /** Buffered rich telemetry for the overlays (Ctrl+F/N/R). */
    getThoughts() { return thoughts; },
    getNeuronState() { return neuronState; },
    getFlameData() { return flameData; },
    getKnowledgeGraph() { return kg; },

    /** Re-render the trace pane between turns so Aither keeps breathing/blinking
     *  (idle) and her mouth moves while she's speaking. Diffed → cheap when the
     *  frame is unchanged. No-op if the live turn ticker is running. */
    renderIdleFrame(status: AvatarStatus = 'idle') {
      if (!timeline || tickerActive) return;
      try {
        animFrame++;
        const traceWidth = surface.getTraceWidth?.() ?? 40;
        const result = composeTrace(traceWidth, Date.now(), status);
        const rendered = result.lines.join('\n');
        if (rendered !== lastTraceRender) {
          lastTraceRender = rendered;
          surface.setTracePanel(' trace ', result.lines);
          surface.setTraceRowToNodeMap?.(result.rowToNodeMap);
        }
      } catch { /* transient — next idle tick recovers */ }
    },
  };
}
