/**
 * Test suite for the AitherAeon room view: pure render + bucketing.
 *
 * The room is the surface where the six pillars become visible, so the properties
 * worth guarding are the ones whose failure looks like "nothing is happening":
 * an event silently missing from its lane, an unreachable daemon rendering as a
 * quiet room, or one multi-line payload corrupting every row beneath it.
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'assert';

import { buildRoomPanel } from '../src/tui/room-view.js';
import { bucketByPillar, eventDetail } from '../src/room-client.js';
import { PILLARS, type AitherEvent } from '../src/aither-events.generated.js';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function ev(over: Partial<AitherEvent> = {}): AitherEvent {
  return {
    v: 1,
    id: 'x',
    seq: 1,
    ts: 0,
    room: 'main',
    session: '',
    actor: { kind: 'claude_code', id: 'sess', name: 'sess' },
    pillar: 'orchestration',
    tier: 'host',
    type: 'tool_call',
    stage: '',
    payload: {},
    correlation_id: '',
    causation_id: '',
    ...over,
  } as AitherEvent;
}

function snapshot(events: AitherEvent[], ok = true, reason = '') {
  return {
    ok,
    reason,
    info: ok
      ? {
          id: 'main',
          title: 'main',
          last_seq: events.length,
          participants: [],
          pillars: {} as Record<string, number>,
          transcript: '',
        }
      : null,
    events,
    lastSeq: events.length,
  };
}

describe('bucketByPillar', () => {
  test('files each event under its own pillar', () => {
    const { lanes } = bucketByPillar([
      ev({ pillar: 'intent', type: 'classify' }),
      ev({ pillar: 'reasoning', type: 'reasoning_step' }),
      ev({ pillar: 'learning', type: 'mem.s' }),
    ]);
    assert.equal(lanes.intent.length, 1);
    assert.equal(lanes.reasoning.length, 1);
    assert.equal(lanes.learning.length, 1);
    assert.equal(lanes.context.length, 0);
  });

  test('pillar-less events go to surface, never into a default lane', () => {
    // Forcing an unknown event into a lane is how a lane stops meaning anything.
    const { lanes, surface } = bucketByPillar([
      ev({ pillar: null, type: 'token' }),
      ev({ pillar: null, type: 'heartbeat' }),
    ]);
    assert.equal(surface.length, 2);
    for (const p of PILLARS) assert.equal(lanes[p].length, 0);
  });

  test('every pillar has a lane even with no events', () => {
    const { lanes } = bucketByPillar([]);
    for (const p of PILLARS) assert.ok(Array.isArray(lanes[p]), `no lane for ${p}`);
  });
});

describe('eventDetail', () => {
  test('collapses newlines so one payload cannot corrupt the layout', () => {
    // Measured against live Claude Code traffic: a two-line prompt split its lane
    // into two mis-indented rows and pushed everything below it out of alignment.
    const detail = eventDetail(ev({ payload: { prompt: 'line one\nline two\n\tline three' } }));
    assert.ok(!detail.includes('\n'), `detail still contains a newline: ${detail}`);
    assert.equal(detail, 'line one line two line three');
  });

  test('prefers the most identifying field and returns empty when there is none', () => {
    assert.equal(eventDetail(ev({ payload: { tool: 'Edit', file_path: 'a.ts' } })), 'Edit');
    assert.equal(eventDetail(ev({ payload: {} })), '');
  });
});

describe('buildRoomPanel', () => {
  test('renders all six lanes, labelled, in protocol order', () => {
    const lines = buildRoomPanel(snapshot([ev({ pillar: 'intent', type: 'classify' })]), 96)
      .map(stripAnsi);
    const positions = PILLARS.map((p) =>
      lines.findIndex((l) => l.trim().startsWith(p)),
    );
    for (let i = 0; i < PILLARS.length; i++) {
      assert.ok(positions[i] >= 0, `lane ${PILLARS[i]} not rendered`);
    }
    const ordered = [...positions].sort((a, b) => a - b);
    assert.deepEqual(positions, ordered, 'lanes are not in protocol order');
  });

  test('an empty lane says (quiet) rather than rendering blank', () => {
    // The learning lane has no shell-side producer at all — it fills from Flux and
    // the kernel — so a blank line would read as a broken renderer.
    const lines = buildRoomPanel(snapshot([]), 96).map(stripAnsi);
    assert.ok(lines.some((l) => l.includes('(quiet)')));
  });

  test('an unreachable daemon renders a visible reason, never a quiet room', () => {
    const lines = buildRoomPanel(
      snapshot([], false, 'harness daemon unreachable at http://127.0.0.1:8362'),
      96,
    ).map(stripAnsi);
    const text = lines.join('\n');
    assert.ok(text.includes('room unavailable'), 'no degraded banner');
    assert.ok(text.includes('127.0.0.1:8362'), 'reason not shown to the operator');
    assert.ok(!text.includes('(quiet)'), 'a dead daemon must not look like a quiet room');
  });

  test('no rendered line exceeds the pane width', () => {
    const long = 'x'.repeat(400);
    const lines = buildRoomPanel(
      snapshot([ev({ pillar: 'context', payload: { text: long } })]),
      80,
    ).map(stripAnsi);
    for (const line of lines) {
      assert.ok(line.length <= 80, `line overflows pane: ${line.length} > 80`);
    }
  });
});
