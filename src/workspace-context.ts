/**
 * workspace-context.ts — which Aitherium workspace (Aitherium, Family/Hearth, a partner
 * world…) this shell's turns are scoped to.
 *
 * Not the same thing as `/workspace switch` (a PROJECT directory, workspace.ts). This is
 * the tenant workspace every workspace_* tool, mail, tasks, secrets and memory call is
 * scoped to. Resolution, first hit wins:
 *   1. AWSH_WORKSPACE (this process only)
 *   2. ~/.aither/awsh-workspace.json  {"label": "..."}   — written by `/workspace use`
 *   3. Desk's tenant / the signed-in account's tenant (awdesk-bridge knownTenantLabel)
 * The label rides every turn as a system addition (grounding.ts) so the agent scopes
 * its tool calls to it; the server still derives scope from the authenticated caller.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { knownTenantLabel } from './awdesk-bridge.js';

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function workspaceFile(home: string = homedir()): string {
  return join(home, '.aither', 'awsh-workspace.json');
}

/** Normalise a typed label ("Family Hearth" -> "family-hearth"); null when unusable. Pure. */
export function normalizeWorkspaceLabel(raw: string): string | null {
  const s = String(raw || '').trim().toLowerCase().replace(/\.aitherium\.com$/, '')
    .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
  return LABEL_RE.test(s) ? s : null;
}

export function activeWorkspaceLabel(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const fromEnv = normalizeWorkspaceLabel(env.AWSH_WORKSPACE || '');
  if (fromEnv) return fromEnv;
  try {
    const f = workspaceFile(home);
    if (existsSync(f)) {
      const label = normalizeWorkspaceLabel(JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')).label || '');
      if (label) return label;
    }
  } catch { /* fall through */ }
  try { return knownTenantLabel(home); } catch { return null; }
}

/** Persist the workspace for later shells. Returns the stored label or null when invalid. */
export function setActiveWorkspace(raw: string, home: string = homedir()): string | null {
  const label = normalizeWorkspaceLabel(raw);
  if (!label) return null;
  const f = workspaceFile(home);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ label, set_at: new Date().toISOString() }, null, 2), 'utf8');
  return label;
}
