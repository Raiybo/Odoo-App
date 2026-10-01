#!/usr/bin/env node
/*
 * Odoo App - setup helper used by install.sh / install.ps1.
 * Zero dependencies. Handles the parts that are easy to get wrong in shell scripts:
 * writing JSON safely and editing Claude's configuration files.
 *
 *   node setup.js save-config   --dir <appDir>                 reads ODOO_* environment variables, writes <appDir>/config.json (owner-only permissions)
 *   node setup.js read-config   --dir <appDir> --key <key>     prints one value from <appDir>/config.json (url, login, db, readOnly)
 *   node setup.js claude-desktop --node <node> --server <index.js> --config <config.json> [--file <claude_desktop_config.json>] [--remove]
 *   node setup.js claude-code    --node <node> --server <index.js> --config <config.json> [--remove]
 *   node setup.js detect                                       prints JSON describing what is installed
 *
 * Exit codes: 0 done, 1 error, 2 skipped (the target application is not installed).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function say(msg) { process.stdout.write(msg + '\n'); }
function die(msg, code) { process.stderr.write(msg + '\n'); process.exit(code || 1); }

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function writeJsonPrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch (_) { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------
function claudeDesktopConfigFile() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

function exists(p) { try { fs.accessSync(p); return true; } catch (_) { return false; } }

function findInStartMenu() {
  if (process.platform !== 'win32') return null;
  const roots = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  for (const root of roots) {
    if (!exists(root)) continue;
    const stack = [root];
    let depth = 0;
    while (stack.length && depth < 400) {
      depth++;
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (/^claude\.lnk$/i.test(e.name)) return full;
      }
    }
  }
  return null;
}

function detectClaudeDesktop() {
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Claude.app', path.join(home, 'Applications', 'Claude.app'));
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(path.join(local, 'AnthropicClaude', 'claude.exe'), path.join(local, 'Programs', 'Claude', 'Claude.exe'), path.join(local, 'Programs', 'claude-desktop', 'Claude.exe'));
  } else {
    candidates.push('/usr/bin/claude-desktop', '/opt/Claude/claude');
  }
  const found = candidates.find(exists) || null;
  const shortcut = found ? null : findInStartMenu();
  const configDir = path.dirname(claudeDesktopConfigFile());
  return { installed: !!(found || shortcut || exists(configDir)), executable: found, shortcut, configFile: claudeDesktopConfigFile(), configDirExists: exists(configDir) };
}

function detectClaudeCode() {
  const home = os.homedir();
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/usr/local/bin', '/opt/homebrew/bin');
  if (process.platform === 'win32') dirs.push(path.join(process.env.APPDATA || '', 'npm'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude'));
  for (const d of dirs) {
    for (const n of names) {
      const full = path.join(d, n);
      if (exists(full)) return full;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function cmdSaveConfig(args) {
  const dir = args.dir || die('--dir is required');
  const env = process.env;
  const file = path.join(dir, 'config.json');
  const existing = readJson(file);
  const bool = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
  const data = {
    url: (env.ODOO_URL || existing.url || '').trim(),
    login: (env.ODOO_LOGIN || existing.login || '').trim(),
    password: env.ODOO_PASSWORD !== undefined ? env.ODOO_PASSWORD : (existing.password || ''),
    db: (env.ODOO_DB !== undefined ? env.ODOO_DB : (existing.db || '')).trim(),
    readOnly: env.ODOO_READ_ONLY !== undefined ? bool(env.ODOO_READ_ONLY) : !!existing.readOnly,
    insecureSsl: env.ODOO_INSECURE_SSL !== undefined ? bool(env.ODOO_INSECURE_SSL) : !!existing.insecureSsl,
    savedAt: new Date().toISOString(),
  };
  if (!data.url || !data.login || !data.password) die('ODOO_URL, ODOO_LOGIN and ODOO_PASSWORD must be set.');
  writeJsonPrivate(file, data);
  say(file);
}

function cmdReadConfig(args) {
  const dir = args.dir || die('--dir is required');
  const data = readJson(path.join(dir, 'config.json'));
  const v = data[args.key];
  say(v === undefined || v === null ? '' : String(v));
}

function serverEntry(args) {
  if (!args.node || !args.server || !args.config) die('--node, --server and --config are required');
  return { command: args.node, args: [args.server], env: { ODOO_CONFIG_FILE: args.config } };
}

function cmdClaudeDesktop(args) {
  const file = args.file || claudeDesktopConfigFile();
  const det = detectClaudeDesktop();
  if (!args.file && !det.installed && !args.force) {
    say(`Claude Desktop is not installed (looked for the app and ${path.dirname(file)}).`);
    process.exit(2);
  }
  let data;
  try {
    data = readJson(file);
  } catch (e) {
    const backup = `${file}.broken-${Date.now()}.bak`;
    fs.copyFileSync(file, backup);
    say(`Warning: ${file} was not valid JSON; the old file was kept as ${path.basename(backup)}.`);
    data = {};
  }
  if (typeof data !== 'object' || Array.isArray(data) || data === null) data = {};
  if (exists(file)) { try { fs.copyFileSync(file, `${file}.bak`); } catch (_) { /* ignore */ } }
  if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
  if (args.remove) {
    delete data.mcpServers.odoo;
  } else {
    data.mcpServers.odoo = serverEntry(args);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  say(file);
}

function runClaude(cli, cliArgs) {
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli);
  if (useShell) {
    const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    return spawnSync([cli].concat(cliArgs).map(q).join(' '), { shell: true, encoding: 'utf8', timeout: 60000 });
  }
  return spawnSync(cli, cliArgs, { encoding: 'utf8', timeout: 60000 });
}

function cmdClaudeCode(args) {
  const cli = detectClaudeCode();
  if (!cli) { say('Claude Code (the "claude" command) is not installed.'); process.exit(2); }
  runClaude(cli, ['mcp', 'remove', 'odoo', '--scope', 'user']); // ignore result: it fails when not present
  if (args.remove) { say(cli); return; }
  const entry = serverEntry(args);
  const r = runClaude(cli, ['mcp', 'add', '--env', `ODOO_CONFIG_FILE=${entry.env.ODOO_CONFIG_FILE}`, '--transport', 'stdio', '--scope', 'user', 'odoo', '--', entry.command, entry.args[0]]);
  if (r.status !== 0) die(`"claude mcp add" failed (exit ${r.status}):\n${(r.stdout || '') + (r.stderr || '')}`);
  say(cli);
}

function cmdDetect() {
  say(JSON.stringify({ platform: process.platform, claudeDesktop: detectClaudeDesktop(), claudeCode: detectClaudeCode() }));
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  switch (cmd) {
    case 'save-config': cmdSaveConfig(args); break;
    case 'read-config': cmdReadConfig(args); break;
    case 'claude-desktop': cmdClaudeDesktop(args); break;
    case 'claude-code': cmdClaudeCode(args); break;
    case 'detect': cmdDetect(); break;
    default: die('Usage: setup.js <save-config|read-config|claude-desktop|claude-code|detect> [options]');
  }
} catch (e) {
  die(`setup.js ${cmd} failed: ${e.message}`);
}
