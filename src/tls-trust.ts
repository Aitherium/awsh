/**
 * Process-wide TLS trust decision for the shell.
 *
 * main.ts relaxes certificate verification (NODE_TLS_REJECT_UNAUTHORIZED=0) at
 * import time when EVERY configured endpoint is the private self-signed fleet.
 * But the endpoint is not final at import: when local Genesis is unreachable,
 * applyCloudFallback() repoints the shell at a PUBLIC CA-issued edge and the
 * user's bearer/PAT is then sent there. With the flag still set, that request is
 * MITM-exposed -- the exact hole the import-time gate was written to close.
 *
 * So the relaxation is tracked, and every endpoint change is reconciled: moving
 * to a public host restores strict verification. Node reads the env var on
 * every tls.connect (undici's fetch included), so deleting it takes effect for
 * the next connection -- and no connection to the public edge exists before the
 * failover. The relaxation is one-way: once strict, it never relaxes again in
 * this process. An operator's own NODE_TLS_REJECT_UNAUTHORIZED is never touched.
 */

/** True for loopback / RFC1918 / .local / .internal hosts. */
export function isPrivateHost(url: string, unparseableIsPrivate = false): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' ||
      /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h.endsWith('.local') || h.endsWith('.internal');
  } catch { return unparseableIsPrivate; }
}

type Env = Record<string, string | undefined>;

let relaxedByShell = false;

/** Relax verification for the private trust domain -- only if nobody set the flag. */
export function relaxTlsForPrivateTrustDomain(env: Env = process.env): boolean {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED != null) return false;
  env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  relaxedByShell = true;
  return true;
}

/** Call on EVERY endpoint change. Restores strict TLS when the new endpoint is public. */
export function reconcileTlsForEndpoint(url: string, env: Env = process.env): 'strict-restored' | 'unchanged' {
  if (!relaxedByShell) return 'unchanged';
  if (isPrivateHost(url)) return 'unchanged';
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  relaxedByShell = false;
  return 'strict-restored';
}

export function tlsRelaxedByShell(): boolean {
  return relaxedByShell;
}

/** Test seam only. */
export function _resetTlsTrustForTests(): void {
  relaxedByShell = false;
}
