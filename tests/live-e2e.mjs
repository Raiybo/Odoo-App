// End-to-end test with a sample person on a real Odoo, through everything a teammate can use, taken from
// the live site (needs internet):
//   1. creates a sample user (email + password) on a throw-away database of Odoo's public demo server
//   2. the extension exactly as downloaded from the site, started the way Claude Desktop starts it
//   3. the personalised extension a team link builds (the Odoo address pre-filled)
//   4. the automatic installer for this operating system, fetched and run the way the guide's command does,
//      in an isolated home folder; then the connector it registered, started the way Claude Desktop starts it
// In every case the sample person's questions are asked over MCP: connection check, searches, totals, and
// creating, changing and deleting a contact.
//
//   node tests/live-e2e.mjs                (SITE=https://... to test another address)
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mcpConfigFor, formValues, cleanEnv, launchServer, unzip } from './lib/host.mjs';

const SITE = (process.env.SITE || 'https://odoo-app.netlify.app').replace(/\/+$/, '');
const EMAIL = 'sample.user@example.com';
const PASSWORD = 'Sample "Pass" #2026!'; // quotes, spaces and symbols on purpose
const NAME = 'Sample User';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-app-e2e-'));
const require = createRequire(import.meta.url);

async function download(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ---------------------------------------------------------------------------
// 1. A real Odoo and a sample person
// ---------------------------------------------------------------------------
async function demoCredentials() {
  const res = await fetch('https://demo.odoo.com/start', { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: '<?xml version="1.0"?><methodCall><methodName>start</methodName><params></params></methodCall>' });
  const xml = await res.text();
  const get = (name) => { const m = new RegExp(`<name>${name}</name>\\s*<value><string>([^<]*)</string>`).exec(xml); return m && m[1]; };
  const creds = { url: get('host'), db: get('database'), login: get('user'), password: get('password') };
  if (!creds.url || !creds.db) throw new Error(`Could not get demo credentials: ${xml.slice(0, 300)}`);
  return creds;
}

// Plain Odoo web calls, independent of the connector under test.
async function odooRpc(base, route, params, cookie) {
  const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: 1, params }) });
  const data = await r.json();
  if (data.error) throw new Error((data.error.data && data.error.data.message) || data.error.message);
  const set = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  const sid = set.map((c) => /session_id=([^;]+)/.exec(c)).find(Boolean);
  return { result: data.result, cookie: sid ? `session_id=${sid[1]}` : cookie };
}

async function createSamplePerson(creds) {
  const admin = await odooRpc(creds.url, '/web/session/authenticate', { db: creds.db, login: creds.login, password: creds.password });
  assert.ok(admin.result && admin.result.uid, 'demo administrator login failed');
  const created = await odooRpc(creds.url, '/web/dataset/call_kw/res.users/create', { model: 'res.users', method: 'create', args: [{ name: NAME, login: EMAIL, email: EMAIL, password: PASSWORD }], kwargs: {} }, admin.cookie);
  return Array.isArray(created.result) ? created.result[0] : created.result;
}

// ---------------------------------------------------------------------------
// The sample person's session with Claude's Odoo tools
// ---------------------------------------------------------------------------
async function sampleSession(label, mcp, creds) {
  const init = await mcp.init();
  assert.equal(init.serverInfo.name, 'odoo');
  const tools = await mcp.tools();
  assert.equal(tools.length, 13, `expected 13 tools, got ${tools.length}`);

  let r = await mcp.call('odoo_check_connection');
  assert.ok(!r.isError, r.text);
  assert.ok(r.text.includes(`User:      ${NAME} (${EMAIL}`), r.text);
  assert.ok(r.text.includes(`Address:   ${creds.url}`) && r.text.includes(`Database:  ${creds.db}`), r.text);
  assert.match(r.text, /Access:\s+read and write/);
  const version = /Odoo:\s+(.+)/.exec(r.text)[1];

  r = await mcp.call('odoo_search_models', { query: 'invoice' });
  assert.ok(!r.isError && r.text.includes('account.move'), r.text);
  r = await mcp.call('odoo_fields', { model: 'res.partner', filter: 'email' });
  assert.ok(!r.isError && r.text.includes('email (char)'), r.text);
  r = await mcp.call('odoo_search_read', { model: 'res.partner', domain: [['is_company', '=', true]], fields: ['name', 'email', 'country_id'], limit: 3 });
  assert.ok(!r.isError && /^3 records from res\.partner/.test(r.text), r.text);
  r = await mcp.call('odoo_count', { model: 'sale.order', domain: [] });
  assert.ok(!r.isError && /^\d+ records? in sale\.order/.test(r.text), r.text);
  const orders = parseInt(r.text, 10);
  r = await mcp.call('odoo_group_by', { model: 'sale.order', groupby: ['state'], aggregates: ['amount_total:sum'] });
  assert.ok(!r.isError && r.text.includes('__count'), r.text);
  r = await mcp.call('odoo_name_search', { model: 'res.partner', name: 'Azure' });
  assert.ok(!r.isError && /Azure Interior/.test(r.text), r.text);

  r = await mcp.call('odoo_create', { model: 'res.partner', values: { name: `Odoo App check (${label})`, email: 'check@example.com' } });
  assert.ok(!r.isError && /Created res\.partner record id \d+/.test(r.text), r.text);
  const id = parseInt(/id (\d+)/.exec(r.text)[1], 10);
  r = await mcp.call('odoo_write', { model: 'res.partner', ids: [id], values: { phone: '+1 555 0100' } });
  assert.ok(!r.isError, r.text);
  r = await mcp.call('odoo_read', { model: 'res.partner', ids: [id], fields: ['name', 'phone'] });
  assert.ok(!r.isError && r.text.includes('+1 555 0100'), r.text);
  r = await mcp.call('odoo_record_link', { model: 'res.partner', id });
  assert.ok(!r.isError && r.text.startsWith(creds.url), r.text);
  r = await mcp.call('odoo_delete', { model: 'res.partner', ids: [id], confirm: true });
  assert.ok(!r.isError, r.text);
  r = await mcp.call('odoo_count', { model: 'res.partner', domain: [['id', '=', id]] });
  assert.ok(!r.isError && r.text.startsWith('0 records'), r.text);
  await mcp.close();
  console.log(`PASS  ${label}: connected as ${NAME} to Odoo ${version}; searches, totals (${orders} sales orders), and create/change/delete of a contact all worked`);
}

function unpackTo(dir, zipBytes) {
  for (const [name, data] of Object.entries(unzip(zipBytes))) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

const fromExtension = (cfg) => launchServer(cfg.command, cfg.args, cleanEnv({ ODOO_CONFIG_FILE: path.join(tmp, 'no-such-config.json'), ...cfg.env }));

// ---------------------------------------------------------------------------
// 4. The automatic installer, as the guide's command runs it
// ---------------------------------------------------------------------------
function runInstaller(creds) {
  const home = path.join(tmp, 'home');
  const appDir = path.join(home, process.platform === 'win32' ? 'OdooClaude' : '.odoo-claude');
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...process.env, ODOO_CLAUDE_HOME: appDir, ODOO_CLAUDE_NO_LAUNCH: '1',
    ODOO_URL: creds.url, ODOO_LOGIN: EMAIL, ODOO_PASSWORD: PASSWORD, ODOO_DB: creds.db,
  };
  delete env.ODOO_CLAUDE_BASE_URL; // the installer's own default address is what teammates get
  let desktopConfigs, result;
  if (process.platform === 'win32') {
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
    env.USERPROFILE = home;
    env.ODOO_SETUP_SKIP_APPX = '1'; // do not look at the Claude Desktop really installed on this machine
    const msix = path.join(env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming');
    fs.mkdirSync(env.APPDATA, { recursive: true });
    fs.mkdirSync(msix, { recursive: true });
    desktopConfigs = [path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json'), path.join(msix, 'Claude', 'claude_desktop_config.json')];
    result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${SITE}/install.ps1 | iex`], { env, encoding: 'utf8', timeout: 600000 });
  } else {
    env.HOME = home;
    env.XDG_CONFIG_HOME = path.join(home, '.config');
    desktopConfigs = [process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') : path.join(env.XDG_CONFIG_HOME, 'Claude', 'claude_desktop_config.json')];
    result = spawnSync('/bin/bash', ['-c', `/bin/bash -c "$(curl -fsSL ${SITE}/install.sh)"`], { env, encoding: 'utf8', timeout: 600000 });
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.status, 0, `installer exited with ${result.status}:\n${output}`);
  assert.ok(/Your Odoo login works/.test(output) && /All set!/.test(output), `installer did not finish:\n${output}`);
  assert.ok(output.includes(NAME), `installer did not show the connected person:\n${output}`);

  const saved = JSON.parse(fs.readFileSync(path.join(appDir, 'config.json'), 'utf8'));
  assert.equal(saved.login, EMAIL);
  assert.equal(saved.password, PASSWORD, 'the password is saved exactly as typed');
  let entry;
  for (const file of desktopConfigs) {
    assert.ok(fs.existsSync(file), `Claude Desktop configuration missing: ${file}`);
    entry = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.odoo;
    assert.ok(entry && fs.existsSync(entry.command) && fs.existsSync(entry.args[0]), `bad Odoo entry in ${file}`);
  }
  return entry;
}

// ---------------------------------------------------------------------------
try {
  console.log(`site: ${SITE}   system: ${process.platform} ${os.arch()}, node ${process.version}`);
  const creds = await demoCredentials();
  const userId = await createSamplePerson(creds);
  console.log(`real Odoo: ${creds.url} (database ${creds.db}); sample person ${EMAIL} created (user id ${userId})`);

  // 2. The extension exactly as the site serves it
  const extDir = path.join(tmp, 'Claude Extensions', 'local.mcpb.raiybo.odoo');
  const manifest = unpackTo(extDir, await download(`${SITE}/odoo.mcpb`));
  let cfg = mcpConfigFor(manifest, extDir, formValues(manifest, { odoo_url: creds.url, odoo_login: EMAIL, odoo_password: PASSWORD, odoo_db: creds.db }));
  assert.equal(cfg.env.ODOO_PASSWORD, PASSWORD);
  await sampleSession(`extension ${manifest.version} downloaded from the site`, fromExtension(cfg), creds);

  // What teammates will get wrong: a typo in the password must be explained, not crash.
  cfg = mcpConfigFor(manifest, extDir, formValues(manifest, { odoo_url: creds.url, odoo_login: EMAIL, odoo_password: 'wrong-password', odoo_db: creds.db }));
  let mcp = fromExtension(cfg);
  await mcp.init();
  let r = await mcp.call('odoo_check_connection');
  assert.ok(r.isError && /rejected the login for "sample\.user@example\.com"/.test(r.text), r.text);
  await mcp.close();
  console.log('PASS  wrong password on the real Odoo: explained in plain language, the connector keeps running');

  // 3. The personalised extension a team link builds, with the builder and the files taken from the site
  const builderFile = path.join(tmp, 'odoo-app-bundle.cjs');
  fs.writeFileSync(builderFile, await download(`${SITE}/assets/odoo-app-bundle.js`));
  const B = require(builderFile);
  const personalDir = path.join(tmp, 'Claude Extensions', 'local.mcpb.raiybo.odoo-team');
  const personal = unpackTo(personalDir, Buffer.from(await B.buildBundle((u) => fetch(u, { cache: 'no-store' }), `${SITE}/`, { odooUrl: creds.url, company: 'Sample Company' })));
  assert.equal(personal.user_config.odoo_url.default, creds.url);
  cfg = mcpConfigFor(personal, personalDir, formValues(personal, { odoo_login: EMAIL, odoo_password: PASSWORD, odoo_db: creds.db }));
  assert.equal(cfg.env.ODOO_URL, creds.url, 'the address comes from the team link, not from the person');
  await sampleSession('team-link extension (address pre-filled)', fromExtension(cfg), creds);

  // 4. The automatic installer from the site, then the connector it registered in Claude Desktop
  const entry = runInstaller(creds);
  await sampleSession(`automatic installer (${process.platform === 'win32' ? 'irm | iex' : 'curl | bash'} from the site)`, launchServer(entry.command, entry.args, cleanEnv(entry.env)), creds);

  console.log('\nLIVE END-TO-END TEST PASSED');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
