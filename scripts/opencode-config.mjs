// Setup's helper for opencode (https://opencode.ai): it adds/removes VideoHub's MCP server in opencode's global config
// (~/.config/opencode/opencode.json or opencode.jsonc) and the review rule block in ~/.config/opencode/AGENTS.md.
//
// The edits are text splices, not a re-serialisation: everything else in the file (other servers, models, permissions,
// comments, formatting) stays exactly as the user wrote it. A file that cannot be read as JSON/JSONC is never rewritten.
//
//   node scripts/opencode-config.mjs mcp-add     [--config <file>] [--name videohub] --command-json '["node","<mcp.js>"]' [--dry-run]
//   node scripts/opencode-config.mjs mcp-remove  [--config <file>] [--name videohub] [--expect <text>] [--dry-run]
//   node scripts/opencode-config.mjs rule-add    [--file <AGENTS.md>] --rule <file> --videohub-dir <dir> [--dry-run]
//   node scripts/opencode-config.mjs rule-remove [--file <AGENTS.md>] [--expect <text>] [--dry-run]
//   --config / --file default to the global opencode config; --dry-run prints the plan and writes nothing.
// Every mode prints one JSON line: {ok, changed, path, action} (or {ok:false, error}).
import fs from 'node:fs';
import os from 'node:os';
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

// put `entry` under mcp[name], keeping every other byte of the file
export function upsertMcpEntry(text, name, entry) {
  const sig = significant(text);
  if (!sig.length) {   // an empty file: write a fresh config
    return { text: `{\n  "$schema": "${SCHEMA}",\n  "mcp": {\n    "${name}": ${pretty(entry, '    ')}\n  }\n}\n`, changed: true };
  }
  if (sig[0].t !== '{') throw new Error('the config does not start with a JSON object');
  const rootClose = closing(sig, 0);
  if (rootClose < 0) throw new Error('the config has an unclosed { — fix it by hand, VideoHub did not touch it');
  const mcp = propertyValue(sig, 0, 'mcp');
  if (!mcp) {   // no "mcp" key yet: add it as the first property of the root object
    const indent = (indentOf(text, sig[rootClose].s) || '') + '  ';
    const body = `\n${indent}"mcp": {\n${indent}  "${name}": ${pretty(entry, indent + '  ')}\n${indent}}`;
    return { text: text.slice(0, sig[0].e) + body + (text.slice(sig[0].e).trim() ? ',' : '') + text.slice(sig[0].e), changed: true };
  }
  if (sig[mcp.value].t !== '{') throw new Error('"mcp" in the config is not an object — fix it by hand, VideoHub did not touch it');
  const mcpClose = closing(sig, mcp.value);
  if (mcpClose < 0) throw new Error('the "mcp" object is not closed — fix it by hand, VideoHub did not touch it');
  const existing = propertyValue(sig, mcp.value, name);
  if (existing) {
    if (sig[existing.value].t !== '{') throw new Error(`"mcp.${name}" in the config is not an object — fix it by hand`);
    const valueClose = closing(sig, existing.value);
    if (valueClose < 0) throw new Error(`"mcp.${name}" is not closed — fix it by hand`);
    let same = false;
    try { same = JSON.stringify(parseJsonc(text).mcp[name]) === JSON.stringify(entry); } catch { same = false; }
    if (same) return { text, changed: false };   // already exactly this server: touch nothing
    const newText = `"${name}": ${pretty(entry, indentOf(text, sig[existing.key].s))}`;
    return { text: text.slice(0, sig[existing.key].s) + newText + text.slice(sig[valueClose].e), changed: true };
  }
  // append the property just after the last thing in the mcp object, so the comma never lands on a line of its own
  const prev = sig[mcpClose - 1], closeTok = sig[mcpClose];
  const empty = prev.t === '{' && prev.s === sig[mcp.value].s;
  const trailingComma = prev.t === ',';
  const closeIndent = indentOf(text, closeTok.s), indent = closeIndent + '  ';
  const ownLine = text.slice(prev.e, closeTok.s).includes('\n');
  const addition = (empty || trailingComma ? '' : ',') + `\n${indent}"${name}": ${pretty(entry, indent)}` + (ownLine ? '' : `\n${closeIndent}`);
  return { text: text.slice(0, prev.e) + addition + text.slice(prev.e), changed: true };
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

// take mcp[name] out again; the mcp block itself goes when it is left empty (so uninstall gives back the original file)
export function removeMcpEntry(text, name) {
  const sig = significant(text);
  if (!sig.length || sig[0].t !== '{') return { text, changed: false };
  const mcp = propertyValue(sig, 0, 'mcp');
  if (!mcp || sig[mcp.value].t !== '{') return { text, changed: false };
  const first = dropProperty(text, name, mcp.value);
  if (!first.changed) return first.text === text ? { text, changed: false } : first;
  let out = first.text;
  try {
    const j = parseJsonc(out);
    if (j.mcp && typeof j.mcp === 'object' && Object.keys(j.mcp).length === 0) out = dropProperty(out, 'mcp', 0).text || out;
  } catch { /* leave it: an unreadable file is never rewritten further */ }
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
export function run(argv) {
  const args = {}; const mode = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error('unexpected argument: ' + a);
    const k = a.slice(2);
    if (k === 'dry-run') args[k] = true;
    else { if (i + 1 >= argv.length) throw new Error(a + ' needs a value'); args[k] = argv[++i]; }
  }
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  const name = args.name || SERVER;
  const done = (file, changed, action, extra = {}) => ({ ok: true, changed, path: file, action, ...extra });

  if (mode === 'mcp-add' || mode === 'mcp-remove') {
    const file = args.config || configPath();
    const before = read(file);
    if (mode === 'mcp-add') {
      let command; try { command = JSON.parse(args['command-json'] || '[]'); } catch { throw new Error('--command-json must be a JSON array'); }
      if (!Array.isArray(command) || !command.length) throw new Error('--command-json must be a non-empty JSON array');
      let out;
      try { out = upsertMcpEntry(before, name, { type: 'local', command, enabled: true }); }
      catch (e) { throw new Error(file + ': ' + e.message); }
      try { parseJsonc(out.text); } catch (e) { throw new Error('the edit would have left ' + file + ' unreadable (' + e.message + ') — nothing was written'); }
      if (!out.changed) return done(file, false, `mcp server "${name}" is already there`);
      if (!args['dry-run']) write(file, out.text);
      return done(file, true, (before ? 'added' : 'created') + ` mcp server "${name}"`);
    }
    if (args.expect && !before.includes(args.expect)) return done(file, false, 'left alone (not this install)');
    const out = removeMcpEntry(before, name);
    if (!out.changed) return done(file, false, `no mcp server "${name}" in it`);
    try { parseJsonc(out.text); } catch (e) { throw new Error('the edit would have left ' + file + ' unreadable (' + e.message + ') — nothing was written'); }
    if (!args['dry-run']) write(file, out.text);
    return done(file, true, `removed mcp server "${name}"`);
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

  throw new Error('unknown mode: ' + (mode || '(none)') + ' (mcp-add, mcp-remove, rule-add, rule-remove)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2))));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exitCode = 1;
  }
}
