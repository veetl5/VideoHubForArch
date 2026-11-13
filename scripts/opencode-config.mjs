// Setup's helper for opencode (https://opencode.ai): it adds/removes VideoHub's MCP server in opencode's global config
// (~/.config/opencode/opencode.json or opencode.jsonc) and the review rule block in ~/.config/opencode/AGENTS.md.
//
// The edits are text splices, not a re-serialisation: everything else in the file (other servers, models, permissions,
// comments, formatting) stays exactly as the user wrote it. A file that cannot be read as JSON/JSONC is never rewritten.
//
//   node scripts/opencode-config.mjs mcp-add     [--config <file>] [--name videohub] --command-json '["node","<mcp.js>"]'
//                                                [--schema both|v1|v2] [--dry-run]
//   node scripts/opencode-config.mjs mcp-remove  [--config <file>] [--name videohub] [--schema both|v1|v2] [--expect <text>] [--dry-run]
//   node scripts/opencode-config.mjs rule-add    [--file <AGENTS.md>] --rule <file> --videohub-dir <dir> [--dry-run]
//   node scripts/opencode-config.mjs rule-remove [--file <AGENTS.md>] [--expect <text>] [--dry-run]
//   node scripts/opencode-config.mjs status      [--config <file>] [--file <AGENTS.md>] [--skill <dir>] [--videohub-dir <dir>]
//                                                [--skip-cli to not ask the opencode on PATH for its version]
//   --config / --file default to the global opencode config; --dry-run prints the plan and writes nothing; status writes
//   nothing either: it says whether the three pieces are in place for this install.
// Every mode prints one JSON line: {ok, changed, path, action} (or {ok:false, error}).
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- videohub:begin (added by VideoHub setup; remove with uninstall.sh) -->';
export const END = '<!-- videohub:end -->';
export const SERVER = 'videohub';
const SCHEMA = 'https://opencode.ai/config.json';

// ---- where opencode keeps its settings -------------------------------------------------------------------------
export function opencodeHome(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'opencode');
}
export function configPath(env = process.env) {
  const home = opencodeHome(env);
  const json = path.join(home, 'opencode.json'), jsonc = path.join(home, 'opencode.jsonc');
  if (fs.existsSync(json)) return json;
  if (fs.existsSync(jsonc)) return jsonc;   // newer opencode installs write .jsonc; keep their file
  return json;
}
export const agentsPath = (env = process.env) => path.join(opencodeHome(env), 'AGENTS.md');

// ---- JSONC, without dependencies --------------------------------------------------------------------------------
// tokens: strings, the structural characters, and comments (kept so a splice can respect them)
export function tokens(text) {
  const out = []; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length) { if (text[j] === '\\') j += 2; else if (text[j] === '"') { j++; break; } else j++; }
      out.push({ t: 'str', s: i, e: j, v: text.slice(i + 1, j - 1) }); i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      let j = text.indexOf('\n', i); if (j < 0) j = text.length;
      out.push({ t: 'comment', s: i, e: j }); i = j;
    } else if (c === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2); j = j < 0 ? text.length : j + 2;
      out.push({ t: 'comment', s: i, e: j }); i = j;
    } else if ('{}[],:'.includes(c)) {
      out.push({ t: c, s: i, e: i + 1 }); i++;
    } else {   // whitespace, numbers, true/false/null: kept verbatim so parseJsonc sees the whole document
      let j = i;
      while (j < text.length && !'"{}[],:/'.includes(text[j])) j++;
      if (j === i) j++;   // a lone '/' that does not open a comment
      out.push({ t: 'raw', s: i, e: j }); i = j;
    }
  }
  return out;
}
// the structural view: no comments, no whitespace, but numbers and true/false/null kept (they can be a value)
const significant = text => tokens(text).filter(k => k.t !== 'comment' && !(k.t === 'raw' && /^\s*$/.test(text.slice(k.s, k.e))));

// drop // and /* */ comments and trailing commas (string-aware), then JSON.parse
export function parseJsonc(text) {
  let out = '';
  for (const k of tokens(text)) out += k.t === 'comment' ? ' ' : text.slice(k.s, k.e);
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// the significant token that closes the object opened by sig[index] ('{' or '[')
function closing(sig, index) {
  const open = sig[index].t, close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = index; i < sig.length; i++) {
    if (sig[i].t === open) depth++;
    else if (sig[i].t === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
// the value object of the property `key` directly inside the object opened by sig[index]
function propertyValue(sig, index, key) {
  const close = closing(sig, index);
  if (close < 0) return null;
  let depth = 0;
  for (let i = index; i <= close; i++) {
    const k = sig[i];
    if (k.t === '{' || k.t === '[') depth++;
    else if (k.t === '}' || k.t === ']') depth--;
    else if (depth === 1 && k.t === 'str' && k.v === key && sig[i + 1] && sig[i + 1].t === ':' && sig[i + 2]) {
      return { key: i, colon: i + 1, value: i + 2 };
    }
  }
  return null;
}
// indentation that a property added to the object at open/close should use
function indentOf(text, closeStart) {
  const lineStart = text.lastIndexOf('\n', closeStart) + 1;
  const before = text.slice(lineStart, closeStart);
  return /^\s*$/.test(before) ? before : '';
}
const pretty = (value, indent) => JSON.stringify(value, null, 2).split('\n').map((l, i) => (i ? indent + l : l)).join('\n');

// opencode changed where servers live: 1.x reads mcp.<name>, the current (V2) config wants mcp.servers.<name> and uses
// "disabled" instead of "enabled". Setup writes both shapes (the 1.x CLI ignores the extra "servers" key), so one config
// serves the terminal and the desktop app; --schema narrows it when a client is strict.
export const MCP_PATH = { v1: ['mcp'], v2: ['mcp', 'servers'] };
const label = keys => keys.join('.');

// indentation for properties added inside the object at sig[container]; works when that object is still written
// inline (`"servers": {}`), where its closing brace shares the line with its opening one
function objectIndent(text, sig, container) {
  const closeIdx = closing(sig, container);
  if (closeIdx < 0) throw new Error('the config has an unclosed { — fix it by hand, VideoHub did not touch it');
  const closeStart = sig[closeIdx].s;
  const lineStart = text.lastIndexOf('\n', closeStart) + 1;
  const before = text.slice(lineStart, closeStart);
  if (/^[ \t]*$/.test(before)) return before;   // closing brace on its own line: that indentation is the answer
  const openLineStart = text.lastIndexOf('\n', sig[container].s) + 1;
  return /^[ \t]*/.exec(text.slice(openLineStart))[0];   // inline object: its properties go one level past that line
}

// insert `"key": value` as the last property of the object opened by sig[container]
function appendProperty(text, sig, container, key, value) {
  const closeIdx = closing(sig, container);
  if (closeIdx < 0) throw new Error('the config has an unclosed { — fix it by hand, VideoHub did not touch it');
  const prev = sig[closeIdx - 1];
  const closeTok = sig[closeIdx];
  const empty = prev.t === '{' && prev.s === sig[container].s;
  const trailingComma = prev.t === ',';
  const closeIndent = objectIndent(text, sig, container), indent = closeIndent + '  ';
  const ownLine = text.slice(prev.e, closeTok.s).includes('\n');
  // the comma goes right after the last token, never on a line of its own
  const addition = (empty || trailingComma ? '' : ',') + `\n${indent}"${key}": ${pretty(value, indent)}` + (ownLine ? '' : `\n${closeIndent}`);
  return { text: text.slice(0, prev.e) + addition + text.slice(prev.e), changed: true };
}

// the object at keys[0].keys[1]…, or null when it is not there
function objectAt(text, keys) {
  const sig = significant(text);
  if (!sig.length || sig[0].t !== '{') return null;
  let container = 0;
  for (const k of keys) {
    const prop = propertyValue(sig, container, k);
    if (!prop || sig[prop.value].t !== '{') return null;
    container = prop.value;
  }
  return { sig, container };
}

// the same, creating the missing objects (`"mcp": {}` as the first property of the root, `"servers": {}` inside it)
function ensureObject(text, keys) {
  const found = objectAt(text, keys);
  if (found) return { ...found, text };
  const sig = significant(text);
  if (!sig.length) return { text: '{}', sig: significant('{}'), container: 0 };
  if (sig[0].t !== '{') throw new Error('the config does not start with a JSON object — fix it by hand, VideoHub did not touch it');
  for (let n = 1; n <= keys.length; n++) {
    const path = keys.slice(0, n);
    if (objectAt(text, path)) continue;
    const parent = objectAt(text, path.slice(0, -1)) || { sig, container: 0 };
    const made = appendProperty(text, parent.sig, parent.container, path.at(-1), {});
    return ensureObject(made.text, keys);
  }
  throw new Error('could not find ' + label(keys) + ' in the config');
}

const atPath = (obj, keys) => keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

// put `entry` under mcp[name] (schema v1) or mcp.servers[name] (schema v2), keeping every other byte of the file
export function upsertMcpEntry(text, name, entry, schema = 'v1') {
  const keys = MCP_PATH[schema];
  if (!keys) throw new Error('unknown schema: ' + schema);
  if (!text.trim()) {   // an empty file: start from a config that only names the schema, then add the block normally
    const out = upsertMcpEntry(`{\n  "$schema": "${SCHEMA}"\n}\n`, name, entry, schema);
    return { text: out.text, changed: true };
  }
  const ensured = ensureObject(text, keys);
  let current = ensured.text;
  const sig = ensured.sig, container = ensured.container;
  const existing = propertyValue(sig, container, name);
  if (existing) {
    if (sig[existing.value].t !== '{') throw new Error(`"${label(keys)}.${name}" in the config is not an object — fix it by hand`);
    const valueClose = closing(sig, existing.value);
    if (valueClose < 0) throw new Error(`"${label(keys)}.${name}" is not closed — fix it by hand`);
    let same = false;
    try { same = JSON.stringify(atPath(parseJsonc(current), [...keys, name])) === JSON.stringify(entry); } catch { same = false; }
    if (same) return { text: current, changed: false };   // already exactly this server: touch nothing
    const newText = `"${name}": ${pretty(entry, indentOf(current, sig[existing.key].s))}`;
    return { text: current.slice(0, sig[existing.key].s) + newText + current.slice(sig[valueClose].e), changed: true };
  }
  return appendProperty(current, sig, container, name, entry);
}

// remove the property `key` from the object opened by sig[container] (with the comma that held it and, when it had
// one, its line), keeping every other byte
function dropProperty(text, key, container) {
  const sig = significant(text);
  const prop = propertyValue(sig, container, key);
  if (!prop || sig[prop.value].t !== '{') return { text, changed: false };
  const valueClose = closing(sig, prop.value);
  if (valueClose < 0) return { text, changed: false };
  const keyStart = sig[prop.key].s;
  const lineStart = text.lastIndexOf('\n', keyStart) + 1;
  const ownLine = /^[ \t]*$/.test(text.slice(lineStart, keyStart));   // nothing but indentation before it
  let start = ownLine ? lineStart : keyStart, end = sig[valueClose].e, i = end;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  if (text[i] === ',') {   // a comma after the property goes with it
    end = i + 1; i++;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  } else {                 // otherwise the one before it does
    let j = start - 1;
    while (j >= 0 && (ownLine ? /\s/.test(text[j]) : /[ \t]/.test(text[j]))) j--;
    if (text[j] === ',') start = j;
  }
  // when the whole line goes (its own comma was taken), the line break goes too; when only the property and the comma
  // before it go, the line break stays so the closing brace keeps its own line
  if (start === lineStart && text[i] === '\n') end = i + 1;
  return { text: text.slice(0, start) + text.slice(end), changed: true };
}

// take the server out of one shape; blocks left empty ("servers", "mcp") go too, so uninstall gives the file back
export function removeMcpEntry(text, name, schema = 'v1') {
  const keys = MCP_PATH[schema];
  if (!keys) throw new Error('unknown schema: ' + schema);
  const found = objectAt(text, keys);
  if (!found) return { text, changed: false };
  const first = dropProperty(text, name, found.container);
  if (!first.changed) return { text, changed: false };
  let out = first.text;
  for (let n = keys.length; n >= 1; n--) {   // innermost first: "servers", then "mcp"
    const path = keys.slice(0, n);
    let parsed; try { parsed = parseJsonc(out); } catch { break; }
    const obj = atPath(parsed, path);
    if (!obj || typeof obj !== 'object' || Object.keys(obj).length) continue;
    const parent = objectAt(out, path.slice(0, -1));
    if (parent) out = dropProperty(out, path.at(-1), parent.container).text || out;
  }
  return { text: out, changed: true };
}

// ---- the review rule, between marker lines ----------------------------------------------------------------
export function applyRuleBlock(text, block, begin = BEGIN, end = END) {
  const a = text.indexOf(begin), b = text.indexOf(end);
  if (a >= 0 && b > a) return text.slice(0, a) + block + text.slice(b + end.length);
  return (text.trim() ? text.trimEnd() + '\n\n' : '') + block + '\n';
}
export function dropRuleBlock(text, begin = BEGIN, end = END) {
  const a = text.indexOf(begin), b = text.indexOf(end);
  if (!(a >= 0 && b > a)) return text;
  return (text.slice(0, a).trimEnd() + '\n\n' + text.slice(b + end.length).trimStart()).trim() + '\n';
}

// ---- the command line setup.sh / uninstall.sh use ---------------------------------------------------------
// ---- the desktop app: it reads the very same ~/.config/opencode, but a GUI launch has no shell PATH, so the server's
// command must be absolute (setup writes the absolute node path) and running servers only pick up changes at restart
export function desktopFound(env = process.env, exists = fs.existsSync, readdir = fs.readdirSync) {
  const home = env.HOME || os.homedir();
  const data = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const known = [
    path.join(data, 'applications', 'opencode-desktop.desktop'),
    path.join(home, '.local', 'share', 'applications', 'opencode-desktop.desktop'),
    '/usr/share/applications/opencode-desktop.desktop',
    '/usr/local/share/applications/opencode-desktop.desktop',
    path.join(home, '.local', 'bin', 'opencode-desktop'),
    '/usr/bin/opencode-desktop', '/usr/local/bin/opencode-desktop', '/opt/opencode-desktop/opencode-desktop',
  ];
  const loose = [];
  for (const dir of [path.join(home, 'Applications'), path.join(home, 'Downloads'), '/opt']) {
    try { for (const f of readdir(dir)) if (/^opencode.*\.appimage$/i.test(f)) loose.push(path.join(dir, f)); } catch { /* no such folder */ }
  }
  return [...known, ...loose].find(p => exists(p)) || null;
}

const stripAnsi = s => String(s).replace(/\u001b\[[0-9;]*m/g, '');

// which opencode this machine runs, so status can name the config shape it reads (1.x: mcp.<name>, V2: mcp.servers.<name>).
// `opencode --version` prints things like "1.19.5" and "opencode v2.2.6", so the major is read off the number, not the text.
export function opencodeVersion(bin = process.env.OPENCODE_BIN || 'opencode') {
  try {
    const out = execFileSync(bin, ['--version'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = stripAnsi(String(out)).trim().split('\n').filter(l => l.trim()).pop() || '';
    const m = (/(\d+)\.(\d+)(?:\.(\d+))?/.exec(line));
    return line ? { version: line.trim(), major: m ? Number(m[1]) : null } : null;
  } catch { return null; }
}

// what the installed client itself says about the server: `opencode mcp list` starts the server the same way the app does,
// so this is the end-to-end answer ("videohub connected" / "failed"), whichever config shape that client reads
export function probeMcp(name = SERVER, bin = process.env.OPENCODE_BIN || 'opencode', timeout = 30000) {
  let out = '';
  try {
    out = execFileSync(bin, ['mcp', 'list'], { timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (!out.trim()) return { ran: false, connected: false, detail: String((e && e.message) || e) };
  }
  const lines = stripAnsi(out).split('\n').map(l => l.replace(/[│└┌●]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const line = lines.find(l => l.includes(name)) || '';
  const bad = /✗|failed|error/i.test(line);
  const connected = !!line && !bad && /✓|connected|ready/i.test(line);
  const empty = lines.some(l => /no mcp servers/i.test(l));
  return { ran: true, connected, detail: line || (empty ? 'no MCP servers configured' : (lines[0] || '')) };
}

export function run(argv) {
  const args = {}; const mode = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error('unexpected argument: ' + a);
    const k = a.slice(2);
    if (k === 'dry-run' || k === 'skip-cli') args[k] = true;
    else { if (i + 1 >= argv.length) throw new Error(a + ' needs a value'); args[k] = argv[++i]; }
  }
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  const name = args.name || SERVER;
  const done = (file, changed, action, extra = {}) => ({ ok: true, changed, path: file, action, ...extra });

  if (mode === 'mcp-add' || mode === 'mcp-remove') {
    const file = args.config || configPath();
    const before = read(file);
    const schema = args.schema || 'both';
    if (schema !== 'both' && !MCP_PATH[schema]) throw new Error('--schema must be both, v1 or v2');
    const shapes = schema === 'both' ? ['v1', 'v2'] : [schema];
    const where = shapes.map(sh => label([...MCP_PATH[sh], name])).join(' and ');
    if (mode === 'mcp-add') {
      let command; try { command = JSON.parse(args['command-json'] || '[]'); } catch { throw new Error('--command-json must be a JSON array'); }
      if (!Array.isArray(command) || !command.length) throw new Error('--command-json must be a non-empty JSON array');
      // 1.x: mcp.<name> with "enabled"; V2 (current docs, desktop app): mcp.servers.<name>, where "disabled" replaces it
      const entries = { v1: { type: 'local', command, enabled: true }, v2: { type: 'local', command } };
      let text = before, changed = false;
      try {
        for (const sh of shapes) { const out = upsertMcpEntry(text, name, entries[sh], sh); text = out.text; changed = changed || out.changed; }
      } catch (e) { throw new Error(file + ': ' + e.message); }
      try { parseJsonc(text); } catch (e) { throw new Error('the edit would have left ' + file + ' unreadable (' + e.message + ') — nothing was written'); }
      if (!changed) return done(file, false, `mcp server "${name}" is already there (${where})`);
      if (!args['dry-run']) write(file, text);
      return done(file, true, (before ? 'added' : 'created') + ` mcp server "${name}" (${where})`, { schema });
    }
    if (args.expect && !before.includes(args.expect)) return done(file, false, 'left alone (not this install)');
    let text = before, changed = false;
    for (const sh of shapes) { const out = removeMcpEntry(text, name, sh); text = out.text; changed = changed || out.changed; }
    if (!changed) return done(file, false, `no mcp server "${name}" in it`);
    try { parseJsonc(text); } catch (e) { throw new Error('the edit would have left ' + file + ' unreadable (' + e.message + ') — nothing was written'); }
    if (!args['dry-run']) write(file, text);
    return done(file, true, `removed mcp server "${name}" (${where})`);
  }

  if (mode === 'rule-add' || mode === 'rule-remove') {
    const file = args.file || agentsPath();
    const before = read(file);
    if (mode === 'rule-add') {
      if (!args.rule || !args['videohub-dir']) throw new Error('rule-add needs --rule <file> and --videohub-dir <dir>');
      const bind = s => s.split('{{VIDEOHUB_DIR}}').join(args['videohub-dir']);
      const block = BEGIN + '\n' + bind(read(args.rule)) + '\n' + END;
      const out = applyRuleBlock(before, block);
      if (out === before) return done(file, false, 'the rule is already there');
      if (!args['dry-run']) write(file, out);
      return done(file, true, (before ? 'updated' : 'added') + ' the rule', { block });
    }
    if (args.expect && !before.includes(args.expect)) return done(file, false, 'left alone (not this install)');
    const out = dropRuleBlock(before);
    if (out === before) return done(file, false, 'no VideoHub rule in it');
    if (!args['dry-run']) write(file, out);
    return done(file, true, 'removed the rule');
  }

  if (mode === 'status') {   // read-only: is the server, the rule and the skill in place for THIS install?
    const hub = args['videohub-dir'] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const cfg = args.config || configPath(), ag = args.file || agentsPath();
    const skill = args.skill || path.join(opencodeHome(), 'skills', name, 'SKILL.md');
    const cfgText = read(cfg), agText = read(ag);
    let parsed = null, parseError = null;
    try { if (cfgText) parsed = parseJsonc(cfgText); } catch (e) { parseError = e.message; }
    const hubKey = hub.split('\\').join('/');
    const shapeOf = sh => {
      const entry = parsed ? atPath(parsed, [...MCP_PATH[sh], name]) : undefined;
      const local = !!entry && entry.type === 'local';
      const command = local && Array.isArray(entry.command) ? entry.command : null;
      return {
        where: label([...MCP_PATH[sh], name]),
        found: local,
        command,
        pointsHere: !!command && command.some(c => String(c).split('\\').join('/').startsWith(hubKey)),
        enabled: local && (sh === 'v1' ? entry.enabled !== false : entry.disabled !== true),
      };
    };
    const desktop = desktopFound();
    const cli = args['skip-cli'] ? null : opencodeVersion();
    const probe = args['skip-cli'] ? null : probeMcp(name);
    const v2isCurrent = !!cli && cli.major !== null && cli.major >= 2;
    const cliShape = v2isCurrent ? 'mcp.servers.' + name : cli ? 'mcp.' + name : null;
    const v1 = shapeOf('v1'), v2 = shapeOf('v2');
    const present = [v1, v2].filter(x => x.found);
    const stale = present.filter(x => !x.pointsHere);   // an entry left over from another folder or another install
    const found = present.length > 0;
    const pointsHere = found && stale.length === 0;
    // the entry the installed client would actually run: the shape it reads, else whatever is there
    const order = cliShape === v2.where ? [v2, v1] : [v1, v2];
    const active = order.find(x => x.pointsHere) || order.find(x => x.found) || null;
    const off = present.filter(x => !x.enabled);                             // "enabled": false / "disabled": true
    const enabled = found && off.length === 0;
    const rule = agText.includes(BEGIN);
    const skillOk = fs.existsSync(skill);
    const ready = pointsHere && enabled && rule && skillOk;
    return {
      ok: true, ready, hub,
      mcp: {
        path: cfg, error: parseError, found, command: active ? active.command : null, pointsHere, enabled,
        shape: active ? active.where : null,
        v1: { ...v1, where: 'mcp.' + name }, v2: { ...v2, where: 'mcp.servers.' + name },
        // V2 (current docs, desktop) reads mcp.servers only; 1.x reads mcp.<name> only; setup writes both, so either
        // client finds the server — this says which one the opencode on PATH will read
        cliShape,
        probe: probe ? { ran: probe.ran, connected: probe.connected, detail: probe.detail } : null,
      },
      rule: { path: ag, found: rule },
      skill: { path: skill, found: skillOk },
      cli: { found: !!cli, version: cli ? cli.version : null, major: cli ? cli.major : null },
      desktop: { path: desktop, found: !!desktop },
      warn: probe && probe.ran && !probe.connected
        ? `opencode mcp list does not show "${name}" as connected yet: ${probe.detail || 'no server'} (restart the app / start a new session)`
        : null,
      action: ready ? 'opencode is set up for this install' + (desktop ? ' (restart the opencode app after a change)' : '')
        : !found ? `no "${name}" MCP server in ${cfg} (run ./setup.sh --opencode yes)`
        : stale.length ? `"${stale[0].where}" points at ${JSON.stringify(stale[0].command)} instead of ${hub} (run ./setup.sh --opencode yes)`
        : off.length ? `"${off[0].where}" is switched off in ${cfg} (set "enabled": true / remove "disabled")`
        : !rule ? `no VideoHub rule in ${ag} (run ./setup.sh --opencode yes)`
        : `no skill file at ${skill} (run ./setup.sh --opencode yes)`,
    };
  }

  throw new Error('unknown mode: ' + (mode || '(none)') + ' (mcp-add, mcp-remove, rule-add, rule-remove, status)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2))));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exitCode = 1;
  }
}
