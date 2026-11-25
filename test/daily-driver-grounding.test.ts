/**
 * The owner's 2026-11-16 screenshots (20:41-21:07), as regressions. awsh v1.20.2 said
 * "1 down - run /doctor: MCP", then answered like a toolless chatbot: "run docker ps"
 * for DarkMatter, "maybe Dark Souls", "no email tool is connected", "No" to Discord, and
 * a generic list for "what can you do?". Causes pinned here:
 *   1. a User-scope AITHER_API_URL pinned the bare edge gateway (no tools) over a
 *      healthy local agent daemon -> isBareGatewayHealth / shouldPreferLocalAgent;
 *   2. the MCP probe hit /mcp/health (401) instead of /health -> mcpHealthUrl;
 *   3. no platform context reached the model -> routeHint / buildGrounding;
 *   4. the portrait pane never docked by default -> shouldAutoDock / castPersonaAvatar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  routeHint, buildGrounding, PLATFORM_CONTEXT, awmScope, parseRecall, formatSnapshot, groundingEnabled,
} from '../src/grounding.js';
import { isBareGatewayHealth, shouldPreferLocalAgent, pickDaemon } from '../src/backend-resolver.js';
import { mcpHealthUrl } from '../src/status-banner.js';
import { castPersonaAvatar, shouldAutoDock, phaseEmotion } from '../src/tui/avatar-autodock.js';
import { activeWorkspaceLabel, normalizeWorkspaceLabel, setActiveWorkspace } from '../src/workspace-context.js';

// ── the four screenshot prompts route to a tool ─────────────────────────

test('"status of darkmatter demo?" routes to a DarkMatter check, never docker', () => {
  const h = routeHint('status of darkmatter demo?');
  assert.equal(h?.topic, 'darkmatter');
  assert.ok(h!.tools.includes('http_get') || h!.tools.includes('fleet_status'));
  assert.match(h!.line, /dark-matters/);
  assert.match(h!.line, /8799/);
});

test('"the darkmatter game engine" is grounded as HIS engine, not Dark Souls', () => {
  assert.equal(routeHint('the darkmatter game engine')?.topic, 'darkmatter');
  assert.match(PLATFORM_CONTEXT, /DarkMatter[^\n]*his own 3D game engine/);
  assert.match(PLATFORM_CONTEXT, /NOT Dark Souls/);
});

test('"triage my email" routes to mail_triage and forbids "no email tool"', () => {
  const h = routeHint('triage my email');
  assert.equal(h?.topic, 'mail');
  assert.equal(h!.tools[0], 'mail_triage');
  assert.match(h!.line, /never say "no email tool"/);
});

test('"are you connected to discord?" routes to presence + relay history', () => {
  const h = routeHint('are you connected to discord?');
  assert.equal(h?.topic, 'discord');
  assert.deepEqual(h!.tools.slice(0, 2), ['atlas_presence', 'relay_history']);
  assert.match(h!.line, /explicit yes/, 'posting as Aither keeps a confirm gate');
});

test('"what can you do?" gets a platform-grounded capability answer, not a generic list', () => {
  const h = routeHint('what can you do?');
  assert.equal(h?.topic, 'capabilities');
  for (const t of ['fleet_status', 'mail_triage', 'atlas_presence', 'awsh_spawn']) assert.match(h!.line, new RegExp(t));
});

test('chit-chat gets no forced tool', () => {
  assert.equal(routeHint('thanks!'), null);
});

// ── the grounding block ─────────────────────────────────────────────────

test('buildGrounding: platform context first, then who/workspace, hint, snapshot, recall', () => {
  const out = buildGrounding({
    message: 'status of darkmatter demo?', user: 'David', workspace: 'aitherium',
    snapshot: formatSnapshot([{ name: 'DarkMatter game (:8799)', up: true }], new Date(0)),
    recall: ['[1.00] owner-embodied-agents-in-darkmatter "DarkMatter is the world agents spawn into"'],
  });
  assert.equal(out[0], PLATFORM_CONTEXT);
  assert.match(out[1], /Signed in as: David\. Active workspace: aitherium/);
  assert.match(out[2], /^## For this message/);
  assert.match(out[3], /DarkMatter game \(:8799\): UP/);
  assert.match(out[4], /Recalled from David's memory/);
  for (const p of ['DarkMatter', 'openAW', 'Wesyn', 'Aionyn', 'Eusyra']) assert.match(PLATFORM_CONTEXT, new RegExp(p));
  assert.match(PLATFORM_CONTEXT, /Never tell David to run docker, podman, kubectl/);
  assert.match(PLATFORM_CONTEXT, /"I do not know yet" plus a tool call beats a guess/);
});

test('awmScope: AWM_USER, else the signed-in first name; junk is refused', () => {
  assert.equal(awmScope({ AWM_USER: 'david' }), 'aitherium:david:AitherOS-Fresh');
  assert.equal(awmScope({}, 'David Parkhurst'), 'aitherium:david:AitherOS-Fresh');
  assert.equal(awmScope({ AWSH_AWM_SCOPE: 'aitherium:x:y' }), 'aitherium:x:y');
  assert.equal(awmScope({}, ''), null);
});

test('parseRecall keeps only the scored fact lines', () => {
  const raw = 'fleet publish table unreadable (...)\n[1.00] scope key "fact one"\n[0.42] scope k2 "two"\n';
  assert.deepEqual(parseRecall(raw), ['[1.00] scope key "fact one"', '[0.42] scope k2 "two"']);
});

test('groundingEnabled: off under node --test unless forced, AWSH_GROUNDING=0 always off', () => {
  assert.equal(groundingEnabled({ NODE_TEST_CONTEXT: 'child' }), false);
  assert.equal(groundingEnabled({ NODE_TEST_CONTEXT: 'child', AWSH_GROUNDING: '1' }), true);
  assert.equal(groundingEnabled({ AWSH_GROUNDING: '0' }), false);
  assert.equal(groundingEnabled({}), true);
});

// ── backend: a pinned bare gateway loses to the local agent daemon ──────

test('isBareGatewayHealth: the edge gateway yes; daemon and Genesis no', () => {
  assert.equal(isBareGatewayHealth({ status: 'healthy', service: 'AitherMCPGateway' }), true);
  assert.equal(isBareGatewayHealth({ status: 'healthy', agent: 'adk-daemon', llm_backend: 'desktop' }), false);
  assert.equal(isBareGatewayHealth({ service: 'AitherGenesis' }), false);
  assert.equal(isBareGatewayHealth(null), false);
});

test('shouldPreferLocalAgent: honours the thin-client opt-outs', () => {
  assert.equal(shouldPreferLocalAgent({ inferenceMode: 'auto', offline: false }, {}), true);
  assert.equal(shouldPreferLocalAgent({ inferenceMode: 'raw', offline: false }, {}), false);
  assert.equal(shouldPreferLocalAgent({ inferenceMode: 'auto', offline: false }, { AWSH_HONOR_REMOTE_PIN: '1' }), false);
  assert.equal(shouldPreferLocalAgent({ inferenceMode: 'auto', offline: false }, { AITHERSHELL_USE_ADK: '0' }), false);
});

test('mcpHealthUrl: health lives at the gateway root, not under /mcp (was a 401 = "1 down: MCP")', () => {
  assert.equal(mcpHealthUrl('https://mcp.aitherium.com/mcp'), 'https://mcp.aitherium.com/health');
  assert.equal(mcpHealthUrl('https://mcp.aitherium.com/mcp/'), 'https://mcp.aitherium.com/health');
  assert.equal(mcpHealthUrl('http://127.0.0.1:8182'), 'http://127.0.0.1:8182/health');
});

// ── avatar ──────────────────────────────────────────────────────────────

test('castPersonaAvatar: the desk persona id maps onto its portrait set', () => {
  const cast = { authors: { aither: { character: 'aither-90044575' }, awdesk: { character: 'aither-v2' } } };
  assert.equal(castPersonaAvatar(cast, 'aither', ['aither', 'blob', 'bun', 'bunny', 'pip']), 'aither');
  assert.equal(castPersonaAvatar({ authors: {} }, 'pip', ['aither', 'pip']), 'pip');
  assert.equal(castPersonaAvatar(null, 'aither', ['aither']), null);
});

test('shouldAutoDock: Windows Terminal at 120 cols docks; narrow or opted-out does not', () => {
  assert.equal(shouldAutoDock({ WT_SESSION: 'x' }, 120), true);
  assert.equal(shouldAutoDock({ COLORTERM: 'truecolor' }, 140), true);
  assert.equal(shouldAutoDock({ WT_SESSION: 'x' }, 80), false);
  assert.equal(shouldAutoDock({ WT_SESSION: 'x', AWSH_AVATAR: '0' }, 200), false);
  assert.equal(shouldAutoDock({}, 200), false);
  assert.equal(shouldAutoDock({ AWSH_AVATAR: '1' }, 60), true);
});

test('phaseEmotion: thinking plays the curious clip, then the affect returns', () => {
  assert.equal(phaseEmotion('thinking', 'happy'), 'curious');
  assert.equal(phaseEmotion('talking', 'happy'), 'happy');
  assert.equal(phaseEmotion('idle', ''), 'neutral');
});

// ── workspace scope ─────────────────────────────────────────────────────

test('workspace: env beats the saved choice; labels are normalised', () => {
  const home = mkdtempSync(join(tmpdir(), 'awsh-ws-'));
  mkdirSync(join(home, '.aither'), { recursive: true });
  writeFileSync(join(home, '.aither', 'desk-tenant.json'), JSON.stringify({ host: 'hearth.aitherium.com' }));
  assert.equal(activeWorkspaceLabel({}, home), 'hearth');
  assert.equal(setActiveWorkspace('Family Hearth', home), 'family-hearth');
  assert.equal(activeWorkspaceLabel({}, home), 'family-hearth');
  assert.equal(activeWorkspaceLabel({ AWSH_WORKSPACE: 'aitherium' }, home), 'aitherium');
  assert.equal(normalizeWorkspaceLabel('!!'), null);
});

test('pickDaemon: a healthy daemon WITH the tool lane beats the published one without it', () => {
  assert.equal(pickDaemon([
    { url: 'http://127.0.0.1:9177', up: true, tools: false },
    { url: 'http://127.0.0.1:9001', up: true, tools: true },
  ]), 'http://127.0.0.1:9001');
  assert.equal(pickDaemon([
    { url: 'http://127.0.0.1:9177', up: true, tools: false },
    { url: 'http://127.0.0.1:9001', up: false, tools: false },
  ]), 'http://127.0.0.1:9177');
  assert.equal(pickDaemon([{ url: 'x', up: false, tools: false }]), null);
});
