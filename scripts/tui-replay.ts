#!/usr/bin/env node
/**
 * Replay script: loads SSE events from a fixture and renders the timeline to stdout.
 * Usage: npm run tui:replay -- test/fixtures/sample-turn.json
 */
import { readFileSync } from 'fs';
import { createTimeline } from '../src/tui/timeline.js';
import type { SSEEvent } from '../src/client.js';

const fixtureArg = process.argv[2];
if (!fixtureArg) {
  console.error('Usage: tui-replay <fixture.json>');
  process.exit(1);
}

const events: SSEEvent[] = JSON.parse(readFileSync(fixtureArg, 'utf8'));
const timeline = createTimeline();

console.log(`\nReplaying ${events.length} events from ${fixtureArg}\n`);
console.log('='.repeat(80));

for (const event of events) {
  timeline.ingest(event);
}

// Render to 80-char width
const result = timeline.render(80);
for (const line of result.lines) {
  console.log(line);
}

console.log('='.repeat(80));
console.log(`\nRendered ${result.lines.length} lines, ${result.rowToNodeMap.size} clickable nodes\n`);
