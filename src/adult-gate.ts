/**
 * Adult-content gate for AitherShell.
 *
 * Every adult surface in the shell — gated safety tiers, NSFW model listings,
 * the lockbox hint — asks this before printing anything that names them.
 *
 * The gate has TWO halves on the platform (an explicit opt-in AND age
 * verification) and both live server-side; this module only reads the verdict.
 * It NEVER derives the verdict from `config.safetyLevel`: a session can be
 * running at `unrestricted` for reasons unrelated to disclosure, and that was
 * the check the shell used before — which is why `/imagine models` announced
 * "N NSFW model(s) hidden" to accounts that had never opted in.
 *
 * Order of resolution:
 *   1. Genesis `GET /safety/config/user/adult-content` (authoritative)
 *   2. `~/.aither/adult_content.json` mirror (offline / no backend)
 *   3. CLOSED
 *
 * Every failure path returns false. A gate that cannot be read is a gate that
 * stays shut.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MIRROR_PATH = join(homedir(), '.aither', 'adult_content.json');

/** Tiers that only exist once the gate is open. */
export const ADULT_TIERS = ['unrestricted', 'explicit'];

let cached: { value: boolean; at: number } | null = null;
const CACHE_MS = 30_000;

/** Read the on-disk mirror written by the platform when the toggle changes. */
export function readAdultGateMirror(): boolean {
  try {
    const raw = readFileSync(MIRROR_PATH, 'utf8');
    return JSON.parse(raw)?.visible === true;
  } catch {
    // Missing, unreadable or malformed — locked. Not an error worth surfacing:
    // the file simply does not exist until the user first toggles the setting.
    return false;
  }
}

/**
 * Whether adult surfaces may be shown in this session.
 *
 * `client` is the GenesisClient; typed loosely so this module stays importable
 * from commands.ts without a cycle.
 */
export async function isAdultContentVisible(client?: {
  get: (path: string) => Promise<unknown>;
}): Promise<boolean> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;

  let visible = false;
  if (client) {
    try {
      const result = (await client.get('/safety/config/user/adult-content')) as
        | { adult_content_visible?: boolean }
        | undefined;
      visible = result?.adult_content_visible === true;
    } catch {
      // Backend unreachable — fall through to the mirror rather than guessing.
      visible = readAdultGateMirror();
    }
  } else {
    visible = readAdultGateMirror();
  }

  cached = { value: visible, at: now };
  return visible;
}

/** Drop the cache — call after any command that changes the gate. */
export function invalidateAdultGate(): void {
  cached = null;
}

/** Strip age-gated tiers from a list unless the gate is open. */
export function filterAdultTiers<T>(
  tiers: T[],
  idOf: (tier: T) => string,
  visible: boolean,
): T[] {
  if (visible) return tiers;
  return tiers.filter((tier) => !ADULT_TIERS.includes(idOf(tier).toLowerCase()));
}
