/**
 * `aither wallet [--ledger N] [--json]` — your Aitherium wallet from the terminal.
 *
 * Reads GET <gateway>/v1/wallet (and /v1/wallet/ledger) with the saved token from
 * ~/.aither/auth.json: balance, lifetime bought/earned/granted/spent, recent
 * activity, and how to buy more (card shop, or x402 USDC for an agent with a
 * wallet). The same answer as the workspace, `adk wallet` and the MCP
 * `wallet_status` tool, because they all read the same ACTA ledger.
 */

import { getActiveToken } from './auth.js';

export const WALLET_GATEWAY = (process.env.AITHER_GATEWAY_URL || 'https://gateway.aitherium.com')
  .replace(/\/+$/, '');

export interface WalletDeps {
  token?: () => string | null;
  fetchJson?: (url: string, token: string) => Promise<{ status: number; body: any }>;
  print?: (line: string) => void;
}

async function defaultFetchJson(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'awsh' } });
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

const fmt = (n: unknown) => Number(n || 0).toLocaleString('en-US');

export async function runWalletCommand(args: string[], deps: WalletDeps = {}): Promise<number> {
  const print = deps.print || ((l: string) => console.log(l));
  const token = (deps.token || getActiveToken)();
  if (!token) {
    print('Not signed in. Run: aither login');
    return 1;
  }
  const json = args.includes('--json');
  const li = args.indexOf('--ledger');
  const ledgerN = li >= 0 ? Math.max(0, Math.min(50, Number(args[li + 1]) || 10)) : 0;
  const get = deps.fetchJson || defaultFetchJson;

  let w;
  try {
    w = await get(`${WALLET_GATEWAY}/v1/wallet`, token);
  } catch (e: any) {
    print(`Could not reach ${WALLET_GATEWAY}: ${e?.message || e}`);
    return 1;
  }
  if (w.status === 401) {
    print('Your token was not accepted. Run: aither login');
    return 1;
  }
  if (w.status !== 200 || !w.body) {
    print(`Wallet answered HTTP ${w.status}`);
    return 1;
  }
  const ledger = ledgerN
    ? (await get(`${WALLET_GATEWAY}/v1/wallet/ledger?limit=${ledgerN}`, token)).body
    : null;

  if (json) {
    print(JSON.stringify({ wallet: w.body, ledger }, null, 2));
    return 0;
  }
  const b = w.body;
  const perUsd = Number(b.credits_per_usd || 1000);
  print('');
  print('  Aitherium Wallet');
  print(`  Balance   ${fmt(b.balance)} tokens (~$${(Number(b.balance || 0) / perUsd).toFixed(2)})   plan ${b.plan || 'free'}`);
  print(`  Bought ${fmt(b.bought)} · Earned ${fmt(b.earned)} · Granted ${fmt(b.granted)} · Spent ${fmt(b.spent)}`);
  if (Number(b.unreconciled || 0)) {
    print(`  (${fmt(b.unreconciled)} of the balance predates ledger history)`);
  }
  for (const e of ledger?.events || []) {
    const d = Number(e.delta || 0);
    print(`  ${String(e.at || '').slice(0, 19)}  ${d > 0 ? '+' : ''}${fmt(d).padStart(9)}  ${e.type}`);
  }
  if (b.buy?.card) print(`  Buy: ${b.buy.card}`);
  if (b.buy?.x402_quote) print(`  USDC (x402): ${b.buy.x402_quote}`);
  print('');
  return 0;
}
