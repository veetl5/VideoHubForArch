// opencode's config: the MCP server entry and the review rule block are spliced into the user's own files, so these
// tests are about never damaging what is already there (other servers, models, comments) and about being idempotent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configPath, agentsPath, opencodeHome, parseJsonc, upsertMcpEntry, removeMcpEntry, applyRuleBlock, dropRuleBlock, run, BEGIN, END,
} from './opencode-config.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vh-opencode-'));
const ENTRY = { type: 'local', command: ['/usr/bin/node', '/opt/videohub/server/mcp.js'], enabled: true };

test('opencode paths follow XDG_CONFIG_HOME', () => {
  const env = { XDG_CONFIG_HOME: '/tmp/xdg', HOME: '/home/u' };
  assert.equal(opencodeHome(env), path.join('/tmp/xdg', 'opencode'));
  assert.equal(agentsPath(env), path.join('/tmp/xdg', 'opencode', 'AGENTS.md'));
  assert.equal(opencodeHome({ HOME: '/home/u' }), path.join('/home/u', '.config', 'opencode'));
});

test('configPath keeps a .jsonc config that is already there, else uses opencode.json', () => {
  const home = tmp();
  const env = { XDG_CONFIG_HOME: home };
  assert.equal(configPath(env), path.join(home, 'opencode', 'opencode.json'));   // nothing yet
  fs.mkdirSync(path.join(home, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, 'opencode', 'opencode.jsonc'), '{}');
  assert.equal(configPath(env), path.join(home, 'opencode', 'opencode.jsonc'));  // newer installs
  fs.writeFileSync(path.join(home, 'opencode', 'opencode.json'), '{}');
  assert.equal(configPath(env), path.join(home, 'opencode', 'opencode.json'));   // both: .json wins
});

test('parseJsonc reads comments and trailing commas', () => {
  const j = parseJsonc(`{
    // a model
    "model": "x", /* inline */
    "list": [1, 2,],
  }`);
  assert.deepEqual(j, { model: 'x', list: [1, 2] });
});

test('an empty or missing config gets a fresh one with the server in it', () => {
  const { text, changed } = upsertMcpEntry('', 'videohub', ENTRY);
  assert.equal(changed, true);
  const j = parseJsonc(text);
  assert.equal(j.$schema, 'https://opencode.ai/config.json');
  assert.deepEqual(j.mcp.videohub, ENTRY);
});

test('the server is added without touching the rest of the file', () => {
  const before = '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "anthropic/claude-sonnet-4",\n  "mcp": {\n    "other": { "type": "local", "command": ["npx", "x"] }\n  }\n}\n';
  const { text, changed } = upsertMcpEntry(before, 'videohub', ENTRY);
  assert.equal(changed, true);
  const j = parseJsonc(text);
  assert.equal(j.model, 'anthropic/claude-sonnet-4');
  assert.deepEqual(j.mcp.other, { type: 'local', command: ['npx', 'x'] });
  assert.deepEqual(j.mcp.videohub, ENTRY);
  assert.ok(before.split('\n')[1] === text.split('\n')[1], 'the schema line stays where it was');
});

test('comments in a .jsonc config survive the edit', () => {
  const before = `{
  // the model I like
  "model": "x",
  "mcp": {
    /* my other server */
    "other": { "type": "local", "command": ["npx", "y"] }
  }
}
`;
  const { text } = upsertMcpEntry(before, 'videohub', ENTRY);
  assert.ok(text.includes('// the model I like'), 'the line comment stays');
  assert.ok(text.includes('/* my other server */'), 'the block comment stays');
  assert.deepEqual(parseJsonc(text).mcp.videohub, ENTRY);
});

test('a config with no mcp block gets one, and an empty mcp block gets the server', () => {
  const a = upsertMcpEntry('{\n  "model": "x"\n}\n', 'videohub', ENTRY);
  assert.deepEqual(parseJsonc(a.text), { model: 'x', mcp: { videohub: ENTRY } });
  const b = upsertMcpEntry('{"model":"x","mcp":{}}', 'videohub', ENTRY);
  assert.deepEqual(parseJsonc(b.text), { model: 'x', mcp: { videohub: ENTRY } });
});

test('adding twice changes nothing the second time', () => {
  const once = upsertMcpEntry('{\n  "model": "x"\n}\n', 'videohub', ENTRY);
  const twice = upsertMcpEntry(once.text, 'videohub', ENTRY);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
});

test('a moved install (new path) updates the entry in place', () => {
  const once = upsertMcpEntry('{\n  "model": "x"\n}\n', 'videohub', ENTRY);
  const moved = { ...ENTRY, command: ['/usr/bin/node', '/new/place/server/mcp.js'] };
  const { text, changed } = upsertMcpEntry(once.text, 'videohub', moved);
  assert.equal(changed, true);
  assert.deepEqual(parseJsonc(text).mcp.videohub, moved);
  assert.equal(parseJsonc(text).model, 'x');
});

test('removing the server leaves the other ones and a readable file', () => {
  const before = '{\n  "mcp": {\n    "videohub": { "type": "local", "command": ["node", "mcp.js"] },\n    "other": { "type": "local", "command": ["npx", "x"] }\n  }\n}\n';
  const { text, changed } = removeMcpEntry(before, 'videohub');
  assert.equal(changed, true);
  assert.deepEqual(parseJsonc(text), { mcp: { other: { type: 'local', command: ['npx', 'x'] } } });
  const only = removeMcpEntry('{\n  "mcp": {\n    "videohub": { "type": "local" }\n  }\n}\n', 'videohub');
  assert.deepEqual(parseJsonc(only.text), {}, 'an mcp block left empty goes too');
  const absent = removeMcpEntry(before, 'nope');
  assert.equal(absent.changed, false);
  assert.equal(absent.text, before);
});

test('the rule block is added, replaced and removed between its markers', () => {
  const block = `${BEGIN}\nDo the thing.\n${END}`;
  const fresh = applyRuleBlock('', block);
  assert.equal(fresh.trim(), block);
  const after = applyRuleBlock('# My rules\n\nBe nice.\n', block);
  assert.ok(after.startsWith('# My rules\n\nBe nice.'));
  assert.ok(after.includes('Do the thing.'));
  const replaced = applyRuleBlock(after, `${BEGIN}\nDo the other thing.\n${END}`);
  assert.equal((replaced.match(/videohub:begin/g) || []).length, 1, 'never two copies');
  assert.ok(replaced.includes('Do the other thing.') && !replaced.includes('Do the thing.'));
  assert.equal(dropRuleBlock(replaced), '# My rules\n\nBe nice.\n');
  assert.equal(dropRuleBlock('nothing here'), 'nothing here');
});

test('mcp-add writes the file, and --dry-run does not', () => {
  const dir = tmp(), file = path.join(dir, 'opencode.json');
  const dry = run(['mcp-add', '--config', file, '--command-json', JSON.stringify(ENTRY.command), '--dry-run']);
  assert.equal(dry.ok, true); assert.equal(dry.changed, true);
  assert.equal(fs.existsSync(file), false, 'dry run writes nothing');
  const real = run(['mcp-add', '--config', file, '--command-json', JSON.stringify(ENTRY.command)]);
  assert.equal(real.changed, true);
  assert.deepEqual(parseJsonc(fs.readFileSync(file, 'utf8')).mcp.videohub, ENTRY);
  const again = run(['mcp-add', '--config', file, '--command-json', JSON.stringify(ENTRY.command)]);
  assert.equal(again.changed, false);
});

test('a config that cannot be read is never rewritten', () => {
  const dir = tmp(), file = path.join(dir, 'opencode.json');
  const broken = '{"mcp": {"videohub": ';
  fs.writeFileSync(file, broken);
  assert.throws(() => run(['mcp-add', '--config', file, '--command-json', JSON.stringify(ENTRY.command)]), /unclosed|unreadable|JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), broken, 'the user’s file is untouched');
});

test('mcp-remove only touches this install (--expect)', () => {
  const dir = tmp(), file = path.join(dir, 'opencode.json');
  fs.writeFileSync(file, JSON.stringify({ mcp: { videohub: { type: 'local', command: ['/a/server/mcp.js'] } } }, null, 2) + '\n');
  const other = run(['mcp-remove', '--config', file, '--expect', '/b/server/mcp.js']);
  assert.equal(other.changed, false);
  assert.ok(fs.readFileSync(file, 'utf8').includes('/a/server/mcp.js'));
  const mine = run(['mcp-remove', '--config', file, '--expect', '/a/server/mcp.js']);
  assert.equal(mine.changed, true);
  assert.deepEqual(parseJsonc(fs.readFileSync(file, 'utf8')), {});
});

test('rule-add fills {{VIDEOHUB_DIR}} in and rule-remove cleans up', () => {
  const dir = tmp(), agents = path.join(dir, 'AGENTS.md'), rule = path.join(dir, 'rule.md');
  fs.writeFileSync(rule, 'Follow {{VIDEOHUB_DIR}}/docs/PROJECT-CONTRACT.md.');
  const added = run(['rule-add', '--file', agents, '--rule', rule, '--videohub-dir', '/opt/videohub']);
  assert.equal(added.changed, true);
  const text = fs.readFileSync(agents, 'utf8');
  assert.ok(text.includes('/opt/videohub/docs/PROJECT-CONTRACT.md'));
  assert.ok(text.includes(BEGIN) && text.includes(END));
  assert.equal(run(['rule-add', '--file', agents, '--rule', rule, '--videohub-dir', '/opt/videohub']).changed, false);
  assert.equal(run(['rule-remove', '--file', agents, '--expect', '/opt/videohub']).changed, true);
  assert.equal(fs.readFileSync(agents, 'utf8').trim(), '');
});

test('setup then uninstall gives back the very same file', () => {
  const before = `{
  "$schema": "https://opencode.ai/config.json",
  // mine
  "model": "x",
  "mcp": {
    "other": { "type": "local", "command": ["npx", "y"] },
    "last": { "type": "local", "command": ["npx", "z"] }
  }
}
`;
  assert.equal(removeMcpEntry(upsertMcpEntry(before, 'videohub', ENTRY).text, 'videohub').text, before);
  const noMcp = '{\n  "model": "x"\n}\n';
  assert.equal(removeMcpEntry(upsertMcpEntry(noMcp, 'videohub', ENTRY).text, 'videohub').text, noMcp);
  const inline = '{"model":"x","mcp":{}}';
  assert.equal(removeMcpEntry(upsertMcpEntry(inline, 'videohub', ENTRY).text, 'videohub').text, '{"model":"x"}');
});

test('an unknown mode fails loudly', () => {
  assert.throws(() => run(['nonsense']), /unknown mode/);
  assert.throws(() => run(['mcp-add', '--command-json', '[]']), /non-empty/);
});
