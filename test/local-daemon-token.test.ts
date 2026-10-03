/**
 * awsh presents the owner's awdk daemon credential (~/.aither/daemon-token) to a
 * LOOPBACK daemon only. awdk refuses anonymous callers on an offline box
 * (adk/local_auth.py), so without this the shell's local rung would be refused; and
 * the token must never travel to a remote backend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localDaemonToken, LOCAL_TOKEN_HEADER } from '../src/client.js';

function homeWithToken(value: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'awsh-local-token-'));
  if (value !== null) {
    mkdirSync(join(home, '.aither'));
    writeFileSync(join(home, '.aither', 'daemon-token'), `${value}\n`);
  }
  return home;
}

const ME = 1000;
const OTHER = 1001;
const V4_LO = '0100007F';
const V6_LO = '00000000000000000000000001000000';
const V6_ANY = '0'.repeat(32);
const V6_MAPPED_LO = '0000000000000000FFFF00000100007F';
/** No /proc/net here: the kernel cannot say who listens (the non-Linux path). */
const NO_TABLE = join(tmpdir(), 'awsh-no-proc-net-does-not-exist');

/** A /proc/net with LISTEN rows [address hex, port, uid]. */
function table(tcp: Array<[string, number, number]>, tcp6: Array<[string, number, number]> = []): string {
  const net = mkdtempSync(join(tmpdir(), 'awsh-proc-net-'));
  const hdr = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid\n';
  const body = (rows: Array<[string, number, number]>) => rows.map(([a, p, u], i) =>
    `   ${i}: ${a}:${p.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A ` +
    `00000000:00000000 00:00000000 00000000 ${u}\n`).join('');
  writeFileSync(join(net, 'tcp'), hdr + body(tcp));
  writeFileSync(join(net, 'tcp6'), hdr + body(tcp6));
  return net;
}

test('a loopback daemon gets the token', () => {
  const home = homeWithToken('tok-123');
  assert.equal(localDaemonToken('http://127.0.0.1:9001', home, NO_TABLE, ME), 'tok-123');
  assert.equal(localDaemonToken('http://localhost:9001/chat', home, NO_TABLE, ME), 'tok-123');
  assert.equal(localDaemonToken('http://[::1]:9001', home, NO_TABLE, ME), 'tok-123');
});

test('a remote backend never gets it', () => {
  const home = homeWithToken('tok-123');
  for (const url of ['https://api.aitherium.com', 'http://192.168.1.5:9001',
    'http://127.0.0.1.evil.test:9001', 'http://[::ffff:192.168.1.5]:9001', 'not a url']) {
    assert.equal(localDaemonToken(url, home, NO_TABLE, ME), null, url);
  }
});

test('no token file is no header, not an error', () => {
  assert.equal(localDaemonToken('http://127.0.0.1:9001', homeWithToken(null), NO_TABLE, ME), null);
});

test("the owner's own listener gets the token on every loopback", () => {
  const home = homeWithToken('tok-123');
  const net = table([[V4_LO, 9001, ME]], [[V6_LO, 9001, ME]]);
  for (const url of ['http://127.0.0.1:9001', 'http://localhost:9001', 'http://[::1]:9001']) {
    assert.equal(localDaemonToken(url, home, net, ME), 'tok-123', url);
  }
});

test("another account's listener on our port never gets the token", () => {
  const home = homeWithToken('tok-123');
  const net = table([[V4_LO, 9001, OTHER], [V4_LO, 9002, ME]]);
  assert.equal(localDaemonToken('http://127.0.0.1:9001', home, net, ME), null);
  assert.equal(localDaemonToken('http://127.0.0.1:9002', home, net, ME), 'tok-123');
});

test('a squatter on the other loopback gets nothing through localhost', () => {
  // Review repro: owner on 127.0.0.1:9001, another uid on [::1]:9001.
  const home = homeWithToken('tok-123');
  const net = table([[V4_LO, 9001, ME]], [[V6_LO, 9001, OTHER]]);
  assert.equal(localDaemonToken('http://localhost:9001', home, net, ME), null);
  assert.equal(localDaemonToken('http://[::1]:9001', home, net, ME), null);
  assert.equal(localDaemonToken('http://127.0.0.1:9001', home, net, ME), 'tok-123');
});

test('a squatter on a wildcard or IPv4-mapped address gets nothing', () => {
  const home = homeWithToken('tok-123');
  const wild = table([[V4_LO, 9001, ME]], [[V6_ANY, 9001, OTHER]]);
  assert.equal(localDaemonToken('http://127.0.0.1:9001', home, wild, ME), null);
  const mapped = table([[V4_LO, 9001, ME]], [[V6_MAPPED_LO, 9001, OTHER]]);
  assert.equal(localDaemonToken('http://127.0.0.1:9001', home, mapped, ME), null);
  assert.equal(localDaemonToken('http://[::ffff:127.0.0.1]:9001', home, mapped, ME), null);
});

test('no listener at all gets nothing (fail closed)', () => {
  const home = homeWithToken('tok-123');
  const net = table([[V4_LO, 9002, ME]]);
  assert.equal(localDaemonToken('http://127.0.0.1:9001', home, net, ME), null);
});

test('the header name is the one awdk reads', () => {
  assert.equal(LOCAL_TOKEN_HEADER, 'X-Aither-Local-Token');
});
