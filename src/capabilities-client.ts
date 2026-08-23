/**
 * `aither caps …` — what an agent may do ON YOUR BEHALF.
 *
 * A THIN client of the platform's effective-capability resolver. The answer is
 * computed once, on the platform, by joining the per-agent capability tokens
 * with the authenticated caller's RBAC role. adk, awnode and this shell all
 * read that one answer instead of each deriving their own.
 *
 * Two hand-maintained answers to "what may this agent do" drift, and the failure
 * is asymmetric: a surface that OVER-states reach invites you to authorise
 * something the fleet then refuses, while one that under-states it looks like a
 * broken feature. Neither is visible from the surface itself.
 *
 * UNLIKE `decisions`, THIS DOES NEED THE BACKEND. The decision store is a host
 * process that survives when Genesis does not; the capability resolver is not —
 * it needs the CapabilityEngine and the RBAC store, which live in the fleet. So
 * this reports "backend unreachable" rather than pretending to a local answer.
 *
 * THERE IS NO --principal FLAG, DELIBERATELY. The platform takes the principal
 * from the verified session behind the request. A flag would key an authz view
 * on caller-supplied input, which is how a second ceiling becomes a way to claim
 * someone else's.
 */

import * as theme from './theme.js';

interface EffectiveView {
  available?: boolean;
  agent_id?: string;
  principal?: string | null;
  capabilities?: string[];
  bounded_by_principal?: boolean;
  resolved?: boolean;
  error?: string;
}

function usage(): number {
  console.log(`
${theme.accent('aither caps')} — what an agent may do on your behalf

  ${theme.dim('aither caps <agent>')}            effective capabilities for <agent>
  ${theme.dim('aither caps <agent> <resource>')} may <agent> use <resource>?

Examples:
  aither caps aither
  aither caps aither service.InnerLife
`);
  return 0;
}

/** A broader granted verb satisfies a narrower request; read never implies execute. */
function grantSatisfies(granted: string, requested: string): boolean {
  if (granted === '*') return true;
  if (granted === requested) return true;
  return requested === 'read' && (granted === 'write' || granted === 'execute');
}

export async function runCapsCommand(args: string[], baseUrl: string,
                                     headers: Record<string, string> = {}): Promise<number> {
  const agent = (args[0] || '').trim();
  if (!agent || agent === '--help' || agent === '-h') return usage();

  const url = `${baseUrl.replace(/\/+$/, '')}/internals/capabilities/effective/${encodeURIComponent(agent)}`;

  let view: EffectiveView;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      // A non-200 is reported as itself. Collapsing it into "no capabilities"
      // would render an auth failure as an empty permission set — the reader
      // would conclude the agent may do nothing, which is a different and more
      // alarming claim than "we could not ask".
      console.error(theme.bad(`could not reach the resolver: HTTP ${res.status}`));
      console.error(theme.dim(`  ${url}`));
      return 1;
    }
    view = (await res.json()) as EffectiveView;
  } catch (err) {
    console.error(theme.bad(`backend unreachable: ${(err as Error).message}`));
    console.error(theme.dim('  the capability resolver runs in the fleet; start it, or check AITHER_URL'));
    return 1;
  }

  if (view.resolved === false) {
    console.error(theme.bad(`resolver could not answer: ${view.error || 'unknown'}`));
    return 1;
  }

  const caps = view.capabilities || [];

  // Second form: `aither caps <agent> <resource>` — an advisory yes/no.
  const resource = (args[1] || '').trim();
  if (resource) {
    const [res0, act0] = resource.includes(':') ? resource.split(':') : [resource, 'execute'];
    const ok = caps.some((c) => {
      const i = c.lastIndexOf(':');
      const spec = i === -1 ? c : c.slice(0, i);
      const granted = i === -1 ? '*' : c.slice(i + 1);
      return spec === res0 && grantSatisfies(granted, act0);
    });
    console.log(`${ok ? theme.ok('yes') : theme.bad('no')}  ${agent} ${act0} ${res0}`);
    console.log(theme.dim('  advisory — the authoritative check runs at the call site in the fleet'));
    return ok ? 0 : 1;
  }

  const bound = view.bounded_by_principal
    ? theme.ok(`bounded by your role (${view.principal || 'you'})`)
    : theme.warn('NOT bounded by a principal — this is the agent ceiling alone');

  console.log(`\n${theme.accent(agent)} — ${caps.length} capabilit${caps.length === 1 ? 'y' : 'ies'}`);
  console.log(`  ${bound}\n`);
  for (const c of caps) console.log(`  ${c}`);
  console.log('');
  return 0;
}
