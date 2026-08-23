/**
 * Cloudflare Tunnel + DNS CLI commands.
 *
 * Usage:
 *   aither tunnel list                         List all ingress routes
 *   aither tunnel add <subdomain> [service]    Add route (default: veil-lb:3000)
 *   aither tunnel remove <subdomain>           Remove route
 *   aither tunnel status                       Show tunnel health
 *   aither dns add <subdomain>                 Create CNAME
 *   aither dns remove <subdomain>              Delete CNAME
 */

function getGenesisUrl(): string {
  return process.env.GENESIS_URL || 'http://localhost:8001';
}

async function genesisGet(path: string): Promise<any> {
  const res = await fetch(`${getGenesisUrl()}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function genesisPost(path: string, body: any = {}): Promise<any> {
  const res = await fetch(`${getGenesisUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function genesisDelete(path: string): Promise<any> {
  const res = await fetch(`${getGenesisUrl()}${path}`, { method: 'DELETE', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── Tunnel commands ──────────────────────────────────────────────────────

async function tunnelList(): Promise<void> {
  try {
    const data = await genesisGet('/cloudflare/tunnel/routes');
    console.log(`\x1b[36mTunnel Ingress Routes\x1b[0m (${data.count || data.routes?.length || 0})\n`);
    for (const r of data.routes || []) {
      const host = r.hostname || '* (catch-all)';
      console.log(`  ${host.padEnd(35)} → ${r.service}`);
    }
  } catch (e: any) {
    console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
  }
}

async function tunnelAdd(args: string[]): Promise<void> {
  const subdomain = args[0];
  if (!subdomain) {
    console.log('\x1b[33mUsage:\x1b[0m aither tunnel add <subdomain> [service]');
    return;
  }
  const hostname = subdomain.includes('.') ? subdomain : `${subdomain}.aitherium.com`;
  const service = args[1] || 'http://aitheros-veil-lb:3000';

  console.log(`\x1b[2mAdding route: ${hostname} → ${service}...\x1b[0m`);
  try {
    const data = await genesisPost('/cloudflare/tunnel/add', { hostname, service });
    if (data.action === 'exists') {
      console.log(`\x1b[33m!\x1b[0m Route already exists: ${hostname} → ${data.service}`);
    } else {
      console.log(`\x1b[32m✓\x1b[0m Route added: ${hostname} → ${service} (${data.total_rules} total)`);
    }
  } catch (e: any) {
    console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
  }
}

async function tunnelRemove(args: string[]): Promise<void> {
  const subdomain = args[0];
  if (!subdomain) {
    console.log('\x1b[33mUsage:\x1b[0m aither tunnel remove <subdomain>');
    return;
  }
  const hostname = subdomain.includes('.') ? subdomain : `${subdomain}.aitherium.com`;

  try {
    const data = await genesisDelete(`/cloudflare/tunnel/${hostname}`);
    if (data.action === 'not_found') {
      console.log(`\x1b[33m!\x1b[0m No route found for ${hostname}`);
    } else {
      console.log(`\x1b[32m✓\x1b[0m Removed: ${hostname}`);
    }
  } catch (e: any) {
    console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
  }
}

async function tunnelStatus(): Promise<void> {
  try {
    const data = await genesisGet('/cloudflare/tunnel/status');
    console.log(`\x1b[36mTunnel Status\x1b[0m`);
    console.log(`  Name:    ${data.name}`);
    console.log(`  Status:  ${data.status}`);
    console.log(`  ID:      ${data.id}`);
    if (data.connections?.length) {
      console.log(`  Connections:`);
      for (const c of data.connections) {
        console.log(`    ${c.colo_name || c.id} (${c.is_pending_reconnect ? 'reconnecting' : 'active'})`);
      }
    }
  } catch (e: any) {
    console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
  }
}

export async function handleTunnelCommand(args: string[]): Promise<void> {
  const sub = args[0] || 'help';
  switch (sub) {
    case 'list': case 'ls': return tunnelList();
    case 'add': return tunnelAdd(args.slice(1));
    case 'remove': case 'rm': return tunnelRemove(args.slice(1));
    case 'status': return tunnelStatus();
    default:
      console.log(`\x1b[36mTunnel Management\x1b[0m\n`);
      console.log('  aither tunnel list                      List ingress routes');
      console.log('  aither tunnel add <sub> [service]       Add route');
      console.log('  aither tunnel remove <sub>              Remove route');
      console.log('  aither tunnel status                    Show health');
  }
}

// ── DNS commands ─────────────────────────────────────────────────────────

async function dnsAdd(args: string[]): Promise<void> {
  const subdomain = args[0];
  if (!subdomain) {
    console.log('\x1b[33mUsage:\x1b[0m aither dns add <subdomain>');
    return;
  }
  console.log(`\x1b[2mCreating CNAME: ${subdomain}.aitherium.com...\x1b[0m`);
  try {
    const data = await genesisPost('/cloudflare/dns/add', { subdomain });
    console.log(`\x1b[32m✓\x1b[0m DNS ${data.action}: ${subdomain}.aitherium.com`);
  } catch (e: any) {
    console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
  }
}

async function dnsRemove(args: string[]): Promise<void> {
  const subdomain = args[0];
  if (!subdomain) {
    console.log('\x1b[33mUsage:\x1b[0m aither dns remove <subdomain>');
    return;
  }
  try {
    const data = await genesisDelete(`/cloudflare/dns/${subdomain}`);
    console.log(`\x1b[32m✓\x1b[0m DNS ${data.action}: ${subdomain}.aitherium.com`);
  } catch (e: any) {
    console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
  }
}

export async function handleDnsCommand(args: string[]): Promise<void> {
  const sub = args[0] || 'help';
  switch (sub) {
    case 'add': return dnsAdd(args.slice(1));
    case 'remove': case 'rm': return dnsRemove(args.slice(1));
    default:
      console.log(`\x1b[36mDNS Management\x1b[0m\n`);
      console.log('  aither dns add <subdomain>        Create CNAME');
      console.log('  aither dns remove <subdomain>     Delete CNAME');
  }
}
