/**
 * Session knowledge graph: client-side accumulation from events, merge of the
 * backend 'knowledge_graph' event, and the box-drawing renderer (single-cell,
 * width-bounded, graceful when empty).
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import {
  emptyGraph, accumulateGraph, mergeGraphEvent, buildKnowledgeGraph,
} from '../src/tui/knowledge-graph-overlay.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
function assertSingleWidth(lines: string[], width: number): void {
  for (const l of lines) {
    const p = strip(l);
    assert.ok(p.length <= width, `line over width ${width}: "${p}" (${p.length})`);
    for (const ch of p) {
      const cp = ch.codePointAt(0)!;
      const wide = (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3);
      assert.ok(!wide, `wide glyph U+${cp.toString(16)} in "${p}"`);
    }
  }
}

describe('knowledge graph overlay', () => {
  test('empty graph → graceful line', () => {
    const lines = buildKnowledgeGraph(emptyGraph(), 60);
    assert.equal(lines.length, 1);
    assert.match(strip(lines[0]), /no session graph yet/);
  });

  test('accumulates tools/memory/sources from events + renders clustered tree', () => {
    const g = emptyGraph();
    accumulateGraph(g, 'session_start', { agent: 'aither' });
    accumulateGraph(g, 'tool_call', { name: 'web_search', tool: 'web_search' });
    accumulateGraph(g, 'tool_result', { name: 'web_search', tool: 'web_search' });   // → weight 2
    accumulateGraph(g, 'tool_call', { name: 'knowledge_search' });
    accumulateGraph(g, 'memory_recall', { memories: 3 });
    accumulateGraph(g, 'source', { chunks: 5 });

    const lines = buildKnowledgeGraph(g, 60);
    const joined = lines.map(strip).join('\n');
    assert.match(joined, /this turn/);
    assert.match(joined, /tools \(2\)/);           // web_search + knowledge_search
    assert.match(joined, /web_search/);
    assert.match(joined, /×2/);                    // web_search fired twice (call+result)
    assert.match(joined, /agents \(1\)/);
    assert.match(joined, /memory/);
    assert.match(joined, /sources/);
    assertSingleWidth(lines, 60);
  });

  test('merges the backend knowledge_graph event ({nodes,edges})', () => {
    const g = emptyGraph();
    mergeGraphEvent(g, {
      nodes: [
        { id: 'user_x', type: 'user', label: 'User', weight: 1 },
        { id: 'agent_aither', type: 'agent', label: 'Aither', weight: 1 },
        { id: 'tool_ks', type: 'tool', label: 'Knowledge Search', weight: 0.8 },
      ],
      edges: [{ from: 'user_x', to: 'agent_aither', rel: 'asks', weight: 1 }],
    });
    const joined = buildKnowledgeGraph(g, 70).map(strip).join('\n');
    assert.match(joined, /you \(1\)/);              // 'user' type → "you" group
    assert.match(joined, /Aither/);
    assert.match(joined, /Knowledge Search/);
    assert.equal(g.edges.length, 1);
  });
});
