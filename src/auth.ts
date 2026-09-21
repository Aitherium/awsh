/**
 * AitherShell CLI Authentication
 * ================================
 *
 * Manages ~/.aither/auth.json — shared with the Python CLI.
 * Multi-profile support (local, cloud, enterprise).
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Resolved per call, never at import: loadConfig() already resolves homedir()
// on every call, and a HOME override (tests, embedders) after import must not
// leave this module writing into the old home while saveAuth() mkdirs the new
// one — that split ENOENTs on any machine whose ~/.aither doesn't exist yet.
const authFile = () => join(homedir(), '.aither', 'auth.json');
const AUTH_VERSION = 1;

/* ── Types ───────────────────────────────────────────────────── */

export interface AuthUser {
  id: string;
  username: string;
  display_name: string;
  email: string;
  roles: string[];
  tenant_id: string;
  tenant_slug: string;
}

export interface AuthProfile {
  endpoint: string;
  genesis_url: string;
  token_type: string;
  access_token: string;
  expires_at: string;
  user: AuthUser;
}

export interface AuthStoreData {
  version: number;
  active_profile: string;
  profiles: Record<string, AuthProfile>;
}

/* ── Store operations ────────────────────────────────────────── */

export function loadAuth(): AuthStoreData | null {
  const file = authFile();
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    if (!data || data.version !== AUTH_VERSION) return null;
    return data as AuthStoreData;
  } catch {
    return null;
  }
}

export function saveAuth(store: AuthStoreData): void {
  const dir = join(homedir(), '.aither');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  store.version = AUTH_VERSION;
  const file = authFile();
  writeFileSync(file, JSON.stringify(store, null, 2), 'utf-8');
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
}

export function getActiveProfile(): AuthProfile | null {
  const store = loadAuth();
  if (!store) return null;
  const name = store.active_profile || 'local';
  return store.profiles?.[name] ?? null;
}

export function getActiveToken(): string | null {
  const profile = getActiveProfile();
  if (!profile?.access_token) return null;
  if (profile.expires_at) {
    try {
      const exp = new Date(profile.expires_at);
      if (exp < new Date()) return null;
    } catch { /* ignore parse errors */ }
  }
  return profile.access_token;
}

export function getActiveUser(): AuthUser | null {
  const profile = getActiveProfile();
  return profile?.user ?? null;
}

/* ── Who are we ACTUALLY acting as? ──────────────────────────────────────────
 *
 * 🚩 THIS CLI PRINTED ONE IDENTITY AND ACTED AS ANOTHER, IN ONE PROCESS.
 * `client.ts` sends ~/.aither/session-bearer; every display path read
 * ~/.aither/auth.json. Measured 2026-09-20 on the owner's box: auth.json held
 * profile "local" with user `root`, no email, no tenant and a 17-character
 * token, while session-bearer (86 chars) resolved to
 * david@aitherium.com / tenant platform. So `whoami` answered "root" for a
 * process authenticated as david -- and the owner's report was exactly that,
 * "identity doesnt feel connected".
 *
 * client.ts's own comment records the 2026-08-21 session where this same split
 * cost a debugging run ("the header still showed the cached user as signed
 * in"). Only the CALLING half was fixed then. This is the display half.
 *
 * The rule: never render a name that does not come from the credential we
 * send. When the bearer cannot be resolved we say SO -- an unresolved identity
 * is a different statement from "not logged in", and printing the stale cached
 * name instead is what made the bug invisible for a month.
 */

export interface ActingIdentity {
  user: AuthUser | null;
  /** Where the answer came from, so a caller can be honest about it. */
  source: 'session-bearer' | 'auth.json' | 'unresolved';
  /** True when a platform credential exists, whatever we could resolve from it. */
  hasCredential: boolean;
  detail?: string;
}

/** The platform session credential this machine actually sends. */
export function sessionBearerToken(): string | null {
  try {
    const value = readFileSync(join(homedir(), '.aither', 'session-bearer'), 'utf-8').trim();
    return value || null;
  } catch {
    return null;
  }
}

const IDENTITY_PATH = '/api/me/profile';

/** Candidate hosts that can resolve a bearer to a person, best first. */
function identityBases(): string[] {
  const out: string[] = [];
  const profile = getActiveProfile();
  // "local" is a sentinel, not a URL -- resolving it produces `local/api/...`,
  // which is the same class of bug as adk's handoff (awdk/adk/server.py:1150).
  const endpoint = (profile?.endpoint || '').trim();
  if (/^https?:\/\//i.test(endpoint)) out.push(endpoint.replace(/\/$/, ''));
  const env = (process.env.AITHER_PORTAL_URL || process.env.AITHER_ELYSIUM_URL || '').trim();
  if (env) out.push(env.replace(/\/$/, ''));
  out.push('http://127.0.0.1:3000');
  out.push('https://api.aitherium.com');
  return [...new Set(out)];
}

/**
 * Resolve the bearer to a person. Never throws; never falls back to a name that
 * came from a different credential without SAYING it did.
 */
export async function resolveActingIdentity(timeoutMs = 4000): Promise<ActingIdentity> {
  const token = sessionBearerToken();
  const cached = getActiveUser();

  if (!token) {
    return cached
      ? { user: cached, source: 'auth.json', hasCredential: !!getActiveToken() }
      : { user: null, source: 'unresolved', hasCredential: false };
  }

  for (const base of identityBases()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${IDENTITY_PATH}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const body = (await res.json()) as Partial<AuthUser>;
      if (!body || !body.username) continue;
      return {
        user: {
          id: body.id || body.username,
          username: body.username,
          display_name: body.display_name || body.username,
          email: body.email || '',
          roles: Array.isArray(body.roles) ? body.roles : [],
          tenant_id: body.tenant_id || '',
          tenant_slug: body.tenant_slug || '',
        },
        source: 'session-bearer',
        hasCredential: true,
      };
    } catch {
      // try the next base
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    user: null,
    source: 'unresolved',
    hasCredential: true,
    detail: 'a platform credential is present but no host could resolve it right now',
  };
}

export function setProfile(name: string, profile: AuthProfile): void {
  const store = loadAuth() ?? {
    version: AUTH_VERSION,
    active_profile: name,
    profiles: {},
  };
  store.profiles[name] = profile;
  store.active_profile = name;
  saveAuth(store);
}

export function clearProfile(name: string): void {
  const store = loadAuth();
  if (!store) return;
  delete store.profiles[name];
  if (store.active_profile === name) {
    const remaining = Object.keys(store.profiles);
    store.active_profile = remaining[0] ?? '';
  }
  saveAuth(store);
}

/* ── Built-in root account (like Linux UID 0) ────────────────── */

const ROOT_PROFILE: AuthProfile = {
  endpoint: 'local',
  genesis_url: 'https://localhost:8001',
  token_type: 'local',
  access_token: 'aither_root_local',
  expires_at: '',
  user: {
    id: 'root',
    username: 'root',
    display_name: 'root',
    email: '',
    roles: ['admin'],
    tenant_id: '',
    tenant_slug: '',
  },
};

/**
 * Local-root auto-provisioning is allowed UNLESS AITHER_REQUIRE_AUTH is set.
 * Parity with the Python ADK (awdk/adk/shell/auth.py:_is_root_provisioning_allowed).
 * Remote endpoints (e.g. the dev-workspace) set AITHER_REQUIRE_AUTH=1 to force a
 * real device-flow login as the user instead of silently becoming root.
 */
export function isRootProvisioningAllowed(): boolean {
  const v = (process.env.AITHER_REQUIRE_AUTH || '').toLowerCase();
  return !['1', 'true', 'yes', 'on'].includes(v);
}

/**
 * Ensure a profile exists for local sessions.
 * If a valid token already exists, return its profile.
 * Otherwise auto-provision the built-in root profile (like Linux console
 * auto-login) — UNLESS AITHER_REQUIRE_AUTH is set, in which case return null
 * so the caller forces device-flow login.
 */
export function ensureRootProfile(): AuthProfile | null {
  const token = getActiveToken();
  if (token) {
    return getActiveProfile()!;
  }
  if (!isRootProvisioningAllowed()) {
    return null; // require-auth — no silent root; caller triggers `aither login`
  }
  // No valid session — provision root
  setProfile('local', ROOT_PROFILE);
  return ROOT_PROFILE;
}

/* ── Auth API calls ──────────────────────────────────────────── */

export async function loginWithPassword(
  endpoint: string,
  username: string,
  password: string,
): Promise<any> {
  const resp = await fetch(`${endpoint}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 401) {
    const data = await resp.json().catch(() => ({}));
    if (data.requires_2fa) return { requires_2fa: true, temp_token: data.temp_token || '' };
    throw new Error('Invalid credentials');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Login failed: HTTP ${resp.status} ${text}`);
  }
  return resp.json();
}

export async function verify2FA(
  endpoint: string,
  tempToken: string,
  code: string,
): Promise<any> {
  const resp = await fetch(`${endpoint}/auth/2fa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ temp_token: tempToken, code }),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 401) throw new Error('Invalid 2FA code');
  if (!resp.ok) throw new Error(`2FA verification failed: HTTP ${resp.status}`);
  return resp.json();
}

export async function register(
  endpoint: string,
  username: string,
  password: string,
  email: string,
  inviteCode = '',
): Promise<any> {
  // Check capacity first
  try {
    const cap = await fetch(`${endpoint}/auth/alpha-capacity`, {
      signal: AbortSignal.timeout(5000),
    });
    if (cap.ok) {
      const data = await cap.json();
      if (!data.available) throw new Error('Registration is currently closed (alpha capacity reached)');
    }
  } catch (err: any) {
    if (err.message?.includes('closed')) throw err;
    // Endpoint may not exist; proceed
  }

  const body: Record<string, string> = { username, password, email };
  if (inviteCode) body.invite_code = inviteCode;

  const resp = await fetch(`${endpoint}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 409) throw new Error('Username or email already taken');
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Registration failed: HTTP ${resp.status} ${text}`);
  }
  return resp.json();
}

export async function validateToken(
  endpoint: string,
  token: string,
): Promise<any | null> {
  try {
    const resp = await fetch(`${endpoint}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) return resp.json();
    return null;
  } catch {
    return null;
  }
}

export async function logoutSession(
  endpoint: string,
  token: string,
): Promise<void> {
  try {
    await fetch(`${endpoint}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* best effort */ }
}

/* ── Email OTP ───────────────────────────────────────────────── */

export async function requestEmailOTP(
  endpoint: string,
  usernameOrEmail: string,
): Promise<{ otp_token: string; message: string }> {
  const body: Record<string, string> = {};
  if (usernameOrEmail.includes('@')) body.email = usernameOrEmail;
  else body.username = usernameOrEmail;

  const resp = await fetch(`${endpoint}/auth/email-otp/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`OTP request failed: HTTP ${resp.status}`);
  return resp.json();
}

export async function verifyEmailOTP(
  endpoint: string,
  otpToken: string,
  code: string,
): Promise<any> {
  const resp = await fetch(`${endpoint}/auth/email-otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otp_token: otpToken, code }),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 401) throw new Error('Invalid code');
  if (resp.status === 429) throw new Error('Too many attempts');
  if (!resp.ok) throw new Error(`OTP verify failed: HTTP ${resp.status}`);
  return resp.json();
}

/* ── Device Code Flow (browser-based SSO) ────────────────────── */

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function requestDeviceCode(
  endpoint: string,
  clientName = 'AitherShell',
): Promise<DeviceCodeResponse> {
  const resp = await fetch(`${endpoint}/auth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: clientName }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Device code request failed: HTTP ${resp.status}`);
  return resp.json();
}

export async function pollDeviceToken(
  endpoint: string,
  deviceCode: string,
): Promise<{ status: string; access_token?: string; user?: any; expires_at?: string }> {
  const resp = await fetch(`${endpoint}/auth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 400) {
    const data = await resp.json().catch(() => ({}));
    if (data.detail === 'expired_token') throw new Error('Device code expired');
    if (data.detail === 'invalid_device_code') throw new Error('Invalid device code');
    throw new Error(data.detail || 'Device code error');
  }
  if (!resp.ok) throw new Error(`Poll failed: HTTP ${resp.status}`);
  return resp.json();
}

/* ── Profile builder ─────────────────────────────────────────── */

export function buildProfile(
  endpoint: string,
  genesisUrl: string,
  data: any,
): AuthProfile {
  const token = data.access_token || data.token || '';
  const user = data.user || {};
  return {
    endpoint,
    genesis_url: genesisUrl,
    token_type: data.token_type || 'session',
    access_token: token,
    expires_at: data.expires_at || '',
    user: {
      id: user.id || '',
      username: user.username || '',
      display_name: user.display_name || user.username || '',
      email: user.email || '',
      roles: user.roles || [],
      tenant_id: user.tenant_id || '',
      tenant_slug: user.tenant_slug || '',
    },
  };
}
