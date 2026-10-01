// Live smoke test against Odoo's public demo server (needs internet).
// Gets throw-away demo credentials from https://demo.odoo.com/start, then runs the connector
// in --test mode and through the MCP protocol.
//   node tests/live-demo.mjs
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'server', 'index.js');

async function demoCredentials() {
  const res = await fetch('https://demo.odoo.com/start', { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: '<?xml version="1.0"?><methodCall><methodName>start</methodName><params></params></methodCall>' });
  const xml = await res.text();
  const get = (name) => { const m = new RegExp(`<name>${name}</name>\\s*<value><string>([^<]*)</string>`).exec(xml); return m && m[1]; };
  const creds = { url: get('host'), db: get('database'), login: get('user'), password: get('password') };
  if (!creds.url || !creds.db) throw new Error(`Could not get demo credentials: ${xml.slice(0, 300)}`);
  return creds;
}

function env(creds) {
  return { ...process.env, ODOO_CONFIG_FILE: path.join(here, 'no-such-config.json'), ODOO_URL: creds.url, ODOO_DB: creds.db, ODOO_LOGIN: creds.login, ODOO_PASSWORD: creds.password, ODOO_READ_ONLY: 'true' };
}

const creds = await demoCredentials();
console.log(`Demo Odoo: ${creds.url} db=${creds.db} user=${creds.login}`);

// 1. --test mode
const t = spawn(process.execPath, [SERVER, '--test', '--json'], { env: env(creds), stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
t.stdout.on('data', (d) => { out += d; });
const code = await new Promise((r) => t.on('exit', r));
assert.equal(code, 0, out);
const info = JSON.parse(out.trim());
assert.equal(info.ok, true);
console.log(`--test ok: Odoo ${info.odoo_version} ${info.edition}, user ${info.user}, via ${info.transport}`);

// 2. MCP over stdio
const child = spawn(process.execPath, [SERVER], { env: env(creds), stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let id = 0, buf = '';
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } } } });
const request = (method, params) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const call = async (name, args) => { const m = await request('tools/call', { name, arguments: args }); const text = m.result.content.map((c) => c.text).join('\n'); return { text, isError: !!m.result.isError }; };

const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live', version: '0' } });
assert.equal(init.result.serverInfo.name, 'odoo');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

let r = await call('odoo_check_connection', {});
assert.ok(!r.isError, r.text); console.log(r.text);
r = await call('odoo_search_models', { query: 'invoice' });
assert.ok(!r.isError && r.text.includes('account.move'), r.text); console.log(r.text.split('\n').slice(0, 4).join('\n'));
r = await call('odoo_fields', { model: 'res.partner', filter: 'email' });
assert.ok(!r.isError && r.text.includes('email (char)'), r.text);
r = await call('odoo_search_read', { model: 'res.partner', domain: [['is_company', '=', true]], limit: 3 });
assert.ok(!r.isError && /^3 records from res\.partner/.test(r.text), r.text); console.log(r.text.split('\n')[0]);
r = await call('odoo_count', { model: 'res.partner', domain: [] });
assert.ok(!r.isError && /^\d+ records in res\.partner/.test(r.text), r.text); console.log(r.text);
r = await call('odoo_name_search', { model: 'res.partner', name: 'Azure' });
assert.ok(!r.isError && /Azure Interior/.test(r.text), r.text);
r = await call('odoo_group_by', { model: 'res.partner', groupby: ['country_id'], limit: 3 });
assert.ok(!r.isError && r.text.includes('__count'), r.text); console.log(r.text.split('\n')[0]);
r = await call('odoo_read', { model: 'res.users', ids: [info.user_id], fields: ['name', 'login'] });
assert.ok(!r.isError && r.text.includes(info.user), r.text);
r = await call('odoo_create', { model: 'res.partner', values: { name: 'Should be blocked' } });
assert.ok(r.isError && /read-only mode/.test(r.text), r.text); console.log('read-only guard ok');
r = await call('odoo_record_link', { model: 'res.partner', id: 1 });
assert.ok(!r.isError && r.text.startsWith(creds.url), r.text); console.log(r.text);

child.stdin.end();
await new Promise((r) => child.on('exit', r));
console.log('\nLive demo test passed.');
