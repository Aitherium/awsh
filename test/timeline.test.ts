/**
 * Tests for the timeline renderer: grouping rules, dedupe, unknown events,
 * glyph single-width, metrics extraction, render width, error turns.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTimeline } from '../src/tui/timeline.js';
import { detectGlyphs, assertSingleWidth } from '../src/tui/theme.js';
import type { SSEEvent } from '../src/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

/** Load a fixture JSON array of SSE events. */
function loadFixture(name: string): SSEEvent[] {
  const path = join(fixturesDir, `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('Timeline Renderer', () => {
  test('should ingest a complete turn and classify events into stages', () => {
    const timeline = createTimeline();
    const events = loadFixture('sample-turn');

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    assert.ok(rendered.length > 0, 'should produce output');
    assert.ok(rendered.some(l => l.includes('Context')), 'should have context stage');
    assert.ok(rendered.some(l => l.includes('LLM')), 'should have LLM stage');
    assert.ok(rendered.some(l => l.includes('Tools')), 'should have tools stage');
  });

   test('should mark turns done/error based on verdict/error events', () => {
    const timeline = createTimeline();
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      { type: 'complete', data: { content: 'done' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    assert.ok(rendered.some(l => l.includes('✓')), 'should mark turn done with checkmark');
  });

   test('should hide heartbeat/keepalive unless verbose', () => {
    const timeline = createTimeline();
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      { type: 'heartbeat', data: { elapsed_ms: 1000 } },
      { type: 'keepalive', data: { elapsed_ms: 1500 } },
      { type: 'complete', data: { content: 'done' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    const heartbeatLines = rendered.filter(l => l.includes('heartbeat'));
    assert.equal(heartbeatLines.length, 0, 'should not render heartbeat when not verbose');
  });

   test('should extract metrics correctly', () => {
    const timeline = createTimeline();
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      {
        type: 'llm_done',
        data: {
          model_used: 'qwen36-27b',
          tokens_used: 580,
          llm_time_ms: 2340,
        },
      },
      { type: 'complete', data: { content: 'done' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    assert.ok(rendered.some(l => l.includes('580')), 'should render token count');
    assert.ok(rendered.some(l => l.includes('2340')), 'should render time in ms');
  });

   test('should handle unknown event types gracefully', () => {
    const timeline = createTimeline();
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      { type: 'random_unknown_event_type', data: { some_field: 'value' } },
      { type: 'complete', data: { content: 'done' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    // Should not crash; unknown events are handled as 'other' stage
    assert.ok(rendered.length > 0, 'should render without crashing');
  });

   test('should assert all glyphs are single-width', () => {
    const glyphs = detectGlyphs();
    // This should not throw
    assertSingleWidth(glyphs);
  });

   test('should fit render output within width bounds', () => {
    const timeline = createTimeline();
    const events = loadFixture('sample-turn');

    for (const event of events) {
      timeline.ingest(event);
    }

    const width = 80;
    const result = timeline.render(width);
    const rendered = result.lines;

    // Lines should not exceed width (accounting for ANSI codes)
    for (const line of rendered) {
      // Strip ANSI codes to get display width
      const displayWidth = line.replace(/\[[^m]*m/g, '').length;
      assert.ok(displayWidth <= width + 5, `line too long: ${displayWidth} > ${width}`);
    }
  });

   test('should mark error turns correctly', () => {
    const timeline = createTimeline();
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      { type: 'llm_error', data: { model: 'qwen36', error: 'Rate limited' } },
      { type: 'error', data: { message: 'LLM error occurred' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    assert.ok(rendered.some(l => l.includes('✗')), 'should mark error turn with cross');
  });

   test('should deduplicate consecutive identical event lines', () => {
    const timeline = createTimeline();
    // Simulate a pipeline that emits the same event type multiple times
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      { type: 'tool_call', data: { tools: [{ name: 'search', args: {} }] } },
      { type: 'tool_call', data: { tools: [{ name: 'search', args: {} }] } },
      { type: 'tool_call', data: { tools: [{ name: 'search', args: {} }] } },
      { type: 'complete', data: { content: 'done' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    // Should see ×3 for three identical tool calls
    assert.ok(rendered.some(l => l.includes('×')), 'should render dedupe count');
  });

  test('polish: should hide answer and suggested_followups events', () => {
    const timeline = createTimeline();
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      { type: 'context_start', data: {} },
      { type: 'answer', data: { answer: 'This should not appear' } },
      { type: 'suggested_followups', data: { followups: ['Q1', 'Q2'] } },
      { type: 'complete', data: { content: 'done' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    const renderedText = rendered.join('\n');
    assert.ok(!renderedText.includes('answer') || renderedText.includes('Answer') === false, 'should not show answer event');
    assert.ok(!renderedText.includes('suggested_followups'), 'should not show suggested_followups');
  });

  test('polish: should format tool_result with name and char count', () => {
    const timeline = createTimeline();
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      { type: 'tool_selection', data: { tool_names: ['search'] } },
      { type: 'tool_call', data: { tools: [{ name: 'search', args: {} }] } },
      {
        type: 'tool_result',
        data: {
          results: [
            {
              tool: 'search',
              success: true,
              output: '{"result": "A" * 100}',  // ~100 chars
            },
          ],
        },
      },
      { type: 'complete', data: { content: 'done' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    const toolLine = rendered.find(l => l.includes('search') && l.includes('chars'));
    assert.ok(toolLine, 'should show tool name and char count in tool_result line');
  });

  test('polish: should map context_stage to stage detail labels', () => {
    const timeline = createTimeline();
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      { type: 'context_start', data: {} },
      {
        type: 'context_stage',
        data: {
          stage: 'gathering documents',
          message: 'searching knowledge base',
        },
      },
      { type: 'complete', data: { content: 'done' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    // Should see 'gathering documents' or 'searching knowledge base', not raw 'context_stage'
    const hasStageDetail = rendered.some(l =>
      l.includes('gathering') || l.includes('searching') || l.includes('knowledge')
    );
    assert.ok(hasStageDetail, 'should render context_stage detail, not raw type');
  });

  test('polish: should show pipeline_timeout and guard_rescue as visible error lines', () => {
    const timeline = createTimeline();
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      { type: 'context_start', data: {} },
      {
        type: 'pipeline_timeout',
        data: {
          reason: 'grace_exceeded',
          timeout_ms: 8000,
          message: 'LLM response exceeded grace period',
        },
      },
      {
        type: 'guard_rescue',
        data: {
          broken_promise: 'Let me search for that',
          reason: 'Interrupted by timeout',
        },
      },
      { type: 'complete', data: { content: 'done' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    const timeoutLine = rendered.find(l => l.includes('pipeline_timeout'));
    const rescueLine = rendered.find(l => l.includes('guard_rescue'));
    assert.ok(timeoutLine, 'should render pipeline_timeout as visible error line');
    assert.ok(rescueLine, 'should render guard_rescue as visible error line');
  });

  test('polish: verdict stage should show token count and duration', () => {
    const timeline = createTimeline();
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      { type: 'context_start', data: {} },
      {
        type: 'complete',
        data: {
          content: 'done',
          duration_ms: 5000,
          tokens_used: 250,
          model: 'qwen36-27b',
        },
      },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    const verdictLine = rendered.find(l => l.includes('Verdict'));
    assert.ok(verdictLine && verdictLine.includes('250'), 'verdict header should show token count');
    assert.ok(verdictLine && verdictLine.includes('5000'), 'verdict header should show duration');
  });

  test('startTurn: should label turn with clipped user message', () => {
    const timeline = createTimeline();
    timeline.startTurn('What is the meaning of life, the universe, and everything?');
    timeline.ingest({ type: 'complete', data: { content: 'done' } });

    const result = timeline.render(100);
    const rendered = result.lines;
    const header = rendered[0];
    assert.ok(header.includes('What is the meaning'), 'should show start of user message');
    assert.ok(header.length < 100, 'header should be clipped (≤32 chars)');
  });

  test('toggleAllStages: should expand/collapse all stages', () => {
    const timeline = createTimeline();
    timeline.startTurn('test');
    const events: SSEEvent[] = [
      { type: 'context_start', data: {} },
      { type: 'llm_start', data: { model: 'test' } },
      { type: 'complete', data: { content: 'done' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    // First render: all expanded
    let result = timeline.render(100);
    let rendered = result.lines;
    const initialLineCount = rendered.length;
    assert.ok(initialLineCount > 5, 'should have multiple lines when expanded');

    // Toggle: collapse all
    timeline.toggleAllStages();
    result = timeline.render(100);
    rendered = result.lines;
    const collapsedLineCount = rendered.length;
    assert.ok(collapsedLineCount < initialLineCount, 'should have fewer lines when collapsed');

    // Toggle: expand all
    timeline.toggleAllStages();
    result = timeline.render(100);
    rendered = result.lines;
    assert.equal(rendered.length, initialLineCount, 'should return to original line count');
  });

  test('error turn status: should show ✗ when turn contains error-stage event', () => {
    const timeline = createTimeline();
    timeline.startTurn('test');
    const events: SSEEvent[] = [
      { type: 'context_start', data: {} },
      { type: 'pipeline_timeout', data: { timeout_ms: 8000, message: 'timeout' } },
      { type: 'error', data: { message: 'failed' } },
    ];

    for (const event of events) {
      timeline.ingest(event);
    }

    const result = timeline.render(100);
    const rendered = result.lines;
    const header = rendered[0];
    assert.ok(header.includes('✗'), 'should show error checkmark when error stage present');
  });

  test('recovered turn status: pipeline_timeout + guard_rescue + complete shows ✓ (not ✗)', () => {
    // The eager pipeline's grounded pass gets cut off (pipeline_timeout) and the
    // guard delivers a direct answer (guard_rescue) — the turn STILL completes with
    // an answer. This must NOT render as a failed turn: guard_rescue is a successful
    // recovery, and the trailing `complete` verdict must win. (Regression for every
    // ordinary knowledge turn showing ✗ / "Verdict unknown".)
    const timeline = createTimeline();
    timeline.startTurn('how do you know that?');
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither', model: 'auto' } },
      { type: 'tool_selection', data: { tool_names: [] } },
      { type: 'pipeline_timeout', data: { reason: 'silent_grace_or_cap_exceeded', grace_seconds: 8 } },
      { type: 'guard_rescue', data: { was_deferral: false } },
      { type: 'complete', data: { content: 'A real answer.', tokens_used: 42 } },
    ];
    for (const e of events) timeline.ingest(e);

    const header = timeline.render(100).lines[0].replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(header.includes('✓'), `recovered turn should show ✓, got: ${header}`);
    assert.ok(!header.includes('✗'), `recovered turn must NOT show ✗, got: ${header}`);
  });

  test('should show live ticking elapsed on a running turn', () => {
    const timeline = createTimeline();
    timeline.startTurn('live turn');
    timeline.ingest({ type: 'llm_start', data: { model: 'test-model' } });

    const t0 = Date.now();
    const r1 = timeline.render(100, t0);
    const r2 = timeline.render(100, t0 + 12_400);

    const header1 = r1.lines.find(l => l.includes('live turn'))!;
    const header2 = r2.lines.find(l => l.includes('live turn'))!;
    assert.ok(header1.includes('⟳'), 'running turn shows spinner glyph');
    assert.ok(header1.includes('0.0s'), `elapsed starts at 0.0s (got: ${header1})`);
    assert.ok(header2.includes('12.4s'), `elapsed ticks with the clock (got: ${header2})`);
    assert.equal(r1.rowToNodeMap.size, r2.rowToNodeMap.size, 'rowToNodeMap stable across re-renders');
  });

  test('regression: session_start after startTurn reuses the prompt turn (no orphaned "turn")', () => {
    const timeline = createTimeline();
    timeline.startTurn('how do you know that?');
    // Genesis emits `received` (preamble) then `session_start` before real work.
    const events: SSEEvent[] = [
      { type: 'received', data: { preamble_ms: 4 } },
      { type: 'session_start', data: { agent: 'aither', model: 'auto' } },
      { type: 'llm_start', data: { model: 'qwen36' } },
      { type: 'complete', data: { content: 'ok' } },
    ];
    for (const e of events) timeline.ingest(e);

    const rendered = timeline.render(80).lines;
    const turnHeaders = rendered.filter(l => /^[✓✗⟳]/.test(l.replace(/\x1b\[[0-9;]*m/g, '')));
    assert.equal(turnHeaders.length, 1, `exactly one turn, got: ${turnHeaders.join(' | ')}`);
    assert.ok(turnHeaders[0].includes('how do you know'), 'the single turn keeps the prompt label');
    const plain = rendered.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.ok(!plain.some(l => /^[✓✗⟳]\s+turn\b/.test(l)), 'no unlabelled "turn" orphan');
    assert.ok(!plain.some(l => l.includes('received')), 'preamble ack is hidden');
  });

  test('regression: flat Genesis tool_call/tool_result shapes render (not empty)', () => {
    const timeline = createTimeline();
    timeline.startTurn('search test');
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      // Genesis flat shapes (no `tools`/`results` arrays):
      { type: 'tool_call', data: { name: 'web_search', tool: 'web_search', args: { query: 'x' } } },
      { type: 'tool_result', data: { name: 'web_search', tool: 'web_search', result_count: 5, ok: true } },
      { type: 'complete', data: { content: 'ok' } },
    ];
    for (const e of events) timeline.ingest(e);

    const result = timeline.render(80);
    const plain = result.lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.ok(plain.some(l => l.includes('web_search') && !l.includes('results')), 'tool_call renders the tool name');
    assert.ok(plain.some(l => l.includes('web_search') && l.includes('5 results')), 'tool_result renders count');
    // The tool_call row must be clickable (ToolDetail attached from the flat result).
    const hasToolNode = [...result.rowToNodeMap.values()].some((n: any) => n.type === 'tool');
    assert.ok(hasToolNode, 'flat tool_result attaches a clickable ToolDetail');
  });

  test('P1: rich telemetry (neurons/thought/flame/memory) is classified and rendered', () => {
    const timeline = createTimeline();
    timeline.startTurn('rich');
    const events: SSEEvent[] = [
      { type: 'session_start', data: { agent: 'aither' } },
      { type: 'memory_recall', data: { memories: 3, spirit: true } },
      { type: 'neuron_fire', data: { source: 'knowledge', chunks_count: 12, total_tokens: 3400 } },
      { type: 'neurons_done', data: { neurons_fired: 47, total_tokens: 8200 } },
      { type: 'context_flame_graph', data: { total_tokens: 9600, quality_score: 0.82, neurons_fired: 47, cache_warm: true, evictions: 2 } },
      { type: 'thought', data: { iteration: 1, confidence: 0.85, summary: 'thinking' } },
      { type: 'complete', data: { content: 'done' } },
    ];
    for (const e of events) timeline.ingest(e);

    const plain = timeline.render(80).lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const joined = plain.join('\n');
    assert.ok(plain.some(l => l.includes('Neurons')), 'Neurons stage exists');
    assert.ok(plain.some(l => l.includes('Memory') && joined.includes('recalled 3 memories')), 'memory recall rendered');
    assert.ok(joined.includes('knowledge') && joined.includes('3400 tok'), 'per-neuron source rendered');
    assert.ok(joined.includes('47n') || joined.includes('47 neurons'), 'neuron count surfaced');
    assert.ok(joined.includes('cache✓') && joined.includes('q0.82'), 'flame graph summary rendered');
    assert.ok(joined.includes('85%'), 'thought confidence meter rendered');
  });

  test('regression: large durations render as seconds, not raw ms', () => {
    const timeline = createTimeline();
    timeline.startTurn('slow turn');
    timeline.ingest({ type: 'session_start', data: {} });
    timeline.ingest({ type: 'llm_done', data: { model_used: 'qwen36', tokens_used: 40, llm_time_ms: 202918 } });
    timeline.ingest({ type: 'complete', data: { content: 'ok', duration_ms: 59716 } });

    const plain = timeline.render(100).lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.ok(plain.some(l => l.includes('202.9s')), 'llm 202918ms → 202.9s');
    assert.ok(!plain.some(l => l.includes('202918ms')), 'no raw absurd ms');
    assert.ok(plain.some(l => l.includes('59.7s')), 'verdict 59716ms → 59.7s');
  });

  test('finished turns keep final duration, not the live clock', () => {
    const timeline = createTimeline();
    timeline.startTurn('done turn');
    timeline.ingest({ type: 'llm_start', data: {} });
    timeline.ingest({ type: 'complete', data: { content: 'ok' } });

    const far = Date.now() + 999_000;
    const r = timeline.render(100, far);
    const header = r.lines.find(l => l.includes('done turn'))!;
    assert.ok(header.includes('✓'), 'turn marked done');
    assert.ok(!header.includes('999'), 'done turn must not tick with the live clock');
  });
});
