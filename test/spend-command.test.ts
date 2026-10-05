/**
 * `/spend` + the status-bar spend segment.
 *
 * What must hold:
 *  - the report carries totals, per provider/model, top callers and the balance;
 *  - an unavailable/off-contract answer prints `spend unavailable` and NO numbers;
 *  - the bar segment exists only when a measured number is cached, shows its age
 *    when old, and a failed refresh keeps the last good numbers;
 *  - the shared cache file is written only for the 24h window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cacheNeedsRefresh, formatSpendReport, formatSpendSegment, parseSpendWindow, readSpendCache,
  refreshSpendCache, runSpendCommand, segmentFromCache, toolPayload, validateSpend,
  writeSpendCache, type SpendReport,
} from '../src/spend-command.js';
import { formatStatusBar, type StatusInfo } from '../src/status-banner.js';

const CONTRACT: SpendReport = {
  window_hours: 24, generated_at: '2026-10-04T12:00:00Z', total_usd: 12.3456, unpriced_requests: 2,
  providers: [{
    provider: 'deepseek', usd: 12.3456, prompt_tokens: 1_000_000, completion_tokens: 50_000,
    requests: 40, failed: 1,
    models: [{ model: 'deepseek-v4-flash', usd: 12.3456, prompt_tokens: 1_000_000,
      completion_tokens: 50_000, requests: 40 }],
  }],
  top_sources: [{ source: 'vnext_pillars_teacher', usd: 9, requests: 30, tokens: 1200 }],
  balance: { deepseek: { available: true, total_balance: '12.34', currency: 'USD',
    checked_at: '2026-10-04T12:00:00Z', error: null } },
};

const tmpCache = () => join(mkdtempSync(join(tmpdir(), 'spend-')), 'spend-cache.json');

test('window parsing', () => {
  assert.equal(parseSpendWindow(''), 24);
  assert.equal(parseSpendWindow('24h'), 24);
  assert.equal(parseSpendWindow('7d'), 168);
  assert.equal(parseSpendWindow('30d'), 720);
  assert.equal(parseSpendWindow('48'), 48);
  assert.equal(parseSpendWindow('soon'), null);
  assert.equal(parseSpendWindow('0h'), null);
});

test('compact segment: total, and the balance only when low', () => {
  assert.equal(formatSpendSegment(CONTRACT, 5), '$12.35/24h');
  const low = { ...CONTRACT, balance: { deepseek: { ...CONTRACT.balance!.deepseek, total_balance: '4.10' } } };
  assert.equal(formatSpendSegment(low, 5), '$12.35/24h ds $4.10 low');
  const unavailable = { ...CONTRACT, balance: { deepseek: { available: false, total_balance: null, error: '401' } } };
  assert.equal(formatSpendSegment(unavailable, 5), '$12.35/24h');
  assert.equal(formatSpendSegment({ ...CONTRACT, window_hours: 168 }, 0), '$12.35/7d');
});

test('report carries every section', () => {
  const text = formatSpendReport(CONTRACT).join('\n');
  assert.match(text, /last 24h/);
  assert.match(text, /Total {2}\$12\.35 {3}\+ 2 unpriced request\(s\) NOT in the total/);
  assert.match(text, /deepseek .*\(1 failed\).*1,000,000 in \/ 50,000 out tok/);
  assert.match(text, /deepseek-v4-flash/);
  assert.match(text, /Top callers\n\s+vnext_pillars_teacher\s+\$9\.00/);
  assert.match(text, /DeepSeek balance {2}12\.34 USD {2}\(checked 12:00Z\)/);
});

test('off-contract answers never validate (no fake zeros)', () => {
  for (const bad of [null, {}, [], { error: 'Unknown tool: cloud_spend' }, { total_usd: 1 },
    { total_usd: 'n/a', providers: [] }]) {
    assert.equal(validateSpend(bad), null, JSON.stringify(bad));
  }
});

test('toolPayload unwraps text, structured and error results', () => {
  assert.ok(validateSpend(toolPayload({ content: [{ type: 'text', text: JSON.stringify(CONTRACT) }] })));
  assert.ok(validateSpend(toolPayload({ structuredContent: CONTRACT as unknown as Record<string, unknown>, content: [] })));
  assert.deepEqual(toolPayload({ isError: true, content: [{ type: 'text', text: 'boom' }] }), { error: 'boom' });
});

test('/spend prints the report and writes the shared cache for 24h', async () => {
  const lines: string[] = [];
  const path = tmpCache();
  const asked: number[] = [];
  const rc = await runSpendCommand([], {
    fetch: async (h) => { asked.push(h); return CONTRACT; }, print: (l) => lines.push(l), cachePath: path,
  });
  assert.equal(rc, 0);
  assert.deepEqual(asked, [24]);
  assert.ok(lines.some(l => l.includes('Total  $12.35')));
  assert.equal(readSpendCache(path)?.data?.total_usd, 12.3456);
});

test('/spend 7d does not overwrite the 24h cache', async () => {
  const path = tmpCache();
  const rc = await runSpendCommand(['7d'], { fetch: async () => ({ ...CONTRACT, window_hours: 168 }),
    print: () => {}, cachePath: path });
  assert.equal(rc, 0);
  assert.equal(readSpendCache(path), null);
});

test('/spend unavailable prints the reason and no numbers', async () => {
  const lines: string[] = [];
  const rc = await runSpendCommand(['24h'], {
    fetch: async () => { throw new Error('cloud_spend gave no spend report: Unknown tool'); },
    print: (l) => lines.push(l), cachePath: null,
  });
  assert.equal(rc, 2);
  assert.deepEqual(lines, ['spend unavailable: cloud_spend gave no spend report: Unknown tool']);
});

test('bad window prints usage', async () => {
  const lines: string[] = [];
  assert.equal(await runSpendCommand(['soon'], { print: (l) => lines.push(l), cachePath: null }), 2);
  assert.match(lines[0], /usage: \/spend/);
});

test('cache: failed first refresh hides; failed later refresh keeps numbers with age', async () => {
  const path = tmpCache();
  const boom = async (): Promise<SpendReport> => { throw new Error('gateway down'); };
  const first = await refreshSpendCache(boom, path, 1000);
  assert.equal(first.data, null);
  assert.match(first.error || '', /gateway down/);
  assert.deepEqual(segmentFromCache(readSpendCache(path), 1001, 5), { text: '', low: false });

  await refreshSpendCache(async () => CONTRACT, path, 2000);
  await refreshSpendCache(boom, path, 3000);
  const kept = readSpendCache(path);
  assert.equal(kept?.fetched_at, 2000);
  assert.equal(kept?.attempted_at, 3000);
  assert.deepEqual(segmentFromCache(kept, 2000 + 1800, 5), { text: '$12.35/24h (30m)', low: false });
  assert.equal(segmentFromCache(kept, 2000 + 7 * 3600, 5).text, '');
});

test('cache refresh throttle is 60 s', () => {
  assert.ok(cacheNeedsRefresh(null, 0));
  assert.ok(!cacheNeedsRefresh({ data: null, fetched_at: null, attempted_at: 100, error: null }, 159));
  assert.ok(cacheNeedsRefresh({ data: null, fetched_at: null, attempted_at: 100, error: null }, 160));
});

test('status bar shows the spend segment only when measured', () => {
  const base: StatusInfo = { genesisHost: 'x', online: true, backendType: 'genesis',
    backendName: 'Genesis', serviceLines: [], models: [] };
  assert.ok(!formatStatusBar(base).some(s => s.key === 'spend'));
  const seg = formatStatusBar({ ...base, spend: { text: '$1.20/24h ds $4.10 low', low: true } })
    .find(s => s.key === 'spend');
  assert.ok(seg);
  assert.equal(seg!.plain, '◎ $1.20/24h ds $4.10 low');
});

test('writeSpendCache round-trips', () => {
  const path = tmpCache();
  writeSpendCache({ data: CONTRACT, fetched_at: 1, attempted_at: 1, error: null }, path);
  assert.equal(readSpendCache(path)?.data?.providers[0].provider, 'deepseek');
});
