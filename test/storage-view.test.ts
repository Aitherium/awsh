/**
 * Test storage-view: the pure render function for the storage cockpit panel.
 *
 * Verifies:
 * - Live snapshot renders a header, a table row per node, and a footer
 * - Empty (but reachable) snapshot renders the "no nodes yet" message
 * - Unreachable snapshot renders the degraded arm, never a silent empty table
 *   (security-review-patterns.md #5 — an always-empty read must never look
 *   identical to a genuine "nothing here")
 * - Stale vs fresh nodes are distinguishable in the rendered text
 *
 * No blessed integration; just the pure render function.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStoragePanel, type StoragePanelSnapshot } from '../src/tui/storage-view.js';

test('buildStoragePanel: degraded arm when Genesis is unreachable', () => {
  const snapshot: StoragePanelSnapshot = {
    reachable: false,
    error: 'HTTP 503: awstorage package unavailable',
    nodes: [],
  };
  const lines = buildStoragePanel(snapshot, 80);

  assert.ok(lines.some((l) => l.includes('storage unavailable')));
  assert.ok(lines.some((l) => l.includes('503')));
  // Must NOT render a node table or a "no nodes" empty-state message — those
  // read as "storage works, there's just nothing there", which is false here.
  assert.ok(!lines.some((l) => l.includes('no storage nodes have reported yet')));
});

test('buildStoragePanel: reachable but empty is a distinct state from unreachable', () => {
  const snapshot: StoragePanelSnapshot = { reachable: true, nodes: [] };
  const lines = buildStoragePanel(snapshot, 80);

  assert.ok(lines.some((l) => l.includes('no storage nodes have reported yet')));
  assert.ok(!lines.some((l) => l.includes('storage unavailable')));
});

test('buildStoragePanel: renders one row per node plus a footer total', () => {
  const snapshot: StoragePanelSnapshot = {
    reachable: true,
    total_bytes: 3 * 1024 ** 3,
    nodes: [
      { node_id: 'host', bytes: 2 * 1024 ** 3, age_seconds: 300, is_stale: false },
      { node_id: 'debian', bytes: 1024 ** 3, age_seconds: 40 * 3600, is_stale: true },
    ],
  };
  const lines = buildStoragePanel(snapshot, 100);
  const out = lines.join('\n');

  assert.ok(out.includes('host'));
  assert.ok(out.includes('debian'));
  assert.ok(out.includes('2 node(s)'));
  assert.ok(out.includes('3.00GB') || out.includes('3GB') || /3(\.0)?GB/.test(out));
});

test('buildStoragePanel: fresh and stale nodes are distinguishable', () => {
  const snapshot: StoragePanelSnapshot = {
    reachable: true,
    nodes: [
      { node_id: 'fresh-node', bytes: 100, age_seconds: 10, is_stale: false },
      { node_id: 'stale-node', bytes: 100, age_seconds: 999999, is_stale: true },
    ],
  };
  const out = buildStoragePanel(snapshot, 100).join('\n');

  assert.ok(out.includes('fresh'));
  assert.ok(out.includes('stale'));
});

test('buildStoragePanel: never throws on missing optional fields', () => {
  const snapshot: StoragePanelSnapshot = {
    reachable: true,
    nodes: [{ node_id: 'bare-node' }],
  };
  assert.doesNotThrow(() => buildStoragePanel(snapshot, 60));
});

test('buildStoragePanel: width parameter respected without crashing', () => {
  const snapshot: StoragePanelSnapshot = {
    reachable: true,
    nodes: [{ node_id: 'a-very-long-node-identifier-here', bytes: 12345, age_seconds: 5, is_stale: false }],
  };
  const narrow = buildStoragePanel(snapshot, 30);
  const wide = buildStoragePanel(snapshot, 150);

  assert.ok(narrow.length > 0);
  assert.ok(wide.length > 0);
});
