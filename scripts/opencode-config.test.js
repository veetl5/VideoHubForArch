// opencode's config: the MCP server entry and the review rule block are spliced into the user's own files, so these
// tests are about never damaging what is already there (other servers, models, comments) and about being idempotent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configPath, agentsPath, opencodeHome, parseJsonc, upsertMcpEntry, removeMcpEntry, applyRuleBlock, dropRuleBlock, run, BEGIN, END,
  desktopFound, opencodeVersion, probeMcp,
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

test('status says what is missing, and when everything is in place', () => {
  const dir = tmp(), cfg = path.join(dir, 'opencode.json'), ag = path.join(dir, 'AGENTS.md'), sk = path.join(dir, 'skills', 'videohub', 'SKILL.md'), rule = path.join(dir, 'rule.md');
  const hub = '/opt/videohub', status = () => run(['status', '--config', cfg, '--file', ag, '--skill', sk, '--videohub-dir', hub]);
  let s = status();
  assert.equal(s.ready, false);
  assert.match(s.action, /no "videohub" MCP server/);
  run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(['/usr/bin/node', hub + '/server/mcp.js'])]);
  s = status();
  assert.equal(s.mcp.found, true); assert.equal(s.mcp.pointsHere, true); assert.equal(s.rule.found, false);
  assert.equal(s.ready, false); assert.match(s.action, /no VideoHub rule/);
  fs.writeFileSync(rule, 'rule text');
  run(['rule-add', '--file', ag, '--rule', rule, '--videohub-dir', hub]);
  s = status();
  assert.equal(s.ready, false); assert.match(s.action, /no skill file/);
  fs.mkdirSync(path.dirname(sk), { recursive: true }); fs.writeFileSync(sk, 'skill');
  s = status();
  assert.equal(s.ready, true); assert.match(s.action, /is set up/);
  // the entry points at another copy of VideoHub
  run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(['/usr/bin/node', '/elsewhere/server/mcp.js'])]);
  s = status();
  assert.equal(s.mcp.pointsHere, false); assert.equal(s.ready, false); assert.match(s.action, /instead of \/opt\/videohub/);
});

test('mcp-add writes both config shapes: mcp.videohub (1.x) and mcp.servers.videohub (V2, desktop)', () => {
  const dir = tmp(), cfg = path.join(dir, 'opencode.json');
  const cmd = ['/usr/bin/node', '/opt/videohub/server/mcp.js'];
  const r = run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(cmd)]);
  assert.equal(r.changed, true);
  const j = parseJsonc(fs.readFileSync(cfg, 'utf8'));
  assert.deepEqual(j.mcp.videohub, { type: 'local', command: cmd, enabled: true });   // 1.x keeps "enabled"
  assert.deepEqual(j.mcp.servers.videohub, { type: 'local', command: cmd });          // V2: "disabled" instead, so none
  assert.ok(!('enabled' in j.mcp.servers.videohub));
  assert.ok(!('servers' in j.mcp.videohub));
  // running it again changes nothing at all
  const before = fs.readFileSync(cfg, 'utf8');
  assert.equal(run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(cmd)]).changed, false);
  assert.equal(fs.readFileSync(cfg, 'utf8'), before);
  // an older VideoHub entry (1.x only) gains the V2 shape without losing its own
  fs.writeFileSync(cfg, JSON.stringify({ mcp: { videohub: { type: 'local', command: cmd, enabled: true } } }));
  assert.equal(run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(cmd)]).changed, true);
  assert.deepEqual(parseJsonc(fs.readFileSync(cfg, 'utf8')).mcp.servers.videohub, { type: 'local', command: cmd });
});

test('mcp-add --schema picks one shape, and a bad one fails', () => {
  const dir = tmp(), cfg = path.join(dir, 'opencode.json');
  const cmd = ['/usr/bin/node', '/opt/videohub/server/mcp.js'];
  run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(cmd), '--schema', 'v2']);
  let j = parseJsonc(fs.readFileSync(cfg, 'utf8'));
  assert.deepEqual(Object.keys(j.mcp), ['servers']);
  assert.equal(run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(cmd), '--schema', 'v1']).changed, true);
  j = parseJsonc(fs.readFileSync(cfg, 'utf8'));
  assert.deepEqual(j.mcp.videohub, { type: 'local', command: cmd, enabled: true });
  assert.throws(() => run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(cmd), '--schema', 'v3']), /schema/);
});

test('mcp-remove takes the server out of both shapes and leaves nothing empty behind', () => {
  const dir = tmp(), cfg = path.join(dir, 'opencode.json');
  const cmd = ['/usr/bin/node', '/opt/videohub/server/mcp.js'];
  fs.writeFileSync(cfg, `{\n  // mine\n  "model": "x/y",\n  "mcp": {\n    "other": { "type": "local", "command": ["npx","other"] }\n  }\n}\n`);
  const original = fs.readFileSync(cfg, 'utf8');
  run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(cmd)]);
  run(['mcp-remove', '--config', cfg]);
  assert.equal(fs.readFileSync(cfg, 'utf8'), original);   // the user's file comes back byte for byte
  // V2 only: removing it drops the "servers" block and the now empty "mcp" too
  run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(cmd), '--schema', 'v2']);
  run(['mcp-remove', '--config', cfg]);
  assert.equal(fs.readFileSync(cfg, 'utf8'), original);
  assert.ok(!fs.readFileSync(cfg, 'utf8').includes('"servers"'));
});

test('status sees a V2-only entry, and calls out a shape that points at another folder', () => {
  const dir = tmp(), cfg = path.join(dir, 'opencode.json'), ag = path.join(dir, 'AGENTS.md'), sk = path.join(dir, 'skills', 'videohub', 'SKILL.md'), rule = path.join(dir, 'rule.md');
  const hub = '/opt/videohub', status = () => run(['status', '--config', cfg, '--file', ag, '--skill', sk, '--videohub-dir', hub, '--skip-cli']);
  fs.writeFileSync(rule, 'rule text'); fs.mkdirSync(path.dirname(sk), { recursive: true }); fs.writeFileSync(sk, 'skill');
  run(['rule-add', '--file', ag, '--rule', rule, '--videohub-dir', hub]);
  run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(['/usr/bin/node', hub + '/server/mcp.js']), '--schema', 'v2']);
  let s = status();
  assert.equal(s.mcp.found, true); assert.equal(s.mcp.v1.found, false); assert.equal(s.mcp.v2.found, true);
  assert.equal(s.mcp.shape, 'mcp.servers.videohub'); assert.equal(s.ready, true);
  // the 1.x shape left behind by another copy is stale: status must not call that ready
  fs.writeFileSync(cfg, JSON.stringify({ mcp: {
    videohub: { type: 'local', command: ['/usr/bin/node', '/elsewhere/server/mcp.js'], enabled: true },
    servers: { videohub: { type: 'local', command: ['/usr/bin/node', hub + '/server/mcp.js'] } },
  } }));
  s = status();
  assert.equal(s.mcp.pointsHere, false); assert.equal(s.ready, false);
  assert.match(s.action, /mcp\.videohub.*instead of \/opt\/videohub/);
  // a V2 entry switched off
  fs.writeFileSync(cfg, JSON.stringify({ mcp: { servers: { videohub: { type: 'local', command: ['/usr/bin/node', hub + '/server/mcp.js'], disabled: true } } } }));
  s = status();
  assert.equal(s.mcp.found, true); assert.equal(s.ready, false); assert.match(s.action, /switched off/);
});

test('status says which shape the opencode on this machine reads', () => {
  const dir = tmp(), cfg = path.join(dir, 'opencode.json'), ag = path.join(dir, 'AGENTS.md'), sk = path.join(dir, 'skills', 'videohub', 'SKILL.md');
  const hub = '/opt/videohub';
  fs.mkdirSync(path.dirname(sk), { recursive: true }); fs.writeFileSync(sk, 'skill');
  run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(['/usr/bin/node', hub + '/server/mcp.js'])]);
  const fake = path.join(dir, 'opencode');
  const status = () => run(['status', '--config', cfg, '--file', ag, '--skill', sk, '--videohub-dir', hub]);
  fs.writeFileSync(fake, '#!/bin/sh\necho 1.19.5\n'); fs.chmodSync(fake, 0o755);
  const saved = process.env.OPENCODE_BIN;
  try {
    process.env.OPENCODE_BIN = fake;
    let s = status();
    assert.equal(s.cli.version, '1.19.5'); assert.equal(s.mcp.cliShape, 'mcp.videohub');
    fs.writeFileSync(fake, '#!/bin/sh\necho 2.0.0\n'); fs.chmodSync(fake, 0o755);
    s = status();
    assert.equal(s.cli.version, '2.0.0'); assert.equal(s.mcp.cliShape, 'mcp.servers.videohub');
    process.env.OPENCODE_BIN = path.join(dir, 'not-there');
    s = status();
    assert.equal(s.cli.found, false); assert.equal(s.mcp.cliShape, null);
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_BIN; else process.env.OPENCODE_BIN = saved;
  }
});

test('the opencode version is read off the number, whatever the banner looks like', () => {
  const dir = tmp(), fake = path.join(dir, 'opencode');
  const withBin = text => {
    fs.writeFileSync(fake, '#!/bin/sh\n' + text); fs.chmodSync(fake, 0o755);
    return opencodeVersion(fake);
  };
  assert.deepEqual(withBin('echo 1.19.5\n'), { version: '1.19.5', major: 1 });
  assert.deepEqual(withBin('echo "opencode v2.2.6"\n'), { version: 'opencode v2.2.6', major: 2 });   // the real V2 banner
  assert.equal(withBin('echo "not a version"\n').major, null);
  assert.equal(opencodeVersion(path.join(dir, 'not-there')), null);
});

test('status asks the installed client what it thinks, and the V2 banner is not misread as 1.x', () => {
  const dir = tmp(), cfg = path.join(dir, 'opencode.json'), ag = path.join(dir, 'AGENTS.md'), sk = path.join(dir, 'skills', 'videohub', 'SKILL.md');
  const hub = '/opt/videohub', fake = path.join(dir, 'opencode');
  fs.mkdirSync(path.dirname(sk), { recursive: true }); fs.writeFileSync(sk, 'skill');
  run(['mcp-add', '--config', cfg, '--command-json', JSON.stringify(['/usr/bin/node', hub + '/server/mcp.js'])]);
  const rule = path.join(dir, 'rule.md'); fs.writeFileSync(rule, 'rule text');
  run(['rule-add', '--file', ag, '--rule', rule, '--videohub-dir', hub]);
  const stub = body => { fs.writeFileSync(fake, '#!/bin/sh\n' + body); fs.chmodSync(fake, 0o755); };
  const status = () => run(['status', '--config', cfg, '--file', ag, '--skill', sk, '--videohub-dir', hub]);
  const saved = process.env.OPENCODE_BIN;
  try {
    process.env.OPENCODE_BIN = fake;
    // opencode v2.2.6: version banner with a leading "opencode v", mcp list drawing a box with the server line in it
    stub('case "$1" in --version) echo "opencode v2.2.6";; mcp) printf "\\033[0m\\n┌  MCP Servers\\n│\\n●  ✓ videohub  connected\\n│      /usr/bin/node /opt/videohub/server/mcp.js\\n│\\n└  1 server(s)\\n";; esac\n');
    let s = status();
    assert.equal(s.cli.version, 'opencode v2.2.6'); assert.equal(s.cli.major, 2);
    assert.equal(s.mcp.cliShape, 'mcp.servers.videohub');   // not "mcp.videohub", which the old parse said
    assert.equal(s.mcp.probe.ran, true); assert.equal(s.mcp.probe.connected, true);
    assert.match(s.mcp.probe.detail, /videohub connected/);
    assert.equal(s.warn, null);
    // the client says the server failed -> still no hard error, but the warning names it
    stub('case "$1" in --version) echo "opencode v2.2.6";; mcp) printf "●  ✗ videohub failed\\n   MCP error -32000: Connection closed\\n";; esac\n');
    s = status();
    assert.equal(s.mcp.probe.connected, false); assert.match(s.warn, /does not show "videohub" as connected/);
    assert.equal(s.ready, true);   // the config is fine; the warning is the client's own report
    // no videohub line at all
    stub('case "$1" in --version) echo "opencode v2.2.6";; mcp) echo "No MCP servers configured";; esac\n');
    s = status();
    assert.equal(s.mcp.probe.connected, false); assert.match(s.mcp.probe.detail, /no MCP servers configured/);
    // a client that cannot be run at all
    process.env.OPENCODE_BIN = path.join(dir, 'not-there');
    s = status();
    assert.equal(s.cli.found, false); assert.equal(s.mcp.probe.ran, false); assert.equal(s.warn, null);
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_BIN; else process.env.OPENCODE_BIN = saved;
  }
});

test('the desktop app is recognised by its launcher, wherever the package put it', () => {
  const home = tmp(), env = { HOME: home };
  assert.equal(desktopFound(env), null);
  fs.mkdirSync(path.join(home, '.local', 'share', 'applications'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'share', 'applications', 'opencode-desktop.desktop'), '[Desktop Entry]');
  assert.match(desktopFound(env), /opencode-desktop\.desktop$/);
  const home2 = tmp(), env2 = { HOME: home2 };
  fs.mkdirSync(path.join(home2, 'Applications'), { recursive: true });
  fs.writeFileSync(path.join(home2, 'Applications', 'opencode-1.2.3.AppImage'), '');
  assert.match(desktopFound(env2), /opencode-1\.2\.3\.AppImage$/);
  const home3 = tmp(), env3 = { HOME: home3 };
  assert.match(desktopFound(env3, p => p === '/usr/bin/opencode-desktop', () => []), /\/usr\/bin\/opencode-desktop$/);
});

test('an unknown mode fails loudly', () => {
  assert.throws(() => run(['nonsense']), /unknown mode/);
  assert.throws(() => run(['mcp-add', '--command-json', '[]']), /non-empty/);
});
