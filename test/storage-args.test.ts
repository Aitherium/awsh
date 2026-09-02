/**
 * Test parseStorageArgs — the pure argv parser shared by `aither storage …`
 * and the `/storage` REPL builtin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStorageArgs } from '../src/storage-command.js';

test('parseStorageArgs: subcommand with no flags', () => {
  const parsed = parseStorageArgs(['nodes']);
  assert.equal(parsed.sub, 'nodes');
  assert.deepEqual(parsed.flags, {});
  assert.deepEqual(parsed.positional, []);
  assert.equal(parsed.help, false);
});

test('parseStorageArgs: lowercases the subcommand', () => {
  assert.equal(parseStorageArgs(['NODES']).sub, 'nodes');
  assert.equal(parseStorageArgs(['Inventory']).sub, 'inventory');
});

test('parseStorageArgs: --name value pairs', () => {
  const parsed = parseStorageArgs(['inventory', '--node', 'host', '--top', '10']);
  assert.equal(parsed.sub, 'inventory');
  assert.equal(parsed.flags.node, 'host');
  assert.equal(parsed.flags.top, '10');
});

test('parseStorageArgs: boolean switch when no value follows', () => {
  const parsed = parseStorageArgs(['inventory', '--refetchable']);
  assert.equal(parsed.flags.refetchable, true);
});

test('parseStorageArgs: boolean switch when the next token is itself a flag', () => {
  const parsed = parseStorageArgs(['inventory', '--refetchable', '--top', '5']);
  assert.equal(parsed.flags.refetchable, true);
  assert.equal(parsed.flags.top, '5');
});

test('parseStorageArgs: diff requires both --node and --root (caller validates)', () => {
  const parsed = parseStorageArgs(['diff', '--node', 'host', '--root', 'C:\\']);
  assert.equal(parsed.flags.node, 'host');
  assert.equal(parsed.flags.root, 'C:\\');
});

test('parseStorageArgs: positional args collected in order', () => {
  const parsed = parseStorageArgs(['scan', 'E:\\data']);
  assert.equal(parsed.sub, 'scan');
  assert.deepEqual(parsed.positional, ['E:\\data']);
});

test('parseStorageArgs: --help / -h set the help flag and are never captured as a value', () => {
  const parsed = parseStorageArgs(['nodes', '--help']);
  assert.equal(parsed.help, true);
  assert.equal(parsed.flags.help, undefined);

  const parsed2 = parseStorageArgs(['--help']);
  assert.equal(parsed2.help, true);
  assert.equal(parsed2.sub, '');

  const parsed3 = parseStorageArgs(['diff', '--node', '-h']);
  // '-h' must not be swallowed as the value of --node
  assert.equal(parsed3.flags.node, true);
  assert.equal(parsed3.help, true);
});

test('parseStorageArgs: empty argv is a no-subcommand state, not a crash', () => {
  const parsed = parseStorageArgs([]);
  assert.equal(parsed.sub, '');
  assert.equal(parsed.help, false);
  assert.deepEqual(parsed.positional, []);
});

test('parseStorageArgs: --status all passes through verbatim', () => {
  const parsed = parseStorageArgs(['proposals', '--status', 'all']);
  assert.equal(parsed.flags.status, 'all');
});
