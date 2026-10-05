import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWalletCommand, WALLET_GATEWAY } from '../src/wallet-command.js';

const WALLET = {
  balance: 2597, plan: 'free', bought: 2000, earned: 40, granted: 1000, spent: 450,
  unreconciled: 0, credits_per_usd: 1000,
  buy: { card: 'https://shop.example/credits', x402_quote: 'https://gw.example/q' },
};

function deps(status = 200) {
  const lines: string[] = [];
  const calls: string[] = [];
  return {
    lines, calls,
    d: {
      token: () => 'tok',
      print: (l: string) => lines.push(l),
      fetchJson: async (url: string, token: string) => {
        calls.push(`${url} ${token}`);
        if (status !== 200) return { status, body: null };
        return url.includes('/ledger')
          ? { status: 200, body: { events: [{ at: '2026-10-04T00:00:02', type: 'x402_settle', delta: 2000 }] } }
          : { status: 200, body: WALLET };
      },
    },
  };
}

test('prints balance, totals, ledger and buy links', async () => {
  const { lines, calls, d } = deps();
  assert.equal(await runWalletCommand(['--ledger', '5'], d), 0);
  const out = lines.join('\n');
  assert.match(out, /2,597 tokens/);
  assert.match(out, /Earned 40/);
  assert.match(out, /x402_settle/);
  assert.match(out, /shop\.example\/credits/);
  assert.ok(calls.includes(`${WALLET_GATEWAY}/v1/wallet tok`));
  assert.ok(calls.some((c) => c.includes('/v1/wallet/ledger?limit=5')));
});

test('json output', async () => {
  const { lines, d } = deps();
  assert.equal(await runWalletCommand(['--json'], d), 0);
  assert.equal(JSON.parse(lines.join('\n')).wallet.balance, 2597);
});

test('rejected token points at login', async () => {
  const { lines, d } = deps(401);
  assert.equal(await runWalletCommand([], d), 1);
  assert.match(lines.join('\n'), /aither login/);
});

test('not signed in', async () => {
  const lines: string[] = [];
  assert.equal(await runWalletCommand([], { token: () => null, print: (l) => lines.push(l) }), 1);
});
