// Runs the extension the way Claude Desktop does. Takes bundle/ (the unzipped odoo.mcpb), copies it into a
// folder named like Claude's extension folder, turns the values of the settings form into the launch command
// with the same rules as the official implementation (getMcpConfigForManifest in @anthropic-ai/mcpb), starts
// that command and speaks MCP to it against the fake Odoo.
//   node tests/extension-host.test.mjs
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const B = require(path.join(root, 'assets', 'odoo-app-bundle.js'));

const LOGIN = 'jane@example.com';
const PASSWORD = 'S3cret!"quote';

// ---------------------------------------------------------------------------
// The host side, as in @anthropic-ai/mcpb (src/shared/config.ts)
// ---------------------------------------------------------------------------
function replaceVariables(value, variables) {
  if (typeof value === 'string') {
    let result = value;
    for (const [key, replacement] of Object.entries(variables)) {
      const pattern = new RegExp(`\\$\\{${key}\\}`, 'g');
      if (result.match(pattern) && !Array.isArray(replacement)) result = result.replace(pattern, replacement);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => replaceVariables(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceVariables(v, variables)]));
  return value;
}

function requiredConfigMissing(manifest, userConfig) {
  return Object.entries(manifest.user_config || {}).some(([key, option]) => option.required && (userConfig[key] === undefined || userConfig[key] === null || userConfig[key] === ''));
}

function mcpConfigFor(manifest, extensionPath, userConfig) {
  if (requiredConfigMissing(manifest, userConfig)) return undefined;
  const variables = { __dirname: extensionPath, pathSeparator: path.sep, '/': path.sep, HOME: os.homedir() };
  const merged = {};
  for (const [key, option] of Object.entries(manifest.user_config || {})) if (option.default !== undefined) merged[key] = option.default;
  Object.assign(merged, userConfig);
  for (const [key, value] of Object.entries(merged)) variables[`user_config.${key}`] = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  return replaceVariables({ ...manifest.server.mcp_config }, variables);
}

// What the settings form holds when the person clicks Save: the defaults, plus what they typed.
function formValues(manifest, typed) {
  const values = {};
  for (const [key, option] of Object.entries(manifest.user_config)) if (option.default !== undefined) values[key] = option.default;
  return Object.assign(values, typed);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function withTimeout(p, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function startMock(env) {
  const child = spawn(process.execPath, [path.join(here, 'mock-odoo.mjs')], { env: { ...process.env, WATCH_STDIN: '1', MOCK_LOGIN: LOGIN, MOCK_PASSWORD: PASSWORD, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const info = await withTimeout(new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(JSON.parse(buf.slice(0, i))); });
    child.on('exit', (c) => reject(new Error(`mock exited with ${c}`)));
  }), 10000, 'mock start');
  return { url: `http://127.0.0.1:${info.port}`, stop: () => { child.stdin.end(); child.kill(); } };
}

// Starts the resolved command (Claude Desktop supplies the Node.js runtime for "node") and returns an MCP client.
function launch(cfg) {
  assert.equal(cfg.command, 'node');
  // A clean environment: nothing from the developer's shell, no configuration file from an installer.
  const env = { ODOO_CONFIG_FILE: path.join(here, 'no-such-config.json') };
  for (const k of ['SystemRoot', 'PATH', 'Path', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) if (process.env[k]) env[k] = process.env[k];
  const child = spawn(process.execPath, cfg.args, { env: { ...env, ...cfg.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let id = 0, buf = '', stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line); // stdout must carry nothing but MCP messages
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  const request = (method, params) => withTimeout(new Promise((resolve) => { const i = ++id; pending.set(i, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); }), 30000, method);
  return {
    async init() {
      const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r.result;
    },
    async tools() { return (await request('tools/list', {})).result.tools; },
    async call(name, args) { const m = await request('tools/call', { name, arguments: args || {} }); return { text: m.result.content.map((c) => c.text).join('\n'), isError: !!m.result.isError }; },
    async close() {
      child.stdin.end();
      const code = await withTimeout(new Promise((r) => child.on('exit', r)), 8000, 'server exit');
      assert.equal(code, 0, `server exit code ${code}\n${stderr}`);
    },
  };
}

// ---------------------------------------------------------------------------
// The extension folder, as Claude Desktop lays it out (the path contains a space)
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-app-host-'));
const extDir = path.join(tmp, 'Claude Extensions', 'local.mcpb.raiybo.odoo');
fs.cpSync(path.join(root, 'bundle'), extDir, { recursive: true });
const manifestText = fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);

// 1. The manifest and the launch command agree with each other
const used = new Set([...JSON.stringify(manifest.server.mcp_config).matchAll(/\$\{user_config\.([a-z_]+)\}/g)].map((m) => m[1]));
assert.deepEqual([...used].sort(), Object.keys(manifest.user_config).sort(), 'every setting of the form is passed to the server, and nothing else');
assert.ok(fs.existsSync(path.join(extDir, manifest.server.entry_point)), 'entry point exists in the bundle');
assert.ok(fs.existsSync(path.join(extDir, manifest.icon)), 'icon exists in the bundle');
assert.equal(mcpConfigFor(manifest, extDir, formValues(manifest, {})), undefined, 'nothing is started before the form is filled in');
assert.equal(mcpConfigFor(manifest, extDir, formValues(manifest, { odoo_url: 'https://x.odoo.com', odoo_login: LOGIN })), undefined, 'nothing is started without the password');
console.log('PASS  manifest: settings and launch command are consistent');

const mock = await startMock({ MOCK_VERSION: '18.0+e', MOCK_MONODB: '1', MOCK_LIST_DB: '0', MOCK_DBS: 'acme-prod' });
try {
  // 2. A teammate types only the address, email and password
  let cfg = mcpConfigFor(manifest, extDir, formValues(manifest, { odoo_url: mock.url, odoo_login: LOGIN, odoo_password: PASSWORD }));
  assert.equal(cfg.env.ODOO_PASSWORD, PASSWORD);
  assert.equal(cfg.env.ODOO_DB, '${user_config.odoo_db}', 'an empty optional field is left as a placeholder by the host');
  assert.equal(cfg.env.ODOO_READ_ONLY, 'false');
  let mcp = launch(cfg);
  const init = await mcp.init();
  assert.equal(init.serverInfo.name, 'odoo');
  assert.equal(init.serverInfo.version, manifest.version, 'server and manifest carry the same version');
  const tools = await mcp.tools();
  assert.deepEqual(tools.map((t) => t.name).sort(), manifest.tools.map((t) => t.name).sort(), 'the manifest lists exactly the tools the server offers');
  let r = await mcp.call('odoo_check_connection');
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Database:\s+acme-prod \(auto-detected \(login\)\)/);
  assert.match(r.text, /Access:\s+read and write/);
  r = await mcp.call('odoo_search_read', { model: 'res.partner', domain: [['is_company', '=', true]], fields: ['name'], limit: 2 });
  assert.ok(!r.isError && r.text.startsWith('2 records from res.partner'), r.text);
  await mcp.close();
  console.log('PASS  only address, email and password typed: connects, database detected, tools match the manifest');

  // 3. Every field filled in, read-only switched on, the address typed with a page path
  cfg = mcpConfigFor(manifest, extDir, formValues(manifest, { odoo_url: `${mock.url}/web/login`, odoo_login: LOGIN, odoo_password: PASSWORD, odoo_db: 'acme-prod', read_only: true, insecure_ssl: false }));
  assert.equal(cfg.env.ODOO_READ_ONLY, 'true');
  mcp = launch(cfg);
  await mcp.init();
  r = await mcp.call('odoo_check_connection');
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Database:\s+acme-prod \(configured\)/);
  assert.match(r.text, /Access:\s+read-only/);
  r = await mcp.call('odoo_create', { model: 'res.partner', values: { name: 'x' } });
  assert.ok(r.isError && /read-only mode/.test(r.text), r.text);
  await mcp.close();
  console.log('PASS  all fields filled in with read-only mode: reads work, changes are refused');

  // 4. The personalised extension from a team link: the address comes from the manifest, not from the person
  const personal = JSON.parse(B.customizeManifest(manifestText, { odooUrl: mock.url, company: 'Acme Corp' }));
  cfg = mcpConfigFor(personal, extDir, formValues(personal, { odoo_login: LOGIN, odoo_password: PASSWORD }));
  assert.ok(cfg, 'the pre-filled address counts as filled in');
  assert.equal(cfg.env.ODOO_URL, mock.url);
  mcp = launch(cfg);
  await mcp.init();
  r = await mcp.call('odoo_check_connection');
  assert.ok(!r.isError && r.text.includes(mock.url), r.text);
  await mcp.close();
  console.log('PASS  personalised extension (team link): only email and password typed');

  // 5. A wrong password is explained by the tool instead of crashing the server
  cfg = mcpConfigFor(manifest, extDir, formValues(manifest, { odoo_url: mock.url, odoo_login: LOGIN, odoo_password: 'wrong' }));
  mcp = launch(cfg);
  await mcp.init();
  r = await mcp.call('odoo_check_connection');
  assert.ok(r.isError && /rejected the login/.test(r.text) && /API key/.test(r.text), r.text);
  await mcp.close();
  console.log('PASS  wrong password: the server stays up and explains what to fix');
} finally {
  mock.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('extension host tests passed');
