/**
 * Session knowledge graph (Ctrl+K): a box-drawing view of what the turn touched —
 * tools called, memories recalled, sources/entities, agents involved.
 *
 * Two data sources, merged:
 *  - CLIENT-SIDE accumulation from the events the TUI already sees (works today,
 *    no backend change): tool_call/tool_result, memory_recall, source, agent_message.
 *  - the backend 'knowledge_graph' SSE event { nodes:[{id,type,label,weight}],
 *    edges:[{from,to,rel,weight}] } (real AitherKnowledgeGraph traversal) when present.
 *
 * The renderer is a PURE (graph, width) => string[]. Single-cell glyphs only.
 */
import { COLORS } from './theme.js';
import { heat } from './sparkline.js';

export type KGType = 'user' | 'tool' | 'memory' | 'agent' | 'entity' | 'source';

export interface KGNode { id: string; type: KGType; label: string; weight: number }
export interface KGEdge { from: string; to: string; rel?: string; weight?: number }
export interface KnowledgeGraph { nodes: Map<string, KGNode>; edges: KGEdge[] }

const ROOT = '__turn__';

export function emptyGraph(): KnowledgeGraph {
  const nodes = new Map<string, KGNode>();
  nodes.set(ROOT, { id: ROOT, type: 'entity', label: 'this turn', weight: 1 });
  return { nodes, edges: [] };
}

function bump(g: KnowledgeGraph, id: string, type: KGType, label: string): void {
  const n = g.nodes.get(id);
  if (n) { n.weight += 1; return; }
  g.nodes.set(id, { id, type, label, weight: 1 });
}

function link(g: KnowledgeGraph, from: string, to: string, rel = ''): void {
  const e = g.edges.find(x => x.from === from && x.to === to);
  if (e) { e.weight = (e.weight ?? 1) + 1; return; }
  g.edges.push({ from, to, rel, weight: 1 });
}

/** Accumulate graph structure from a single SSE event (client-side, no backend). */
export function accumulateGraph(g: KnowledgeGraph, eventType: string, data: any): void {
  const d = data || {};
  switch (eventType) {
    case 'session_start':
    case 'agent_message': {
      const agent = d.agent || d.name;
      if (agent) { bump(g, `agent:${agent}`, 'agent', String(agent)); link(g, ROOT, `agent:${agent}`, 'by'); }
      break;
    }
    case 'tool_call':
    case 'tool_result': {
      const name = d.name || d.tool || (Array.isArray(d.tools) && d.tools[0]?.name);
      if (name) { bump(g, `tool:${name}`, 'tool', String(name)); link(g, ROOT, `tool:${name}`, 'used'); }
      break;
    }
    case 'memory_recall': {
      const n = Number(d.memories ?? d.count ?? 1) || 1;
      const node = g.nodes.get('mem:recall');
      if (node) node.weight = Math.max(node.weight, n);
      else g.nodes.set('mem:recall', { id: 'mem:recall', type: 'memory', label: `${n} recalled`, weight: n });
      link(g, ROOT, 'mem:recall', 'recalled');
      break;
    }
    case 'source': {
      const srcs = Array.isArray(d.sources) ? d.sources : [];
      if (srcs.length) {
        for (const s of srcs.slice(0, 8)) { const id = `src:${s}`; bump(g, id, 'source', String(s).slice(0, 28)); link(g, ROOT, id, 'cited'); }
      } else if (d.chunks) {
        bump(g, 'src:chunks', 'source', `${d.chunks} chunks`); link(g, ROOT, 'src:chunks', 'cited');
      }
      break;
    }
  }
}

/** Merge a backend 'knowledge_graph' event ({nodes,edges}) into the graph. */
export function mergeGraphEvent(g: KnowledgeGraph, data: any): void {
  if (!data) return;
  for (const n of (Array.isArray(data.nodes) ? data.nodes : [])) {
    if (!n?.id) continue;
    g.nodes.set(String(n.id), {
      id: String(n.id), type: (n.type || 'entity') as KGType,
      label: String(n.label ?? n.id).slice(0, 40), weight: Number(n.weight) || 1,
    });
  }
  for (const e of (Array.isArray(data.edges) ? data.edges : [])) {
    if (!e?.from || !e?.to) continue;
    g.edges.push({ from: String(e.from), to: String(e.to), rel: e.rel || '', weight: Number(e.weight) || 1 });
  }
}

const TYPE_ORDER: KGType[] = ['user', 'agent', 'tool', 'memory', 'source', 'entity'];
const TYPE_LABEL: Record<KGType, string> = {
  user: 'you', agent: 'agents', tool: 'tools', memory: 'memory', source: 'sources', entity: 'entities',
};

/**
 * Render the graph as a clustered box-drawing tree rooted at the turn: the root,
 * then each node type as a branch with its nodes (heat-coloured by weight). A
 * true force-directed layout isn't legible in a terminal; this clustered tree is.
 */
export function buildKnowledgeGraph(g: KnowledgeGraph | null, width: number): string[] {
  if (!g || g.nodes.size <= 1) {
    return [COLORS.muted('no session graph yet — run a turn that uses tools, memory, or sources')];
  }
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const byType = new Map<KGType, KGNode[]>();
  let maxW = 1;
  for (const n of g.nodes.values()) {
    if (n.id === ROOT) continue;
    (byType.get(n.type) ?? byType.set(n.type, []).get(n.type)!).push(n);
    if (n.weight > maxW) maxW = n.weight;
  }
  const lines: string[] = [];
  const total = g.nodes.size - 1;
  lines.push(COLORS.accent('◉ this turn') + COLORS.muted(`  ·  ${total} nodes · ${g.edges.length} edges`));

  const groups = TYPE_ORDER.filter(t => (byType.get(t)?.length ?? 0) > 0);
  groups.forEach((type, gi) => {
    const nodes = byType.get(type)!.sort((a, b) => b.weight - a.weight);
    const lastGroup = gi === groups.length - 1;
    const gBranch = lastGroup ? '╰─' : '├─';
    lines.push(COLORS.muted(` ${gBranch}┬ `) + COLORS.text(`${TYPE_LABEL[type]} (${nodes.length})`));
    const spine = lastGroup ? '   ' : ' │ ';
    nodes.slice(0, 12).forEach((n, i) => {
      const last = i === Math.min(nodes.length, 12) - 1;
      const nb = last ? '╰─' : '├─';
      const wtag = n.weight > 1 ? COLORS.muted(` ×${n.weight}`) : '';
      const label = heat(n.weight / maxW, clip(n.label, Math.max(8, width - 12)));
      lines.push(COLORS.muted(`${spine}${nb} `) + label + wtag);
    });
    if (nodes.length > 12) lines.push(COLORS.muted(`${spine}   … +${nodes.length - 12} more`));
  });
  return lines;
}
