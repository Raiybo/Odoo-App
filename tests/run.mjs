// End-to-end tests for the Odoo MCP server.
// Starts the fake Odoo (tests/mock-odoo.mjs) in various shapes, starts server/index.js the way
// Claude Desktop does (stdio), speaks MCP to it and checks the results.
//
//   node tests/run.mjs            run everything
//   node tests/run.mjs auth       run only scenarios whose name contains "auth"
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'server', 'index.js');
const MOCK = path.join(here, 'mock-odoo.mjs');
const filter = process.argv[2] || '';

const LOGIN = 'jane@example.com';
const PASSWORD = 'S3cret!"quote';
const API_KEY = 'k3y-0123456789abcdef0123456789abcdef';

function withTimeout(p, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function startMock(env) {
  const child = spawn(process.execPath, [MOCK], { env: { ...process.env, WATCH_STDIN: '1', MOCK_LOGIN: LOGIN, MOCK_PASSWORD: PASSWORD, MOCK_API_KEY: API_KEY, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const info = await withTimeout(new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(JSON.parse(buf.slice(0, i))); });
    child.on('exit', (c) => reject(new Error(`mock exited with ${c}`)));
  }), 10000, 'mock start');
  return { child, ...info, url: `http://127.0.0.1:${info.port}`, stop: () => { child.stdin.end(); child.kill(); } };
}

class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [SERVER], { env: { ...baseEnv(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.id = 0;
    this.stderr = '';
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) this.onMessage(JSON.parse(line));
      }
    });
    this.child.stderr.on('data', (d) => { this.stderr += d; });
  }
  onMessage(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })); else p.resolve(msg.result);
  }
  request(method, params) {
    const id = ++this.id;
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return withTimeout(p, 30000, method);
  }
  notify(method, params) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n'); }
  async init() {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'odoo-app-tests', version: '1.0' } });
    this.notify('notifications/initialized');
    return r;
  }
  async call(name, args) {
    const r = await this.request('tools/call', { name, arguments: args || {} });
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  }
  async close() {
    this.child.stdin.end();
    const code = await withTimeout(new Promise((r) => this.child.on('exit', r)), 8000, 'server exit').catch(() => { this.child.kill(); return 'killed'; });
    return code;
  }
}

function baseEnv() {
  // Make sure the developer's own config file never leaks into the tests.
  return { ...process.env, ODOO_CONFIG_FILE: path.join(here, 'no-such-config.json'), ODOO_URL: '', ODOO_DB: '', ODOO_LOGIN: '', ODOO_PASSWORD: '', ODOO_READ_ONLY: '', ODOO_API_KEY: '', ODOO_INSECURE_SSL: '' };
}

async function runTestMode(env) {
  const child = spawn(process.execPath, [SERVER, '--test', '--json'], { env: { ...baseEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await withTimeout(new Promise((r) => child.on('exit', r)), 30000, '--test exit');
  let json = null;
  try { json = JSON.parse(out.trim().split('\n').pop()); } catch (_) { /* ignore */ }
  return { code, json, out, err };
}

// ---------------------------------------------------------------------------
const scenarios = [];
function scenario(name, fn) { scenarios.push({ name, fn }); }

scenario('odoo18 monodb password: database discovered from the login page, web transport, full tool tour', async () => {
  const mock = await startMock({ MOCK_VERSION: '18.0+e', MOCK_MONODB: '1', MOCK_LIST_DB: '0', MOCK_DBS: 'acme-prod' });
  const mcp = new McpClient({ ODOO_URL: mock.url, ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD });
  try {
    const init = await mcp.init();
    assert.equal(init.protocolVersion, '2025-06-18');
    assert.equal(init.serverInfo.name, 'odoo');
    assert.ok(init.instructions.includes('odoo_search_models'));

    const list = await mcp.request('tools/list', {});
    const names = list.tools.map((t) => t.name);
    for (const n of ['odoo_check_connection', 'odoo_search_models', 'odoo_fields', 'odoo_search_read', 'odoo_count', 'odoo_read', 'odoo_name_search', 'odoo_group_by', 'odoo_create', 'odoo_write', 'odoo_delete', 'odoo_call', 'odoo_record_link']) assert.ok(names.includes(n), `tool ${n} listed`);
    for (const t of list.tools) assert.equal(t.inputSchema.type, 'object', `${t.name} schema`);

    let r = await mcp.call('odoo_check_connection');
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Database:\s+acme-prod \(auto-detected \(login\)\)/);
    assert.match(r.text, /Odoo:\s+18\.0 Enterprise/);
    assert.match(r.text, /User:\s+Mock Admin/);
    assert.match(r.text, /Company:\s+Mock Company/);
    assert.match(r.text, /Method:\s+web session/);
    assert.match(r.text, /Access:\s+read and write/);

    r = await mcp.call('odoo_search_models', { query: 'sale' });
    assert.ok(!r.isError && r.text.includes('sale.order  -  Sales Order') && r.text.includes('(wizard, temporary)'), r.text);

    r = await mcp.call('odoo_fields', { model: 'res.partner', filter: 'country' });
    assert.ok(!r.isError && /country_id \(many2one\): Country -> res\.country/.test(r.text), r.text);
    r = await mcp.call('odoo_fields', { model: 'res.partner' });
    assert.ok(r.text.includes('type (selection): Address Type [contact|invoice|delivery]'), r.text);

    r = await mcp.call('odoo_search_read', { model: 'res.partner', domain: [['is_company', '=', true]], limit: 2, order: 'name asc' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /^2 records from res\.partner \(fields: display_name, name, email, phone, active, type, is_company, country_id\)/);
    assert.ok(r.text.includes('"name":"Azure Interior"') && r.text.includes('"country_id":[2,"United States"]'), r.text);
    assert.ok(!r.text.includes('image_1920'), 'binary fields are not fetched by default');
    assert.ok(r.text.includes('limit reached'), r.text);

    r = await mcp.call('odoo_search_read', { model: 'res.partner', domain: '[["name","ilike","old"]]', fields: ['name', 'active'], include_archived: true });
    assert.ok(r.text.includes('"name":"Old Customer"'), `archived records with include_archived: ${r.text}`);
    r = await mcp.call('odoo_search_read', { model: 'res.partner', domain: [['name', 'ilike', 'old']], fields: ['name'] });
    assert.match(r.text, /^0 records/, 'archived records hidden by default');

    r = await mcp.call('odoo_count', { model: 'sale.order', domain: [['state', '=', 'sale']] });
    assert.equal(r.text, '2 records in sale.order match the domain.');

    r = await mcp.call('odoo_read', { model: 'sale.order', ids: [1], fields: ['name', 'partner_id', 'amount_total'] });
    assert.ok(r.text.includes('"partner_id":[10,"Azure Interior"]') && r.text.includes('"amount_total":1500'), r.text);

    r = await mcp.call('odoo_name_search', { model: 'res.partner', name: 'azure' });
    assert.equal(r.text, '1 match in res.partner:\n  id 10: Azure Interior');

    r = await mcp.call('odoo_group_by', { model: 'sale.order', groupby: ['partner_id'], aggregates: ['amount_total:sum'] });
    assert.ok(!r.isError, r.text);
    assert.ok(r.text.includes('"partner_id":[10,"Azure Interior"]') && r.text.includes('"amount_total:sum":1750.5') && r.text.includes('"__count":2'), r.text);
    assert.ok(!r.text.includes('__extra_domain'), 'internal keys stripped');

    r = await mcp.call('odoo_create', { model: 'res.partner', values: { name: 'New Co', email: 'new@co.example', is_company: true } });
    assert.match(r.text, /^Created res\.partner record id (\d+)\.\nOpen it: http:\/\/127\.0\.0\.1:\d+\/odoo\/res\.partner\/\d+$/, r.text);
    const newId = parseInt(/id (\d+)/.exec(r.text)[1], 10);

    r = await mcp.call('odoo_write', { model: 'res.partner', ids: [newId], values: { phone: '+1 555 0199' } });
    assert.equal(r.text, `Updated 1 res.partner record (ids ${newId}).`);
    r = await mcp.call('odoo_read', { model: 'res.partner', ids: [newId], fields: ['phone'] });
    assert.ok(r.text.includes('"phone":"+1 555 0199"'), r.text);

    r = await mcp.call('odoo_delete', { model: 'res.partner', ids: [newId], confirm: false });
    assert.ok(r.isError && /not confirmed/.test(r.text), r.text);
    r = await mcp.call('odoo_delete', { model: 'res.partner', ids: [newId], confirm: true });
    assert.equal(r.text, `Deleted 1 res.partner record (ids ${newId}).`);
    r = await mcp.call('odoo_count', { model: 'res.partner', domain: [['id', '=', newId]] });
    assert.equal(r.text, '0 records in res.partner match the domain.');

    r = await mcp.call('odoo_call', { model: 'sale.order', method: 'action_confirm', ids: [2] });
    assert.ok(!r.isError && r.text.startsWith('Result of sale.order.action_confirm:\ntrue'), r.text);
    r = await mcp.call('odoo_read', { model: 'sale.order', ids: [2], fields: ['state'] });
    assert.ok(r.text.includes('"state":"sale"'), r.text);

    r = await mcp.call('odoo_record_link', { model: 'sale.order', id: 3 });
    assert.equal(r.text, `${mock.url}/odoo/sale.order/3`);

    r = await mcp.call('odoo_search_read', { model: 'res.nonexistent' });
    assert.ok(r.isError && /model "res\.nonexistent" does not exist/.test(r.text), r.text);
    r = await mcp.call('odoo_search_read', { model: 'res.partner', fields: ['no_such_field'] });
    assert.ok(r.isError && /Invalid field 'no_such_field'/.test(r.text), r.text);
    r = await mcp.call('odoo_call', { model: 'res.partner', method: '_private' });
    assert.ok(r.isError && /public method/.test(r.text), r.text);

    const unknown = await mcp.request('tools/call', { name: 'nope', arguments: {} }).catch((e) => e);
    assert.equal(unknown.rpc.code, -32602);
    const missing = await mcp.request('no/such/method', {}).catch((e) => e);
    assert.equal(missing.rpc.code, -32601);
    assert.deepEqual(await mcp.request('ping', {}), {});
    assert.deepEqual(await mcp.request('resources/list', {}), { resources: [] });
    assert.deepEqual(await mcp.request('prompts/list', {}), { prompts: [] });
  } finally {
    const code = await mcp.close();
    assert.equal(code, 0, `server exit code ${code}\n${mcp.stderr}`);
    mock.stop();
  }
});

scenario('odoo16 with database list: db from the list, read_group fallback, legacy record links', async () => {
  const mock = await startMock({ MOCK_VERSION: '16.0', MOCK_MONODB: '0', MOCK_LIST_DB: '1', MOCK_DBS: 'company16' });
  const mcp = new McpClient({ ODOO_URL: mock.url, ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD });
  try {
    await mcp.init();
    let r = await mcp.call('odoo_check_connection');
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Database:\s+company16 \(auto-detected \(server list\)\)/);
    assert.match(r.text, /Odoo:\s+16\.0 Community/);
    r = await mcp.call('odoo_group_by', { model: 'sale.order', groupby: ['state'], aggregates: ['amount_total'] });
    assert.ok(!r.isError && r.text.includes('"state":"sale"') && r.text.includes('"amount_total":11300'), r.text);
    r = await mcp.call('odoo_record_link', { model: 'res.partner', id: 10 });
    assert.equal(r.text, `${mock.url}/web#id=10&model=res.partner&view_type=form`);
  } finally { await mcp.close(); mock.stop(); }
});

scenario('odoo19 api key: web login refused, JSON-2 transport with keyword arguments', async () => {
  const mock = await startMock({ MOCK_VERSION: '19.0+e', MOCK_MONODB: '1', MOCK_LIST_DB: '0', MOCK_DBS: 'prod19', MOCK_LEGACY: '0' });
  const mcp = new McpClient({ ODOO_URL: mock.url, ODOO_DB: 'prod19', ODOO_LOGIN: LOGIN, ODOO_PASSWORD: API_KEY });
  try {
    await mcp.init();
    let r = await mcp.call('odoo_check_connection');
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Method:\s+JSON-2 API \(API key\)/);
    assert.match(r.text, /Database:\s+prod19 \(configured\)/);
    r = await mcp.call('odoo_search_read', { model: 'res.partner', domain: [['country_id.code', '=', 'US']], fields: ['name'] });
    assert.ok(!r.isError && r.text.startsWith('2 records'), r.text);
    r = await mcp.call('odoo_create', { model: 'sale.order', values: { name: 'S00099', partner_id: 11, amount_total: 1, state: 'draft' } });
    assert.ok(!r.isError && /Created sale\.order record id \d+/.test(r.text), r.text);
    const id = parseInt(/id (\d+)/.exec(r.text)[1], 10);
    r = await mcp.call('odoo_write', { model: 'sale.order', ids: [id], values: { amount_total: 42 } });
    assert.ok(!r.isError, r.text);
    r = await mcp.call('odoo_call', { model: 'sale.order', method: 'action_confirm', ids: [id] });
    assert.ok(!r.isError, r.text);
    r = await mcp.call('odoo_read', { model: 'sale.order', ids: [id], fields: ['state', 'amount_total'] });
    assert.ok(r.text.includes('"state":"sale"') && r.text.includes('"amount_total":42'), r.text);
    r = await mcp.call('odoo_group_by', { model: 'sale.order', groupby: ['state'] });
    assert.ok(!r.isError && r.text.includes('"__count"'), r.text);
    r = await mcp.call('odoo_delete', { model: 'sale.order', ids: [id], confirm: true });
    assert.ok(!r.isError, r.text);
    r = await mcp.call('odoo_call', { model: 'res.partner', method: 'some_method', args: ['positional'] });
    assert.ok(r.isError && /named arguments/.test(r.text), r.text);
  } finally { await mcp.close(); mock.stop(); }
});

scenario('odoo19 api key without database name: falls back to the server default database over JSON-2', async () => {
  const mock = await startMock({ MOCK_VERSION: '19.0+e', MOCK_MONODB: '1', MOCK_LIST_DB: '0', MOCK_DBS: 'hidden-name', MOCK_LEGACY: '1' });
  const t = await runTestMode({ ODOO_URL: mock.url, ODOO_LOGIN: LOGIN, ODOO_PASSWORD: API_KEY });
  mock.stop();
  assert.equal(t.code, 0, t.out + t.err);
  assert.equal(t.json.ok, true);
  assert.equal(t.json.database, '(server default)');
  assert.equal(t.json.transport, 'JSON-2 API (API key)');
});

scenario('odoo17 api key: legacy JSON-RPC transport', async () => {
  const mock = await startMock({ MOCK_VERSION: 'saas~17.4+e', MOCK_MONODB: '1', MOCK_LIST_DB: '0', MOCK_DBS: 'mycompany' });
  const mcp = new McpClient({ ODOO_URL: mock.url, ODOO_DB: 'mycompany', ODOO_LOGIN: LOGIN, ODOO_PASSWORD: API_KEY });
  try {
    await mcp.init();
    let r = await mcp.call('odoo_check_connection');
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Method:\s+JSON-RPC/);
    assert.match(r.text, /Odoo:\s+saas~17\.4 Enterprise/);
    r = await mcp.call('odoo_search_read', { model: 'sale.order', fields: ['name', 'state'], order: 'name desc', limit: 1 });
    assert.ok(r.text.includes('"name":"S00003"'), r.text);
    r = await mcp.call('odoo_record_link', { model: 'sale.order', id: 1 });
    assert.equal(r.text, `${mock.url}/odoo/sale.order/1`, 'saas~17.4 is newer than 17.2 so it uses /odoo/ links');
  } finally { await mcp.close(); mock.stop(); }
});

scenario('read-only mode blocks changes but allows reads and actions are refused with a clear message', async () => {
  const mock = await startMock({ MOCK_VERSION: '18.0+e', MOCK_DBS: 'ro' });
  const mcp = new McpClient({ ODOO_URL: mock.url, ODOO_DB: 'ro', ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD, ODOO_READ_ONLY: 'true' });
  try {
    await mcp.init();
    let r = await mcp.call('odoo_check_connection');
    assert.match(r.text, /Access:\s+read-only/);
    r = await mcp.call('odoo_search_read', { model: 'res.partner', fields: ['name'], limit: 1 });
    assert.ok(!r.isError, r.text);
    r = await mcp.call('odoo_create', { model: 'res.partner', values: { name: 'x' } });
    assert.ok(r.isError && /read-only mode/.test(r.text), r.text);
    r = await mcp.call('odoo_call', { model: 'sale.order', method: 'action_confirm', ids: [1] });
    assert.ok(r.isError && /read-only mode/.test(r.text), r.text);
    r = await mcp.call('odoo_call', { model: 'sale.order', method: 'name_search', kwargs: { name: 'S000' } });
    assert.ok(!r.isError, r.text);
  } finally { await mcp.close(); mock.stop(); }
});

scenario('wrong password: all transports tried, helpful message, exit code 5', async () => {
  const mock = await startMock({ MOCK_VERSION: '19.0+e', MOCK_DBS: 'db1' });
  const t = await runTestMode({ ODOO_URL: mock.url, ODOO_DB: 'db1', ODOO_LOGIN: LOGIN, ODOO_PASSWORD: 'wrong' });
  mock.stop();
  assert.equal(t.code, 5, t.out + t.err);
  assert.equal(t.json.kind, 'auth');
  assert.match(t.json.message, /rejected the login for "jane@example\.com" on database "db1"/);
  assert.match(t.json.message, /API key/);
  assert.match(t.json.tried, /web: login refused.*json2: not accepted as an API key.*jsonrpc: login refused/);
});

scenario('two-factor authentication: explains that an API key is needed, exit code 6', async () => {
  const mock = await startMock({ MOCK_VERSION: '18.0+e', MOCK_MONODB: '1', MOCK_LIST_DB: '0', MOCK_DBS: 'mfa-co', MOCK_MFA: '1' });
  const t = await runTestMode({ ODOO_URL: mock.url, ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD });
  mock.stop();
  assert.equal(t.code, 6, t.out + t.err);
  assert.equal(t.json.kind, 'mfa');
  assert.match(t.json.message, /two-factor authentication.*New API Key/s);
});

scenario('wrong database name: exit code 4 with the list of databases', async () => {
  const mock = await startMock({ MOCK_VERSION: '18.0+e', MOCK_LIST_DB: '1', MOCK_DBS: 'alpha,beta' });
  const t = await runTestMode({ ODOO_URL: mock.url, ODOO_DB: 'gamma', ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD });
  mock.stop();
  assert.equal(t.code, 4, t.out + t.err);
  assert.match(t.json.message, /The database "gamma" was not found/);
  const mock2 = await startMock({ MOCK_VERSION: '18.0+e', MOCK_LIST_DB: '1', MOCK_MONODB: '0', MOCK_DBS: 'alpha,beta' });
  const t2 = await runTestMode({ ODOO_URL: mock2.url, ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD });
  mock2.stop();
  assert.equal(t2.code, 0, 'with several listed databases the first one that accepts the login is used: ' + t2.out + t2.err);
  assert.equal(t2.json.database, 'alpha');
});

scenario('address without scheme and with a path, plus a redirect to another port, are handled', async () => {
  const redirectPort = await freePort();
  const mock = await startMock({ MOCK_VERSION: '18.0+e', MOCK_DBS: 'redir', MOCK_REDIRECT_PORT: String(redirectPort) });
  const t = await runTestMode({ ODOO_URL: `127.0.0.1:${redirectPort}/odoo/action-123`, ODOO_DB: 'redir', ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD });
  mock.stop();
  assert.equal(t.code, 2, 'http:// is required for plain addresses because https is assumed: ' + t.out + t.err);
  const mock2 = await startMock({ MOCK_VERSION: '18.0+e', MOCK_DBS: 'redir', MOCK_REDIRECT_PORT: String(await freePort()) });
  const t2 = await runTestMode({ ODOO_URL: `http://127.0.0.1:${mock2.redirectPort}/web/login`, ODOO_DB: 'redir', ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD });
  mock2.stop();
  assert.equal(t2.code, 0, t2.out + t2.err);
  assert.equal(t2.json.url, mock2.url, 'the redirect target becomes the base address');
});

scenario('expired web session is renewed transparently', async () => {
  const mock = await startMock({ MOCK_VERSION: '18.0+e', MOCK_DBS: 'exp', MOCK_EXPIRE_AFTER: '2' });
  const mcp = new McpClient({ ODOO_URL: mock.url, ODOO_DB: 'exp', ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD });
  try {
    await mcp.init();
    for (let i = 0; i < 5; i++) {
      const r = await mcp.call('odoo_count', { model: 'res.partner' });
      assert.ok(!r.isError, `call ${i}: ${r.text}`);
    }
    assert.match(mcp.stderr + '', /.*/);
  } finally { await mcp.close(); mock.stop(); }
});

scenario('not an Odoo server / unreachable server / missing configuration', async () => {
  const mock = await startMock({ MOCK_PLAIN_HTML: '1' });
  const t = await runTestMode({ ODOO_URL: mock.url, ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD });
  mock.stop();
  assert.equal(t.code, 3, t.out + t.err);
  assert.match(t.json.message, /does not look like an Odoo server/);

  const port = await freePort();
  const t2 = await runTestMode({ ODOO_URL: `http://127.0.0.1:${port}`, ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD });
  assert.equal(t2.code, 2, t2.out + t2.err);
  assert.match(t2.json.message, /refused the connection/);

  const t3 = await runTestMode({ ODOO_URL: '', ODOO_LOGIN: '', ODOO_PASSWORD: '' });
  assert.equal(t3.code, 10, t3.out + t3.err);
  assert.match(t3.json.message, /not configured yet/);

  // The MCP server must still start and answer when unconfigured, so Claude can explain the problem.
  const mcp = new McpClient({});
  try {
    await mcp.init();
    const r = await mcp.call('odoo_search_read', { model: 'res.partner' });
    assert.ok(r.isError && /not configured yet/.test(r.text), r.text);
  } finally { await mcp.close(); }
});

scenario('configuration file fallback with the password containing quotes', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-app-test-'));
  const cfgFile = path.join(dir, 'config.json');
  const mock = await startMock({ MOCK_VERSION: '18.0+e', MOCK_DBS: 'cfg' });
  try {
    const setup = spawn(process.execPath, [path.join(here, '..', 'server', 'setup.js'), 'save-config', '--dir', dir], { env: { ...process.env, ODOO_URL: mock.url, ODOO_LOGIN: LOGIN, ODOO_PASSWORD: PASSWORD, ODOO_DB: 'cfg', ODOO_READ_ONLY: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    setup.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((r) => setup.on('exit', r));
    assert.equal(code, 0);
    assert.equal(out.trim(), cfgFile);
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.equal(saved.password, PASSWORD);
    const t = await runTestMode({ ODOO_CONFIG_FILE: cfgFile });
    assert.equal(t.code, 0, t.out + t.err);
    assert.equal(t.json.database, 'cfg');

    // read-config
    const rc = spawn(process.execPath, [path.join(here, '..', 'server', 'setup.js'), 'read-config', '--dir', dir, '--key', 'login'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let rcOut = '';
    rc.stdout.on('data', (d) => { rcOut += d; });
    await new Promise((r) => rc.on('exit', r));
    assert.equal(rcOut.trim(), LOGIN);

    // claude-desktop config merge keeps other servers
    const desktopFile = path.join(dir, 'claude_desktop_config.json');
    fs.writeFileSync(desktopFile, JSON.stringify({ mcpServers: { other: { command: 'x' } }, preferences: { theme: 'dark' } }));
    const cd = spawn(process.execPath, [path.join(here, '..', 'server', 'setup.js'), 'claude-desktop', '--file', desktopFile, '--node', '/usr/bin/node', '--server', '/srv/index.js', '--config', cfgFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((r) => cd.on('exit', r));
    const merged = JSON.parse(fs.readFileSync(desktopFile, 'utf8'));
    assert.deepEqual(merged.mcpServers.other, { command: 'x' });
    assert.deepEqual(merged.preferences, { theme: 'dark' });
    assert.deepEqual(merged.mcpServers.odoo, { command: '/usr/bin/node', args: ['/srv/index.js'], env: { ODOO_CONFIG_FILE: cfgFile } });
    assert.ok(fs.existsSync(desktopFile + '.bak'));
    const rm = spawn(process.execPath, [path.join(here, '..', 'server', 'setup.js'), 'claude-desktop', '--file', desktopFile, '--remove'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((r) => rm.on('exit', r));
    assert.equal(JSON.parse(fs.readFileSync(desktopFile, 'utf8')).mcpServers.odoo, undefined);
  } finally {
    mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
let failed = 0;
const selected = scenarios.filter((s) => s.name.includes(filter));
for (const s of selected) {
  const started = Date.now();
  try {
    await s.fn();
    console.log(`PASS  ${s.name}  (${Date.now() - started} ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${s.name}\n      ${(e && e.stack || e).toString().split('\n').join('\n      ')}`);
  }
}
console.log(`\n${selected.length - failed}/${selected.length} scenarios passed`);
process.exit(failed ? 1 : 0);
