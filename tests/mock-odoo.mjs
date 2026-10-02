// A small fake Odoo server used by the automated tests.
// It emulates the parts of Odoo's HTTP API that the connector relies on, for several
// Odoo versions and deployment shapes, so the real behaviour can be tested offline.
//
// Configuration (environment variables):
//   MOCK_PORT          port to listen on (default 0 = random). The chosen port is printed as JSON on stdout.
//   MOCK_VERSION       e.g. "18.0+e", "16.0", "20.0+e", "saas~17.4+e" (default "18.0+e")
//   MOCK_DBS           comma separated database names (default "testdb")
//   MOCK_LIST_DB       "1" to allow /web/database/list and db.list (default "0")
//   MOCK_MONODB        "1" if /web/login renders the login form (single database host), "0" redirects to the selector (default "1")
//   MOCK_LEGACY        "1" if /jsonrpc is available (default "1")
//   MOCK_JSON2         "1" if /json/2 is available (default: 1 when version >= 19)
//   MOCK_LOGIN         accepted login (default "admin@example.com")
//   MOCK_PASSWORD      accepted password (default "secret")
//   MOCK_API_KEY       accepted API key (default "k3y-abcdef0123456789")
//   MOCK_MFA           "1" if the user has two-factor authentication (password logins become incomplete)
//   MOCK_EXPIRE_AFTER  number of call_kw requests after which the web session expires once (default 0 = never)
//   MOCK_PLAIN_HTML    "1" to answer every request with a plain HTML page (not an Odoo server)
//   MOCK_REDIRECT_PORT if set, a second listener on this port that 308-redirects everything to the main server
import http from 'node:http';
import { URL } from 'node:url';

const env = process.env;
const VERSION = env.MOCK_VERSION || '18.0+e';
const DBS = (env.MOCK_DBS || 'testdb').split(',').map((s) => s.trim()).filter(Boolean);
const LIST_DB = env.MOCK_LIST_DB === '1';
const MONODB = (env.MOCK_MONODB ?? '1') === '1';
const LEGACY = (env.MOCK_LEGACY ?? '1') === '1';
const major = parseInt(VERSION.replace(/^saas~/, ''), 10);
const JSON2 = (env.MOCK_JSON2 ?? (major >= 19 ? '1' : '0')) === '1';
const LOGIN = env.MOCK_LOGIN || 'admin@example.com';
const PASSWORD = env.MOCK_PASSWORD || 'secret';
const API_KEY = env.MOCK_API_KEY || 'k3y-abcdef0123456789';
const MFA = env.MOCK_MFA === '1';
const EXPIRE_AFTER = parseInt(env.MOCK_EXPIRE_AFTER || '0', 10);
const PLAIN_HTML = env.MOCK_PLAIN_HTML === '1';

function versionInfo() {
  const m = /^(saas~)?(\d+)\.(\d+)(\+e)?$/.exec(VERSION);
  const first = m[1] ? `saas~${m[2]}` : parseInt(m[2], 10);
  return { server_version: VERSION, server_version_info: [first, parseInt(m[3], 10), 0, 'final', 0, m[4] ? 'e' : ''], server_serie: `${m[2]}.${m[3]}` };
}

// ----------------------------------------------------------------------------
// Tiny in-memory ORM
// ----------------------------------------------------------------------------
const MODELS = {
  'res.country': { fields: { name: { type: 'char', string: 'Country Name', required: true }, code: { type: 'char', string: 'Country Code' } }, records: [
    { id: 1, name: 'Belgium', code: 'BE' }, { id: 2, name: 'United States', code: 'US' }, { id: 3, name: 'France', code: 'FR' },
  ] },
  'res.company': { fields: { name: { type: 'char', string: 'Company Name', required: true } }, records: [{ id: 1, name: 'Mock Company' }] },
  'res.users': { fields: { name: { type: 'char', string: 'Name', required: true }, login: { type: 'char', string: 'Login', required: true }, company_id: { type: 'many2one', string: 'Company', relation: 'res.company' }, partner_id: { type: 'many2one', string: 'Related Partner', relation: 'res.partner' } }, records: [
    { id: 2, name: 'Mock Admin', login: LOGIN, company_id: 1, partner_id: 3 },
  ] },
  'res.partner': { fields: {
    name: { type: 'char', string: 'Name', required: true }, email: { type: 'char', string: 'Email' }, phone: { type: 'char', string: 'Phone' },
    is_company: { type: 'boolean', string: 'Is a Company' }, country_id: { type: 'many2one', string: 'Country', relation: 'res.country' },
    active: { type: 'boolean', string: 'Active' }, image_1920: { type: 'binary', string: 'Image' }, comment: { type: 'html', string: 'Notes' },
    child_ids: { type: 'one2many', string: 'Contacts', relation: 'res.partner' }, category_id: { type: 'many2many', string: 'Tags', relation: 'res.partner.category' },
    type: { type: 'selection', string: 'Address Type', selection: [['contact', 'Contact'], ['invoice', 'Invoice Address'], ['delivery', 'Delivery Address']] },
    create_date: { type: 'datetime', string: 'Created on', readonly: true },
  }, records: [
    { id: 1, name: 'Mock Company', email: 'info@mock.example', phone: '+32 2 000 0000', is_company: true, country_id: 1, active: true, type: 'contact', create_date: '2026-01-01 10:00:00' },
    { id: 3, name: 'Mock Admin', email: LOGIN, phone: false, is_company: false, country_id: 1, active: true, type: 'contact', create_date: '2026-01-01 10:00:00' },
    { id: 10, name: 'Azure Interior', email: 'azure@example.com', phone: '+1 555 0100', is_company: true, country_id: 2, active: true, type: 'contact', create_date: '2026-02-01 09:00:00' },
    { id: 11, name: 'Deco Addict', email: 'deco@example.com', phone: '+1 555 0101', is_company: true, country_id: 2, active: true, type: 'contact', create_date: '2026-02-02 09:00:00' },
    { id: 12, name: 'Gemini Furniture', email: 'gemini@example.com', phone: '+33 1 00 00 00', is_company: true, country_id: 3, active: true, type: 'contact', create_date: '2026-02-03 09:00:00' },
    { id: 13, name: 'Old Customer', email: 'old@example.com', phone: false, is_company: true, country_id: 3, active: false, type: 'contact', create_date: '2025-02-03 09:00:00' },
  ] },
  'sale.order': { fields: {
    name: { type: 'char', string: 'Order Reference', required: true }, partner_id: { type: 'many2one', string: 'Customer', relation: 'res.partner', required: true },
    amount_total: { type: 'monetary', string: 'Total' }, state: { type: 'selection', string: 'Status', selection: [['draft', 'Quotation'], ['sent', 'Quotation Sent'], ['sale', 'Sales Order'], ['cancel', 'Cancelled']] },
    date_order: { type: 'datetime', string: 'Order Date' },
  }, records: [
    { id: 1, name: 'S00001', partner_id: 10, amount_total: 1500.0, state: 'sale', date_order: '2026-03-01 10:00:00' },
    { id: 2, name: 'S00002', partner_id: 10, amount_total: 250.5, state: 'draft', date_order: '2026-03-05 10:00:00' },
    { id: 3, name: 'S00003', partner_id: 11, amount_total: 9800.0, state: 'sale', date_order: '2026-03-07 10:00:00' },
  ] },
  'ir.model': { fields: { model: { type: 'char', string: 'Model' }, name: { type: 'char', string: 'Model Description' }, transient: { type: 'boolean', string: 'Transient Model' } }, records: [
    { id: 1, model: 'res.partner', name: 'Contact', transient: false }, { id: 2, model: 'sale.order', name: 'Sales Order', transient: false },
    { id: 3, model: 'sale.order.line', name: 'Sales Order Line', transient: false }, { id: 4, model: 'sale.advance.payment.inv', name: 'Sales Advance Payment Invoice', transient: true },
    { id: 5, model: 'res.users', name: 'User', transient: false }, { id: 6, model: 'account.move', name: 'Journal Entry', transient: false },
  ] },
};
let nextId = 1000;
const calls = [];

class RpcError extends Error {
  constructor(name, message, code) { super(message); this.odooName = name; this.code = code === undefined ? 200 : code; }
}

function m2o(model, id) {
  if (!id) return false;
  const rel = MODELS[model];
  const rec = rel && rel.records.find((r) => r.id === id);
  return rec ? [id, rec.name] : false;
}
function displayName(model, rec) { return rec.name || rec.display_name || `${model},${rec.id}`; }

function fieldValue(model, rec, field) {
  const parts = field.split('.');
  const def = MODELS[model].fields[parts[0]];
  if (parts[0] === 'id') return rec.id;
  if (parts[0] === 'display_name') return displayName(model, rec);
  if (!def) throw new RpcError('builtins.ValueError', `Invalid field '${parts[0]}' on '${model}'`);
  let v = rec[parts[0]];
  if (def.type === 'many2one' && parts.length > 1) {
    const relRec = MODELS[def.relation].records.find((r) => r.id === v);
    return relRec ? fieldValue(def.relation, relRec, parts.slice(1).join('.')) : false;
  }
  return v === undefined ? false : v;
}

function matches(model, rec, domain) {
  // Evaluate a prefix-notation domain.
  const stack = [];
  const items = [...domain].reverse();
  const evalLeaf = ([field, op, value]) => {
    let v = fieldValue(model, rec, field);
    const def = MODELS[model].fields[field.split('.')[0]];
    if (def && def.type === 'many2one' && !field.includes('.') && typeof value === 'string') {
      // comparing a many2one with a string compares the display name
      const rel = MODELS[def.relation].records.find((r) => r.id === v);
      v = rel ? rel.name : false;
    }
    switch (op) {
      case '=': return v === value || (v === false && (value === false || value === null));
      case '!=': return !(v === value);
      case 'ilike': return String(v || '').toLowerCase().includes(String(value).toLowerCase().replace(/%/g, ''));
      case 'like': return String(v || '').includes(String(value).replace(/%/g, ''));
      case 'not ilike': return !String(v || '').toLowerCase().includes(String(value).toLowerCase());
      case 'in': return Array.isArray(value) && value.includes(v);
      case 'not in': return Array.isArray(value) && !value.includes(v);
      case '>': return v > value; case '>=': return v >= value; case '<': return v < value; case '<=': return v <= value;
      default: throw new RpcError('builtins.ValueError', `Invalid operator ${op}`);
    }
  };
  for (const it of items) {
    if (it === '&') { const a = stack.pop(), b = stack.pop(); stack.push(a && b); }
    else if (it === '|') { const a = stack.pop(), b = stack.pop(); stack.push(a || b); }
    else if (it === '!') { stack.push(!stack.pop()); }
    else stack.push(evalLeaf(it));
  }
  while (stack.length > 1) { const a = stack.pop(), b = stack.pop(); stack.push(a && b); }
  return stack.length ? stack[0] : true;
}

function search(model, domain, kwargs = {}) {
  const def = MODELS[model];
  const activeTest = !(kwargs.context && kwargs.context.active_test === false) && !!def.fields.active && !domain.some((d) => Array.isArray(d) && d[0] === 'active');
  let recs = def.records.filter((r) => matches(model, r, domain || []));
  if (activeTest) recs = recs.filter((r) => r.active !== false);
  if (kwargs.order) {
    const [f, dir] = kwargs.order.split(/\s+/);
    recs.sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * (dir && dir.toLowerCase() === 'desc' ? -1 : 1));
  }
  const offset = kwargs.offset || 0;
  recs = recs.slice(offset, kwargs.limit ? offset + kwargs.limit : undefined);
  return recs;
}

function readRecs(model, recs, fields) {
  const def = MODELS[model];
  const names = fields && fields.length ? fields : ['id', 'display_name', ...Object.keys(def.fields)];
  return recs.map((r) => {
    const out = { id: r.id };
    for (const f of names) {
      if (f === 'id') continue;
      if (f === 'display_name') { out.display_name = displayName(model, r); continue; }
      const fd = def.fields[f];
      if (!fd) throw new RpcError('builtins.ValueError', `Invalid field '${f}' on '${model}'`);
      let v = r[f];
      if (fd.type === 'many2one') v = m2o(fd.relation, v);
      else if (fd.type === 'one2many' || fd.type === 'many2many') v = Array.isArray(v) ? v : [];
      else if (v === undefined) v = false;
      out[f] = v;
    }
    return out;
  });
}

function callMethod(model, method, args, kwargs, ctx) {
  calls.push({ model, method, args, kwargs, transport: ctx.transport });
  if (model === 'res.users' && method === 'context_get') return { lang: 'en_US', tz: 'Europe/Brussels', uid: 2 };
  const def = MODELS[model];
  if (!def) throw new RpcError('werkzeug.exceptions.NotFound', '404 Not Found: The requested URL was not found on the server.', 404);
  const pos = (i, name) => (kwargs[name] !== undefined ? kwargs[name] : args[i]);
  switch (method) {
    case 'fields_get': {
      const attrs = pos(1, 'attributes');
      const only = pos(0, 'allfields');
      const out = {};
      const all = Object.assign({ id: { type: 'integer', string: 'ID', readonly: true }, display_name: { type: 'char', string: 'Display Name', readonly: true } }, def.fields);
      for (const [n, f] of Object.entries(all)) {
        if (only && only.length && !only.includes(n)) continue;
        const full = Object.assign({ required: false, readonly: false, help: '' }, f);
        out[n] = attrs ? Object.fromEntries(attrs.filter((a) => full[a] !== undefined).map((a) => [a, full[a]])) : full;
      }
      return out;
    }
    case 'search_read': return readRecs(model, search(model, pos(0, 'domain') || [], kwargs), pos(1, 'fields'));
    case 'search': return search(model, pos(0, 'domain') || [], kwargs).map((r) => r.id);
    case 'search_count': return search(model, pos(0, 'domain') || pos(0, 'args') || [], { context: kwargs.context }).length;
    case 'read': {
      const ids = pos(0, 'ids');
      return readRecs(model, def.records.filter((r) => ids.includes(r.id)), pos(1, 'fields'));
    }
    case 'name_search': {
      const name = pos(0, 'name') || '';
      const recs = def.records.filter((r) => displayName(model, r).toLowerCase().includes(String(name).toLowerCase())).slice(0, kwargs.limit || 100);
      return recs.map((r) => [r.id, displayName(model, r)]);
    }
    case 'name_get': { const ids = pos(0, 'ids'); return def.records.filter((r) => ids.includes(r.id)).map((r) => [r.id, displayName(model, r)]); }
    case 'create': {
      let vals = pos(0, 'vals_list');
      if (vals === undefined) throw new RpcError('builtins.TypeError', `${model}.create() missing 1 required positional argument: 'vals_list'`);
      const list = Array.isArray(vals) ? vals : [vals];
      const ids = [];
      for (const v of list) {
        for (const [k, fd] of Object.entries(def.fields)) if (fd.required && (v[k] === undefined || v[k] === false)) throw new RpcError('odoo.exceptions.ValidationError', `The field '${fd.string}' is required`);
        const rec = Object.assign({ id: nextId++, active: true }, v);
        def.records.push(rec); ids.push(rec.id);
      }
      return Array.isArray(vals) ? ids : ids[0];
    }
    case 'write': {
      const ids = pos(0, 'ids'); const vals = pos(1, 'vals');
      if (!vals) throw new RpcError('builtins.TypeError', `${model}.write() missing 1 required positional argument: 'vals'`);
      for (const r of def.records) if (ids.includes(r.id)) Object.assign(r, vals);
      return true;
    }
    case 'unlink': { const ids = pos(0, 'ids'); def.records = def.records.filter((r) => !ids.includes(r.id)); return true; }
    case 'formatted_read_group': {
      if (major < 18) throw new RpcError('builtins.AttributeError', `The method '${model}.formatted_read_group' does not exist`);
      const domain = pos(0, 'domain') || []; const groupby = pos(1, 'groupby') || []; const aggs = pos(2, 'aggregates') || ['__count'];
      return groupRows(model, domain, groupby, aggs, true);
    }
    case 'read_group': {
      if (major >= 20) throw new RpcError('builtins.TypeError', "BaseModel.read_group() got an unexpected keyword argument 'fields'");
      const domain = pos(0, 'domain') || []; const fields = pos(1, 'fields') || []; const groupby = pos(2, 'groupby') || [];
      return groupRows(model, domain, groupby, fields, false);
    }
    case 'action_confirm': {
      const ids = pos(0, 'ids');
      for (const r of def.records) if (ids.includes(r.id)) r.state = 'sale';
      return true;
    }
    default:
      throw new RpcError('builtins.AttributeError', `The method '${model}.${method}' does not exist`);
  }
}

function groupRows(model, domain, groupby, aggs, formatted) {
  const recs = search(model, domain, {});
  const def = MODELS[model];
  const groups = new Map();
  for (const r of recs) {
    const key = groupby.map((g) => { const f = g.split(':')[0]; const v = r[f]; return def.fields[f].type === 'many2one' ? JSON.stringify(m2o(def.fields[f].relation, v)) : JSON.stringify(v === undefined ? false : v); }).join('|');
    if (!groups.has(key)) groups.set(key, { recs: [], keys: groupby.map((g) => { const f = g.split(':')[0]; const v = r[f]; return def.fields[f].type === 'many2one' ? m2o(def.fields[f].relation, v) : (v === undefined ? false : v); }) });
    groups.get(key).recs.push(r);
  }
  const rows = [];
  for (const g of groups.values()) {
    const row = {};
    groupby.forEach((gb, i) => { row[gb] = g.keys[i]; });
    if (formatted) row.__count = g.recs.length; else { row.__count = g.recs.length; row[`${groupby[0].split(':')[0]}_count`] = g.recs.length; }
    for (const a of aggs) {
      if (a === '__count') continue;
      const [f, fn] = a.split(':');
      const vals = g.recs.map((r) => Number(r[f]) || 0);
      const res = fn === 'avg' ? vals.reduce((x, y) => x + y, 0) / vals.length : fn === 'min' ? Math.min(...vals) : fn === 'max' ? Math.max(...vals) : fn === 'count' ? vals.length : vals.reduce((x, y) => x + y, 0);
      row[formatted ? a : f] = res;
    }
    if (formatted) row.__extra_domain = groupby.map((gb, i) => [gb.split(':')[0], '=', Array.isArray(g.keys[i]) ? g.keys[i][0] : g.keys[i]]);
    else row.__domain = [];
    rows.push(row);
  }
  return rows;
}

// ----------------------------------------------------------------------------
// HTTP plumbing
// ----------------------------------------------------------------------------
const sessions = new Map(); // session_id -> { db, uid, pre, callCount }
let sidCounter = 0;
function newSession(data) { const sid = `sid${++sidCounter}_${Math.random().toString(36).slice(2)}`; sessions.set(sid, Object.assign({ callCount: 0 }, data)); return sid; }
function cookieSid(req) { const m = /session_id=([^;]+)/.exec(req.headers.cookie || ''); return m ? m[1] : null; }

function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); }); }

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }, extraHeaders || {}));
  res.end(body);
}
function sendHtml(res, status, html, extraHeaders) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, extraHeaders || {}));
  res.end(html);
}
const NOT_FOUND_HTML = '<!DOCTYPE html><html><body><h1>Not Found</h1><p>No database is selected and the requested URL is not server-wide.</p></body></html>';
function rpcOk(res, id, result, headers) { sendJson(res, 200, { jsonrpc: '2.0', id, result }, headers); }
function rpcErr(res, id, err) {
  const name = err.odooName || 'builtins.Exception';
  const code = err.code === 404 ? 404 : (name.includes('SessionExpired') ? 100 : 200);
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message: code === 404 ? '404: Not Found' : 'Odoo Server Error', data: { name, message: err.message, arguments: [err.message], context: {}, debug: `Traceback (most recent call last):\n${name}: ${err.message}\n` } } });
}

function checkCredentials(login, password) {
  if (login !== LOGIN) return 'denied';
  if (password === PASSWORD) return MFA ? 'mfa' : 'ok';
  if (password === API_KEY) return 'apikey';
  return 'denied';
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (PLAIN_HTML) return sendHtml(res, 200, '<!DOCTYPE html><html><body><h1>Welcome to our website</h1></body></html>');

  // ---- server-wide routes
  if (p === '/web/webclient/version_info') { const b = JSON.parse(await readBody(req) || '{}'); return rpcOk(res, b.id, versionInfo()); }
  if (p === '/web/health') return sendJson(res, 200, { status: 'pass' });
  if (p === '/web/database/list') {
    const b = JSON.parse(await readBody(req) || '{}');
    if (!LIST_DB) return rpcErr(res, b.id, new RpcError('odoo.exceptions.AccessDenied', 'Access Denied'));
    return rpcOk(res, b.id, DBS);
  }
  if (p === '/web/session/authenticate') {
    const b = JSON.parse(await readBody(req) || '{}');
    const { db, login, password } = b.params || {};
    if (!DBS.includes(db)) return rpcErr(res, b.id, new RpcError('odoo.exceptions.AccessError', 'Database not found.'));
    const c = checkCredentials(login, password);
    if (c === 'denied' || c === 'apikey') return rpcErr(res, b.id, new RpcError('odoo.exceptions.AccessDenied', 'Access Denied'));
    if (c === 'mfa') { const sid = newSession({ db, pre: true }); return rpcOk(res, b.id, { uid: null }, { 'Set-Cookie': `session_id=${sid}; Path=/; HttpOnly` }); }
    const sid = newSession({ db, uid: 2 });
    const u = MODELS['res.users'].records[0];
    const result = { uid: 2, is_system: true, is_admin: true, user_context: { lang: 'en_US', tz: 'Europe/Brussels', uid: 2 }, db, server_version: VERSION, server_version_info: versionInfo().server_version_info, name: u.name, username: u.login, partner_id: u.partner_id, user_companies: major >= 15 ? { current_company: 1, allowed_companies: { 1: { id: 1, name: 'Mock Company' } } } : { current_company: [1, 'Mock Company'], allowed_companies: [[1, 'Mock Company']] } };
    return rpcOk(res, b.id, result, { 'Set-Cookie': `session_id=${sid}; Expires=Fri, 01 Jan 2027 00:00:00 GMT; Max-Age=604800; HttpOnly; Path=/; SameSite=Lax` });
  }

  // ---- web login form (used for database discovery on single-database hosts)
  if (p === '/web/login' && req.method === 'GET') {
    if (!MONODB && !url.searchParams.get('db')) { res.writeHead(303, { Location: '/web/database/selector' }); return res.end(); }
    const sid = cookieSid(req) && sessions.has(cookieSid(req)) ? cookieSid(req) : newSession({ db: DBS[0], pre: true });
    sessions.get(sid).csrf = 'csrf-' + sid;
    return sendHtml(res, 200, `<!DOCTYPE html><html><head><script>var odoo = { csrf_token: "csrf-${sid}", debug: "" };</script></head><body><form class="oe_login_form" method="post"><input type="hidden" name="csrf_token" value="csrf-${sid}"/><input name="login"/><input name="password" type="password"/></form></body></html>`, { 'Set-Cookie': `session_id=${sid}; Path=/; HttpOnly` });
  }
  if (p === '/web/login' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const sid = cookieSid(req);
    const s = sid && sessions.get(sid);
    if (!s || form.get('csrf_token') !== s.csrf) return sendHtml(res, 400, '<html><body>Invalid CSRF token</body></html>');
    const c = checkCredentials(form.get('login'), form.get('password'));
    if (c === 'ok') {
      s.uid = 2; s.pre = false; s.db = DBS[0];
      // Odoo 14 and older answer a successful login with a page that redirects by script, not with an HTTP redirect.
      if (major <= 14) return sendHtml(res, 200, `<html><head><script>window.location = '${form.get('redirect') || '/web'}' + location.hash;</script></head></html>`);
      res.writeHead(303, { Location: form.get('redirect') || '/web' }); return res.end();
    }
    if (c === 'mfa') { res.writeHead(303, { Location: '/web/login/totp' }); return res.end(); }
    return sendHtml(res, 200, '<!DOCTYPE html><html><body><form class="oe_login_form"><input type="hidden" name="csrf_token" value="' + s.csrf + '"/><p class="alert alert-danger">Wrong login/password</p></form></body></html>');
  }

  // ---- legacy JSON-RPC
  if (p === '/jsonrpc') {
    const sid = cookieSid(req);
    const hasDb = MONODB || (sid && sessions.has(sid));
    if (!LEGACY || !hasDb) return sendHtml(res, 404, NOT_FOUND_HTML);
    const b = JSON.parse(await readBody(req) || '{}');
    const { service, method, args } = b.params || {};
    try {
      if (service === 'common' && method === 'version') return rpcOk(res, b.id, Object.assign(versionInfo(), { protocol_version: 1 }));
      if (service === 'common' && method === 'authenticate' || service === 'common' && method === 'login') {
        const [db, login, password] = args;
        if (!DBS.includes(db)) throw new RpcError('psycopg2.OperationalError', `FATAL:  database "${db}" does not exist\n`);
        const c = checkCredentials(login, password);
        if (c === 'ok' || c === 'apikey') return rpcOk(res, b.id, 2);
        if (c === 'mfa') throw new RpcError('odoo.exceptions.AccessDenied', 'Access Denied');
        throw new RpcError('odoo.exceptions.AccessDenied', 'Access Denied');
      }
      if (service === 'db' && method === 'list') { if (!LIST_DB) throw new RpcError('odoo.exceptions.AccessDenied', 'Access Denied'); return rpcOk(res, b.id, DBS); }
      if (service === 'object' && method === 'execute_kw') {
        const [db, uid, password, model, meth, margs, mkwargs] = args;
        if (!DBS.includes(db)) throw new RpcError('psycopg2.OperationalError', `FATAL:  database "${db}" does not exist\n`);
        const c = checkCredentials(LOGIN, password);
        if (uid !== 2 || !(c === 'ok' || c === 'apikey')) throw new RpcError('odoo.exceptions.AccessDenied', 'Access Denied');
        return rpcOk(res, b.id, callMethod(model, meth, margs || [], mkwargs || {}, { transport: 'jsonrpc' }));
      }
      throw new RpcError('builtins.Exception', `Unknown service/method ${service}.${method}`);
    } catch (e) { return rpcErr(res, b.id, e instanceof RpcError ? e : new RpcError('builtins.Exception', e.message)); }
  }

  // ---- JSON-2
  const j2 = /^\/json\/2\/([^/]+)\/([^/]+)$/.exec(p);
  if (j2) {
    if (!JSON2) return sendHtml(res, 404, NOT_FOUND_HTML);
    const auth = req.headers.authorization || '';
    const m = /^bearer\s+(.+)$/i.exec(auth);
    const dbh = req.headers['x-odoo-database'];
    if (dbh && !DBS.includes(dbh)) return sendJson(res, 404, { name: 'werkzeug.exceptions.NotFound', message: 'Database not found', arguments: [], context: {} });
    if (!m || m[1] !== API_KEY) return sendJson(res, 401, { name: 'werkzeug.exceptions.Unauthorized', message: 'Invalid apikey', arguments: ['Invalid apikey', 401], context: {}, debug: 'Traceback...' });
    const body = JSON.parse(await readBody(req) || '{}');
    const [, model, method] = j2;
    try {
      const { ids, context, ...kw } = body;
      const args = ids !== undefined ? [ids] : [];
      const kwargs = Object.assign({}, kw, context ? { context } : {});
      // JSON-2 is keyword-only: emulate Python binding of ids as the recordset and everything else by name.
      return sendJson(res, 200, callMethod(model, method, args, kwargs, { transport: 'json2' }));
    } catch (e) {
      const name = e.odooName || 'builtins.Exception';
      return sendJson(res, e.code === 404 ? 404 : (/AccessDenied/.test(name) ? 403 : 500), { name, message: e.message, arguments: [e.message], context: {}, debug: 'Traceback...' });
    }
  }

  // ---- database-bound web routes
  const sid = cookieSid(req);
  const s = sid && sessions.get(sid);
  if (p.startsWith('/web/dataset/call_kw/') || p === '/web/session/get_session_info') {
    const b = JSON.parse(await readBody(req) || '{}');
    if (!MONODB && !s) return sendHtml(res, 404, NOT_FOUND_HTML);
    if (!s || !s.uid || s.pre) return rpcErr(res, b.id, new RpcError('odoo.http.SessionExpiredException', 'Session expired'));
    if (p === '/web/session/get_session_info') {
      const u = MODELS['res.users'].records[0];
      return rpcOk(res, b.id, { uid: s.uid, name: u.name, username: u.login, db: s.db, server_version: VERSION, server_version_info: versionInfo().server_version_info, user_companies: { current_company: 1, allowed_companies: { 1: { id: 1, name: 'Mock Company' } } } });
    }
    s.callCount++;
    if (EXPIRE_AFTER && s.callCount === EXPIRE_AFTER + 1 && !s.expiredOnce) { s.expiredOnce = true; sessions.delete(sid); return rpcErr(res, b.id, new RpcError('odoo.http.SessionExpiredException', 'Session expired')); }
    const { model, method, args, kwargs } = b.params || {};
    try { return rpcOk(res, b.id, callMethod(model, method, args || [], kwargs || {}, { transport: 'web' })); } catch (e) { return rpcErr(res, b.id, e instanceof RpcError ? e : new RpcError('builtins.Exception', e.message)); }
  }
  if (p === '/__calls') return sendJson(res, 200, calls);
  sendHtml(res, 404, NOT_FOUND_HTML);
}

const server = http.createServer((req, res) => { handle(req, res).catch((e) => { sendJson(res, 500, { error: e.message }); }); });
server.listen(parseInt(env.MOCK_PORT || '0', 10), '127.0.0.1', () => {
  const info = { port: server.address().port };
  if (env.MOCK_REDIRECT_PORT) {
    const target = `http://127.0.0.1:${info.port}`;
    const redirector = http.createServer((req, res) => { res.writeHead(308, { Location: target + req.url }); res.end(); });
    redirector.listen(parseInt(env.MOCK_REDIRECT_PORT, 10), '127.0.0.1', () => { info.redirectPort = redirector.address().port; process.stdout.write(JSON.stringify(info) + '\n'); });
  } else {
    process.stdout.write(JSON.stringify(info) + '\n');
  }
});
// When started by the test runner, exit as soon as the runner closes our stdin (no orphans).
if (env.WATCH_STDIN === '1') { process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); }
