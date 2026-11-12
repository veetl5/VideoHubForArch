// Everything that differs between Windows and Linux lives here, so the rest of the hub stays platform-neutral.
// Linux (Arch) implementations use only common desktop tools and degrade quietly when one is missing:
//   trash          gio trash → trash-put (trash-cli) → kioclient → own XDG trash (same drive only)
//   notifications  notify-send (libnotify)
//   file manager   FileManager1 over D-Bus (select the file) → xdg-open
//   folder picker  zenity → kdialog → yad
//   GPU names      lspci (pciutils)
//   process list   ps (procps-ng)
//   autostart      an XDG autostart entry (~/.config/autostart/videohub.desktop), no systemd needed
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const IS_WIN = process.platform === 'win32';
export const IS_LINUX = process.platform === 'linux';
const NO_WINDOW = () => !!process.env.VIDEOHUB_NO_WINDOW;

// ---------- small helpers
export function which(name, extra = []) {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(extra);
  for (const d of dirs) { const f = path.join(d, name); if (d && fs.existsSync(f)) return f; }
  return null;
}
export const has = name => !!which(name);
const sh = (cmd, args, opts = {}) => new Promise(resolve =>
  execFile(cmd, args, { maxBuffer: 16 << 20, timeout: 20000, ...opts }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })));

// XDG folders (Linux): ~/.config, ~/.local/share
export const CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
export const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
// the user's Desktop and Documents as the desktop environment knows them (xdg-user-dirs), else ~/Desktop, ~/Documents
export function userDir(name, fallback) {
  try {
    const t = fs.readFileSync(path.join(CONFIG_HOME, 'user-dirs.dirs'), 'utf8');
    const m = new RegExp('^XDG_' + name + '_DIR="([^"]+)"', 'm').exec(t);
    if (m) return m[1].replace(/^\$HOME/, os.homedir());
  } catch { }
  return path.join(os.homedir(), fallback);
}

// ---------- browsers for headless renders and the app window (Chromium family)
export const BROWSER_CANDIDATES = IS_WIN
  ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
  : ['chromium', 'google-chrome-stable', 'google-chrome', 'microsoft-edge-stable', 'brave', 'vivaldi-stable', 'thorium-browser', 'ungoogled-chromium'];
export function findBrowser() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  for (const c of BROWSER_CANDIDATES) {
    const f = path.isAbsolute(c) ? (fs.existsSync(c) ? c : null) : which(c);
    if (f) return f;
  }
  return null;
}

// ---------- trash (never a hard delete)
// resolves to 0 when the item went to the trash, else a short reason
const trashDir = () => path.join(DATA_HOME, 'Trash');
async function ownTrash(p) {
  // freedesktop.org trash spec: the home trash when the file is on the home drive, else <mount>/.Trash-<uid> on its own drive.
  // Never a copy and never a delete: if neither can be used the file stays where it is.
  const uid = process.getuid ? process.getuid() : 0;
  const tryIn = dir => {
    const files = path.join(dir, 'files'), info = path.join(dir, 'info');
    fs.mkdirSync(files, { recursive: true, mode: 0o700 }); fs.mkdirSync(info, { recursive: true, mode: 0o700 });
    let name = path.basename(p), n = 1;
    while (fs.existsSync(path.join(files, name))) name = `${path.basename(p)}.${n++}`;
    fs.renameSync(p, path.join(files, name));
    const enc = path.resolve(p).split('/').map(encodeURIComponent).join('/');
    fs.writeFileSync(path.join(info, name + '.trashinfo'), `[Trash Info]\nPath=${enc}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`);
  };
  try { tryIn(trashDir()); return 0; } catch (e) { if (e.code !== 'EXDEV') return String(e.message || e); }
  const r = await sh('df', ['--output=target', p]);
  const top = r.stdout.trim().split('\n').pop();
  if (!top) return 'Could not find this drive\'s mount point; left untouched to avoid permanent deletion.';
  try { tryIn(path.join(top, `.Trash-${uid}`)); return 0; } catch (e) { return `This drive has no usable trash folder (${e.code || e.message}); left untouched to avoid permanent deletion. Install glib2 (gio) or trash-cli.`; }
}
export async function trashPath(p) {
  if (!fs.existsSync(p)) return 'Not found.';
  if (has('gio')) { const r = await sh('gio', ['trash', '--', p]); if (r.code === 0) return 0; if (!fs.existsSync(p)) return 0; }
  if (has('trash-put')) { const r = await sh('trash-put', ['--', p]); if (r.code === 0) return 0; if (!fs.existsSync(p)) return 0; }
  if (has('kioclient')) { const r = await sh('kioclient', ['move', p, 'trash:/']); if (r.code === 0) return 0; if (!fs.existsSync(p)) return 0; }
  return ownTrash(p);
}

// ---------- notifications
export function notify(title, body) {
  if (NO_WINDOW() || !has('notify-send')) return;
  try { spawn('notify-send', ['-a', 'VideoHub', '-i', 'video-x-generic', String(title || '').slice(0, 200), String(body || '').slice(0, 300)], { stdio: 'ignore', detached: true }).unref(); } catch { }
}

// ---------- file manager / default application
// select=true with a file: show it selected in the file manager when the desktop supports that, else open its folder.
export async function showInFolder(target, select = false) {
  if (NO_WINDOW()) return;
  if (select && has('dbus-send')) {
    const r = await sh('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.FileManager1', '--type=method_call', '/org/freedesktop/FileManager1',
      'org.freedesktop.FileManager1.ShowItems', 'array:string:' + pathToFileURL(target).href, 'string:'], { timeout: 4000 });
    if (r.code === 0) return;
  }
  openDefault(select ? path.dirname(target) : target);
}
export function openDefault(target) {
  if (NO_WINDOW()) return;
  const bin = has('xdg-open') ? 'xdg-open' : has('gio') ? 'gio' : null;
  if (!bin) throw Object.assign(new Error('Install xdg-utils (xdg-open) to open files from VideoHub.'), { code: 501 });
  spawn(bin, bin === 'gio' ? ['open', target] : [target], { stdio: 'ignore', detached: true }).unref();
}

// ---------- folder picker → the chosen folder or null
export async function pickFolderDialog(start, title = 'Choose folder') {
  if (NO_WINDOW()) return null;
  const startDir = start && fs.existsSync(start) ? start.replace(/\/?$/, '/') : os.homedir() + '/';
  const attempts = [
    ['zenity', ['--file-selection', '--directory', '--title=' + title, '--filename=' + startDir]],
    ['kdialog', ['--getexistingdirectory', startDir, '--title', title]],
    ['yad', ['--file', '--directory', '--title=' + title, '--filename=' + startDir]],
  ];
  for (const [bin, args] of attempts) {
    if (!has(bin)) continue;
    const r = await sh(bin, args, { timeout: 10 * 60e3 });
    const out = r.stdout.trim().split('\n').pop();
    return r.code === 0 && out ? out.replace(/\/+$/, '') || '/' : null;
  }
  return null;
}

// ---------- graphics cards by name (virtual adapters left out)
export async function gpuNamesLinux() {
  if (!has('lspci')) return [];
  const r = await sh('lspci', []);
  return r.stdout.split('\n').map(l => /(?:VGA compatible controller|3D controller|Display controller):\s*(.+)$/.exec(l)?.[1]?.replace(/\s*\(rev [0-9a-f]+\)\s*$/i, '').trim())
    .filter(s => s && !/virtio|vmware|qxl|bochs|cirrus|basic/i.test(s));
}

// ---------- processes
// [{ pid, ppid, rssBytes, name, args }]
export async function listProcesses() {
  const [a, b] = await Promise.all([sh('ps', ['-eo', 'pid=,ppid=,rss=,comm=']), sh('ps', ['-eo', 'pid=,args=', '-ww'])]);
  if (a.code !== 0) return null;
  const args = new Map();
  for (const l of b.stdout.split('\n')) { const m = /^\s*(\d+)\s+(.*)$/.exec(l); if (m) args.set(+m[1], m[2]); }
  const out = [];
  for (const l of a.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(l); if (!m) continue;
    out.push({ pid: +m[1], ppid: +m[2], rssBytes: +m[3] * 1024, name: m[4], args: args.get(+m[1]) || '' });
  }
  return out;
}
// the process and everything below it, parents first
export async function processTree(rootPid) {
  const list = await listProcesses(); if (!list) return [rootPid];
  const kids = new Map();
  for (const p of list) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
  const out = [], seen = new Set(); const queue = [rootPid];
  while (queue.length) { const x = queue.shift(); if (seen.has(x)) continue; seen.add(x); out.push(x); for (const k of kids.get(x) || []) queue.push(k); }
  return out;
}
// stop a render and everything it started (Chrome, ffmpeg…): children first
export async function killTree(rootPid, signal = 'SIGKILL') {
  if (!Number.isInteger(rootPid) || rootPid <= 1 || rootPid === process.pid) return;   // never init, never ourselves
  try { process.kill(rootPid, 0); } catch (e) { if (e.code !== 'EPERM') return; }
  const pids = (await processTree(rootPid)).reverse();
  for (const p of pids) { try { process.kill(p, signal); } catch { } }
}
// lower priority / fewer cores for a process tree. Linux nice values are per thread, so every thread gets it.
export async function limitTree(rootPid, { nice, cpus }) {
  const pids = await processTree(rootPid);
  for (const pid of pids) {
    let tids = [pid]; try { tids = fs.readdirSync(`/proc/${pid}/task`).map(Number); } catch { }
    for (const t of tids) { try { os.setPriority(t, nice); } catch { } }
    if (cpus && has('taskset')) await sh('taskset', ['-a', '-c', '-p', cpus, String(pid)], { timeout: 5000 });
  }
}

// ---------- start at login (server only, no window): an XDG autostart entry
const AUTOSTART = path.join(CONFIG_HOME, 'autostart', 'videohub.desktop');
export const autostartOn = () => fs.existsSync(AUTOSTART);
export function setAutostart(on, hubDir) {
  if (!on) { try { fs.unlinkSync(AUTOSTART); } catch { } return; }
  fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
  fs.writeFileSync(AUTOSTART, `[Desktop Entry]\nType=Application\nName=VideoHub (server)\nExec="${path.join(hubDir, 'videohub.sh')}" --server\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
}
