/**
 * One command, one entry, one /help row.
 *
 * Before this test the shell carried full second copies of commands under another
 * name -- /generate beside /imagine (two image paths), /backup beside /backups,
 * /gaming beside /gpu -- and alias spellings registered as `COMMANDS['gen'] =
 * COMMANDS['imagine']`, which made /help list the same command once per spelling.
 * Pinned here:
 *   - no two registry entries share a Command object or a handler function;
 *   - every alias in COMMAND_ALIASES reaches an existing command and shadows none;
 *   - /help lists each command exactly once, with its aliases on that row;
 *   - commands.json (the offline registry) carries exactly the same aliases;
 *   - the owner's pairs stay folded: /gen /generate /draw -> /imagine, etc.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const {
  COMMAND_ALIASES, aliasesOf, canonicalCommandName, getCommand, getCommandNames, helpRows,
} = await import('../src/commands.js');
const { CommandRegistry } = await import('../src/command-registry.js');

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('no two registry entries share a Command object or a handler', () => {
  const byCmd = new Map<unknown, string[]>();
  const byHandler = new Map<unknown, string[]>();
  for (const name of getCommandNames()) {
    const cmd = getCommand(name)!;
    byCmd.set(cmd, [...(byCmd.get(cmd) || []), name]);
    byHandler.set(cmd.handler, [...(byHandler.get(cmd.handler) || []), name]);
  }
  const shared = [...byCmd.values(), ...byHandler.values()].filter((names) => names.length > 1);
  assert.deepEqual(shared, [], `declare the extra spelling in COMMAND_ALIASES: ${JSON.stringify(shared)}`);
});

test('every alias reaches an existing command and shadows none', () => {
  const names = new Set(getCommandNames());
  for (const [alias, target] of Object.entries(COMMAND_ALIASES)) {
    assert.ok(names.has(target), `alias /${alias} points at /${target}, which does not exist`);
    assert.ok(!names.has(alias), `alias /${alias} is also a command -- the alias would never run`);
    assert.equal(getCommand(alias), getCommand(target), `/${alias} must run /${target}'s handler`);
    assert.equal(canonicalCommandName(alias), target);
  }
});

test("the owner's redundant pairs are aliases of one canonical command", () => {
  const folded: Record<string, string> = {
    gen: 'imagine', generate: 'imagine', draw: 'imagine',
    backup: 'backups', gaming: 'gpu', elevate: 'v4',
  };
  for (const [alias, canonical] of Object.entries(folded)) {
    assert.ok(!getCommandNames().includes(alias), `/${alias} must not be its own entry`);
    assert.equal(getCommand(alias), getCommand(canonical), `/${alias} -> /${canonical}`);
  }
  assert.deepEqual(aliasesOf('imagine'), ['draw', 'gen', 'generate']);
});

test('/help lists every command exactly once, aliases on the canonical row', async () => {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    await getCommand('help')!.handler(undefined as never, '', undefined as never);
  } finally {
    console.log = realLog;
  }
  const rows = lines.join('\n').split('\n').map(stripAnsi)
    .map((l) => /^\/([a-z0-9-]+)/i.exec(l.trimStart()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
  const twice = rows.filter((n, i) => rows.indexOf(n) !== i);
  assert.deepEqual(twice, [], `listed more than once: ${twice.join(', ')}`);
  for (const alias of Object.keys(COMMAND_ALIASES)) {
    assert.ok(!rows.includes(alias), `/${alias} is an alias and must not get its own /help row`);
  }
  assert.deepEqual([...rows].sort(), [...getCommandNames()].sort());
  const text = stripAnsi(lines.join('\n'));
  assert.match(text, /\/imagine \(alias: \/draw, \/gen, \/generate\)/);
  assert.equal(helpRows().length, getCommandNames().length);
});

test('commands.json carries exactly the COMMAND_ALIASES table', () => {
  const data = JSON.parse(readFileSync(join(here, '..', 'commands.json'), 'utf-8'));
  const fromJson: Record<string, string> = {};
  for (const c of data.commands) for (const a of c.aliases || []) fromJson[a] = c.name;
  assert.deepEqual(fromJson, { ...COMMAND_ALIASES },
    'regenerate: python AitherOS/dev/tools/check_shell_command_roster.py --write');
});

test('the offline registry holds no entry whose name is an alias', () => {
  const reg = new CommandRegistry();
  const entryNames = reg.allCommands().map((c: { name: string }) => c.name);
  const clash = entryNames.filter((n: string) => n in COMMAND_ALIASES);
  assert.deepEqual(clash, []);
});

test('/rc and /devices are registered commands', () => {
  assert.ok(getCommand('rc'), '/rc');
  assert.ok(getCommand('devices'), '/devices');
});
