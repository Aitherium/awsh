/**
 * Tests for the TUI controller's live trace ticker: the trace pane must
 * receive intermediate renders DURING a turn (not just one at finish), and
 * the ticker must stop cleanly at finish/error so no writes leak after.
 */
import { strict as assert } from 'assert';
import { test, describe, mock } from 'node:test';
import { createTuiRenderer } from '../src/tui/controller.js';
import type { TuiSurface } from '../src/tui/screen.js';

function mockSurface(calls: { tracePanel: number; rowMap: number }): TuiSurface {
  return {
    screen: {}, input: {},
    appendOutput: () => {}, outputLine: () => {},
    markCheckpoint: () => 0, replaceOutputFrom: () => {}, prependOutput: () => {},
    traceLine: () => {}, startTraceTurn: () => {}, finishTraceTurn: () => {},
    setStatus: () => {},
    setTracePanel: () => { calls.tracePanel++; },
    getTraceWidth: () => 80,
    setTraceRowToNodeMap: () => { calls.rowMap++; },
    setOutputLabel: () => {}, clearPanes: () => {}, toggleTrace: () => {},
    setPendingFollowups: () => {}, getPendingFollowups: () => [],
    render: () => {}, focusInput: () => {}, destroy: () => {},
    pickerOpen: () => false,
    showPicker: async () => null, showViewer: async () => {},
    showEditor: async () => {}, runDetached: () => {}, setTimeline: () => {},
  } as unknown as TuiSurface;
}

describe('TUI Controller live trace ticker', () => {
  test('trace pane renders during the turn, not only at finish', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const calls = { tracePanel: 0, rowMap: 0 };
      const renderer = createTuiRenderer(mockSurface(calls), 'test-session', 'test prompt');

      renderer.onEvent({ type: 'session_start', data: { agent: 'aither' } });
      renderer.onEvent({ type: 'llm_start', data: { model: 'test-model' } });
      assert.equal(calls.tracePanel, 0, 'no synchronous render on ingest (ticker-driven)');

      mock.timers.tick(150);
      assert.ok(calls.tracePanel >= 1, 'ticker rendered the trace pane during the turn');
      assert.ok(calls.rowMap >= 1, 'rowToNodeMap synced during the turn');

      renderer.onEvent({ type: 'tool_call', data: { tools: [{ name: 'web_search' }] } });
      mock.timers.tick(150);
      const midTurn = calls.tracePanel;
      assert.ok(midTurn >= 2, 'ticker keeps rendering as events arrive');

      renderer.finish();
      const atFinish = calls.tracePanel;
      assert.ok(atFinish >= midTurn + 1, 'finish() does a final render');

      mock.timers.tick(1000);
      assert.equal(calls.tracePanel, atFinish, 'no ticker writes after finish()');
    } finally {
      mock.timers.reset();
    }
  });

  test('eager preview is cleared when the grounded segment starts (no "LetLet" concat)', () => {
    // Buffer-tracking surface: model the OUTPUT pane so we can assert the live
    // (mid-stream) text, which is exactly where the concat bug showed.
    let buf = '';
    const surface = {
      screen: {}, input: {},
      appendOutput: (t: string) => { buf += t; },
      outputLine: (l: string) => { buf += (buf && !buf.endsWith('\n') ? '\n' : '') + l + '\n'; },
      markCheckpoint: () => buf.length,
      replaceOutputFrom: (off: number, t: string) => { buf = buf.slice(0, off) + t; },
      prependOutput: () => {},
      traceLine: () => {}, startTraceTurn: () => {}, finishTraceTurn: () => {},
      setStatus: () => {}, setTracePanel: () => {}, getTraceWidth: () => 80,
      setTraceRowToNodeMap: () => {}, setOutputLabel: () => {}, clearPanes: () => {},
      toggleTrace: () => {}, setPendingFollowups: () => {}, getPendingFollowups: () => [],
      render: () => {}, focusInput: () => {}, destroy: () => {}, pickerOpen: () => false,
      showPicker: async () => null, showViewer: async () => {}, showEditor: async () => {},
      runDetached: () => {}, setTimeline: () => {},
    } as unknown as TuiSurface;

    const renderer = createTuiRenderer(surface, 's', 'q');
    renderer.onEvent({ type: 'session_start', data: { agent: 'aither' } });
    // Segment 0: eager fast-pass preview (one token, the whole preview string).
    renderer.onEvent({ type: 'answer_segment', data: { segment_index: 0, kind: 'initial' } });
    renderer.onEvent({ type: 'token', data: { t: 'Let me check my memory…', segment_index: 0 } });
    renderer.onEvent({ type: 'segment_end', data: { segment_index: 0 } });
    // Segment 1: grounded answer — must SUPERSEDE the preview, not append to it.
    renderer.onEvent({ type: 'answer_segment', data: { segment_index: 1, kind: 'continuation' } });
    renderer.onEvent({ type: 'token', data: { t: 'The real answer.', segment_index: 1 } });

    // Mid-stream (before `complete`), the preview must be gone.
    assert.ok(!buf.includes('Let me check my memory'), `preview should be cleared, got: ${JSON.stringify(buf)}`);
    assert.ok(buf.includes('The real answer.'), 'grounded segment text is present');
    assert.ok(!buf.includes('Let meThe') && !buf.includes('…The real'), 'no concatenation of preview + answer');

    renderer.finish();  // stop the live ticker (setInterval) so the test process can exit
  });

  test('stream_interrupted stops the ticker after a last frame', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const calls = { tracePanel: 0, rowMap: 0 };
      const renderer = createTuiRenderer(mockSurface(calls), 'test-session', 'test prompt');

      renderer.onEvent({ type: 'session_start', data: { agent: 'aither' } });
      mock.timers.tick(150);
      const before = calls.tracePanel;

      renderer.onEvent({ type: 'stream_interrupted', data: { error: 'connection lost' } });
      const atError = calls.tracePanel;
      assert.ok(atError >= before + 1, 'error handler flushes a last live frame');

      mock.timers.tick(1000);
      assert.equal(calls.tracePanel, atError, 'no ticker writes after the stream dies');
    } finally {
      mock.timers.reset();
    }
  });
});
