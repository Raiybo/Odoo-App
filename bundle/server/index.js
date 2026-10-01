#!/usr/bin/env node
/*
 * Odoo App - MCP server that connects Claude to Odoo.
 *
 * Zero dependencies. Works with Node.js 18 or newer (including the Node.js that
 * ships inside Claude Desktop for extensions).
 *
 * Usage:
 *   node index.js              MCP server over stdio (used by Claude Desktop / Claude Code)
 *   node index.js --test       Check the Odoo connection with the current configuration
 *   node index.js --test --json  Same, machine readable
 *   node index.js --version
 *
 * Configuration comes from environment variables, with a JSON config file as fallback:
 *   ODOO_URL           https://mycompany.odoo.com
 *   ODOO_LOGIN         the email used to log into Odoo
 *   ODOO_PASSWORD      the Odoo password, or an Odoo API key
 *   ODOO_DB            optional, auto-detected when empty
 *   ODOO_READ_ONLY     true/false (default false)
 *   ODOO_INSECURE_SSL  true/false, accept self-signed certificates (default false)
 *   ODOO_TIMEOUT_MS    request timeout (default 60000)
 *   ODOO_CONFIG_FILE   path of the JSON config file (keys: url, login, password, db, readOnly, insecureSsl)
 *
 * How it talks to Odoo (chosen automatically, first one that works):
 *   1. Web session API  (/web/session/authenticate + /web/dataset/call_kw) - every Odoo version and plan, password login
 *   2. JSON-2 API       (/json/2/<model>/<method>)                           - Odoo 19+, API key
 *   3. Legacy JSON-RPC  (/jsonrpc)                                           - Odoo 8-21, password or API key
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_NAME = 'odoo';
const SERVER_VERSION = '1.0.0';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const MAX_OUTPUT_CHARS = 60000;

// ---------------------------------------------------------------------------
// Logging (stderr only - stdout is reserved for the MCP protocol)
// ---------------------------------------------------------------------------
const DEBUG = /^(1|true|yes)$/i.test(process.env.ODOO_DEBUG || '');
const QUIET = /^(1|true|yes)$/i.test(process.env.ODOO_QUIET || '') && !DEBUG;
function log(...parts) {
  if (QUIET) return;
  try { process.stderr.write(`[odoo-mcp] ${parts.join(' ')}\n`); } catch (_) { /* ignore */ }
}
function debug(...parts) { if (DEBUG) log(...parts); }

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function defaultConfigFile() {
  if (process.env.ODOO_CONFIG_FILE) return process.env.ODOO_CONFIG_FILE;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'OdooClaude', 'config.json');
  }
  return path.join(os.homedir(), '.odoo-claude', 'config.json');
}

function loadConfig() {
  const file = defaultConfigFile();
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) {
    if (e.code !== 'ENOENT') log(`Warning: could not read config file ${file}: ${e.message}`);
  }
  const env = process.env;
  const pick = (...vals) => {
    for (const v of vals) {
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (s === '' || /^\$\{[^}]*\}$/.test(s)) continue; // empty, or an unsubstituted "${user_config.x}" placeholder
      return s;
    }
    return '';
  };
  const bool = (v, dflt) => {
    if (v === undefined || v === null || v === '') return dflt;
    if (typeof v === 'boolean') return v;
    return /^(1|true|yes|on)$/i.test(String(v).trim());
  };
  return {
    url: pick(env.ODOO_URL, fileCfg.url),
    db: pick(env.ODOO_DB, env.ODOO_DATABASE, fileCfg.db, fileCfg.database),
    login: pick(env.ODOO_LOGIN, env.ODOO_USER, env.ODOO_USERNAME, env.ODOO_EMAIL, fileCfg.login, fileCfg.user, fileCfg.email),
    password: pick(env.ODOO_PASSWORD, env.ODOO_API_KEY, fileCfg.password, fileCfg.apiKey, fileCfg.api_key),
    readOnly: bool(pick(env.ODOO_READ_ONLY, fileCfg.readOnly, fileCfg.read_only), false),
    insecureSsl: bool(pick(env.ODOO_INSECURE_SSL, fileCfg.insecureSsl, fileCfg.insecure_ssl), false),
    timeoutMs: parseInt(pick(env.ODOO_TIMEOUT_MS, fileCfg.timeoutMs), 10) || 60000,
    configFile: file,
  };
}

function missingConfigMessage(cfg) {
  const missing = [];
  if (!cfg.url) missing.push('Odoo address (ODOO_URL)');
  if (!cfg.login) missing.push('login email (ODOO_LOGIN)');
  if (!cfg.password) missing.push('password or API key (ODOO_PASSWORD)');
  return `The Odoo connection is not configured yet. Missing: ${missing.join(', ')}. ` +
    `Open Claude Desktop > Settings > Extensions > Odoo > Configure (or re-run the Odoo App installer) and fill these in.`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
class OdooError extends Error {
  constructor(message, kind, extra) {
    super(message);
    this.name = 'OdooError';
    this.kind = kind || 'odoo';
    Object.assign(this, extra || {});
  }
}

function networkError(e, url) {
  let host = url;
  try { host = new URL(url).host; } catch (_) { /* ignore */ }
  const cause = (e && e.cause) || e || {};
  const code = cause.code || '';
  if (e && e.name === 'AbortError') {
    return new OdooError(`Timed out waiting for ${host}. The server may be slow, down, or unreachable from this network (VPN needed?).`, 'network', { code: 'TIMEOUT' });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new OdooError(`Could not find the server "${host}". Check the Odoo address for typos.`, 'network', { code });
  }
  if (code === 'ECONNREFUSED') {
    return new OdooError(`"${host}" refused the connection. Check the address and port, and that Odoo is running.`, 'network', { code });
  }
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(code) || /certificate/i.test(cause.message || '')) {
    return new OdooError(`The SSL certificate of "${host}" could not be verified (${code || cause.message}). If this is an internal server with a self-signed certificate, enable "Accept self-signed certificates" (ODOO_INSECURE_SSL=true).`, 'network', { code });
  }
  return new OdooError(`Could not connect to "${host}": ${cause.message || (e && e.message) || 'unknown error'}`, 'network', { code });
}

function rpcErrorToOdooError(err) {
  const d = (err && err.data) || {};
  const name = d.name || '';
  const msg = d.message || (err && err.message) || 'Odoo error';
  let kind = 'rpc';
  if (/AccessDenied/.test(name)) kind = 'auth';
  else if (/SessionExpired/.test(name) || (err && err.code === 100)) kind = 'session';
  else if (/Database not found|database "?[^"]*"? does not exist|FATAL/i.test(msg)) kind = 'db';
  return new OdooError(msg, kind, { odooException: name, rpcCode: err && err.code, debug: d.debug });
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new OdooError('No Odoo address configured.', 'config');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_) { throw new OdooError(`"${input}" is not a valid web address. Example: https://mycompany.odoo.com`, 'config'); }
  if (!/^https?:$/.test(u.protocol)) throw new OdooError(`Unsupported address "${input}". Use an http:// or https:// address.`, 'config');
  return `${u.protocol}//${u.host}`;
}

function versionAtLeast(major, minor, wantMajor, wantMinor) {
  if (major !== wantMajor) return major > wantMajor;
  return (minor || 0) >= (wantMinor || 0);
}

// ---------------------------------------------------------------------------
// Odoo client
// ---------------------------------------------------------------------------
class OdooClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = null;
    this.db = cfg.db || null;
    this.dbSource = cfg.db ? 'configured' : null;
    this.transport = null;
    this.uid = null;
    this.user = {};
    this.sessionId = null;
    this.versionInfo = null;
    this.serverVersion = null;
    this.major = 0;
    this.minor = 0;
    this.edition = '';
    this.ready = false;
    this.connecting = null;
    this.fieldsCache = new Map();
    this.rpcId = 0;
    this.listedDbs = null;
    if (cfg.insecureSsl) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  // ----- low level HTTP ----------------------------------------------------
  async http(url, opts) {
    const o = Object.assign({ method: 'POST', headers: {}, redirects: 0 }, opts || {});
    // "Connection: close" keeps the event loop free of idle sockets so the process can exit cleanly
    // (Node on Windows aborts when process.exit() runs while keep-alive sockets are open).
    const headers = Object.assign({ 'User-Agent': `odoo-app-mcp/${SERVER_VERSION}`, Accept: 'application/json, text/html;q=0.5, */*;q=0.1', Connection: 'close' }, o.headers);
    if (this.sessionId && !headers.Cookie) headers.Cookie = `session_id=${this.sessionId}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    let res;
    try {
      debug(`${o.method} ${url}`);
      res = await fetch(url, { method: o.method, headers, body: o.body, redirect: 'manual', signal: ctrl.signal });
    } catch (e) {
      throw networkError(e, url);
    } finally {
      clearTimeout(timer);
    }
    this.captureCookies(res);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (loc && o.redirects < 4) {
        const from = new URL(url);
        const to = new URL(loc, url);
        // Only follow redirects that keep the same path (http->https, www., new domain).
        // A redirect to another page (e.g. /web/login) means "not for this request" and is returned as is.
        if (to.pathname.replace(/\/$/, '') === from.pathname.replace(/\/$/, '') && to.origin !== from.origin) {
          debug(`redirect ${from.origin} -> ${to.origin}`);
          if (from.origin === this.base) this.base = to.origin;
          return this.http(to.href, Object.assign({}, o, { redirects: o.redirects + 1 }));
        }
      }
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, url };
  }

  captureCookies(res) {
    let cookies = [];
    if (typeof res.headers.getSetCookie === 'function') cookies = res.headers.getSetCookie();
    else { const sc = res.headers.get('set-cookie'); if (sc) cookies = [sc]; }
    for (const c of cookies) {
      const m = /(?:^|,\s*)session_id=([^;,\s]+)/.exec(c) || /session_id=([^;\s]+)/.exec(c);
      if (m && m[1]) this.sessionId = m[1];
    }
  }

  parseJsonBody(r, what) {
    const ctype = (r.headers.get('content-type') || '').toLowerCase();
    let data = null;
    if (r.text && (ctype.includes('json') || /^\s*[{[]/.test(r.text))) {
      try { data = JSON.parse(r.text); } catch (_) { data = null; }
    }
    if (data === null) {
      if (r.status >= 500) throw new OdooError(`Odoo returned an error (HTTP ${r.status}) for ${what}. The server may be down or restarting - try again in a minute.`, 'http', { httpStatus: r.status });
      if (r.status === 404 || r.status === 405) throw new OdooError(`${what} is not available on this server (HTTP ${r.status}).`, 'http', { httpStatus: r.status });
      if (r.status === 401 || r.status === 403) throw new OdooError(`Access refused (HTTP ${r.status}) for ${what}.`, 'auth', { httpStatus: r.status });
      if (r.status >= 300 && r.status < 400) throw new OdooError(`The server redirected ${what} to another page (HTTP ${r.status}).`, 'http', { httpStatus: r.status });
      throw new OdooError(`HTTP ${r.status} with a non-JSON response for ${what}`, 'not_odoo', { httpStatus: r.status });
    }
    return data;
  }

  // JSON-RPC envelope used by the web client routes and the legacy /jsonrpc endpoint
  async jsonRpc(routePath, params, opts) {
    const id = ++this.rpcId;
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'call', id, params: params || {} });
    const r = await this.http(this.base + routePath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const data = this.parseJsonBody(r, routePath);
    if (data && data.error) throw rpcErrorToOdooError(data.error);
    if (data && Object.prototype.hasOwnProperty.call(data, 'result')) return data.result;
    if (opts && opts.rawOk) return data;
    throw new OdooError(`unexpected JSON response from ${routePath}`, 'not_odoo', { httpStatus: r.status });
  }

  async legacyCall(service, method, args) {
    return this.jsonRpc('/jsonrpc', { service, method, args });
  }

  async json2Call(model, method, body, db) {
    const headers = { 'Content-Type': 'application/json', Authorization: `bearer ${this.cfg.password}` };
    if (db) headers['X-Odoo-Database'] = db;
    const r = await this.http(`${this.base}/json/2/${model}/${method}`, { method: 'POST', headers: Object.assign(headers, { Cookie: '' }), body: JSON.stringify(body || {}) });
    let data = null;
    try { data = r.text ? JSON.parse(r.text) : null; } catch (_) { data = null; }
    if (r.status >= 200 && r.status < 300) return data;
    const name = (data && data.name) || '';
    const msg = (data && data.message) || `HTTP ${r.status}`;
    let kind = 'rpc';
    if (r.status === 401 || /Unauthorized|AccessDenied/.test(name)) kind = 'auth';
    else if (/Database not found|does not exist/i.test(msg) && /database/i.test(msg)) kind = 'db';
    else if (r.status === 404 && data === null) kind = 'http';
    throw new OdooError(msg, kind, { httpStatus: r.status, odooException: name, debug: data && data.debug });
  }

  // ----- connection ---------------------------------------------------------
  info() {
    const v = this.serverVersion || (this.versionInfo ? this.versionInfo.slice(0, 2).join('.') : 'unknown');
    return {
      ok: true,
      url: this.base,
      database: this.db,
      database_source: this.dbSource,
      odoo_version: String(v).replace(/\+e$/, ''),
      edition: this.edition,
      user: this.user.name || null,
      login: this.user.login || this.cfg.login,
      user_id: this.uid,
      company: this.user.company || null,
      transport: this.transport === 'web' ? 'web session' : this.transport === 'json2' ? 'JSON-2 API (API key)' : 'JSON-RPC',
      read_only: !!this.cfg.readOnly,
    };
  }

  async connect() {
    if (this.ready) return this.info();
    if (!this.connecting) {
      this.connecting = this._connect().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async _connect() {
    const cfg = this.cfg;
    if (!cfg.url || !cfg.login || !cfg.password) throw new OdooError(missingConfigMessage(cfg), 'config');
    this.base = normalizeUrl(cfg.url);
    await this.probeVersion();
    const attempts = [];
    const candidates = await this.dbCandidates(attempts);
    if (this.ready) return this.info(); // discovered via the login page
    for (const db of candidates) {
      if (await this.tryTransports(db, attempts)) {
        this.ready = true;
        log(`Connected to ${this.base} (db ${this.db}) as ${this.user.name || cfg.login} via ${this.transport}`);
        return this.info();
      }
    }
    // Single-database host where the name could not be discovered: the JSON-2 API (Odoo 19+)
    // does not need the database name when the server only has one.
    const nothingWorked = attempts.every((a) => !a.ok && (a.reason === 'nodb' || a.transport === 'web' || a.reason === 'unavailable'));
    if (!cfg.db && (!this.major || this.major >= 19) && (candidates.length === 0 || nothingWorked)) {
      const r = await this.tryJson2(null);
      attempts.push(Object.assign({ db: '(server default)', transport: 'json2' }, r));
      if (r.ok) {
        this.db = this.db || '(server default)';
        this.dbSource = 'server default';
        this.ready = true;
        log(`Connected to ${this.base} (default db) as ${this.user.name || cfg.login} via json2`);
        return this.info();
      }
    }
    throw this.summarizeFailure(candidates, attempts);
  }

  async probeVersion() {
    let r;
    try {
      r = await this.jsonRpc('/web/webclient/version_info', {});
    } catch (e) {
      if (e.kind === 'network') throw e;
      if (e.kind === 'http' && e.httpStatus >= 500) throw e;
      throw new OdooError(`"${this.base}" does not look like an Odoo server (${e.message}). Check the address - it is the page where you log into Odoo, for example https://mycompany.odoo.com`, 'not_odoo');
    }
    if (!r || !r.server_version_info) {
      throw new OdooError(`"${this.base}" does not look like an Odoo server (no version information). Check the address - it is the page where you log into Odoo, for example https://mycompany.odoo.com`, 'not_odoo');
    }
    this.versionInfo = r.server_version_info;
    this.serverVersion = r.server_version;
    this.major = parseInt(String(r.server_version_info[0]).replace(/^saas~/i, ''), 10) || 0;
    this.minor = parseInt(r.server_version_info[1], 10) || 0;
    const tag = String(r.server_version_info[5] || '');
    this.edition = (tag === 'e' || /\+e$/.test(String(r.server_version || ''))) ? 'Enterprise' : 'Community';
  }

  async listDatabases() {
    try {
      const r = await this.jsonRpc('/web/database/list', {});
      return Array.isArray(r) ? r : [];
    } catch (_) {
      return [];
    }
  }

  async dbCandidates(attempts) {
    const out = [];
    const add = (d) => { if (d && typeof d === 'string' && !out.includes(d)) out.push(d); };
    if (this.cfg.db) { add(this.cfg.db); return out; }

    const listed = await this.listDatabases();
    this.listedDbs = listed;
    if (listed.length === 1) { this.dbSource = 'auto-detected (server list)'; add(listed[0]); return out; }

    // Single-database hosts: log in through the web form and read the database name from the session.
    try {
      const discovered = await this.discoverViaWebLogin();
      if (discovered) {
        this.dbSource = 'auto-detected (login)';
        add(discovered);
        return out;
      }
    } catch (e) {
      if (e.kind === 'network') throw e;
      if (e.kind === 'mfa') attempts.push({ db: '(auto)', transport: 'web', ok: false, reason: 'mfa', message: e.message });
      debug(`web login discovery failed: ${e.message}`);
    }

    const host = new URL(this.base).hostname;
    const labels = host.split('.');
    if (labels.length >= 3 && !/^\d+$/.test(labels[0]) && !/^(www|odoo|erp|crm|app|portal)$/i.test(labels[0])) {
      this.dbSource = 'auto-detected (address)';
      add(labels[0]);
    }
    for (const d of listed.slice(0, 10)) add(d);
    if (out.length > 1 || (out.length === 1 && listed.length > 1)) this.dbSource = 'auto-detected';
    return out;
  }

  async discoverViaWebLogin() {
    const r = await this.http(`${this.base}/web/login`, { method: 'GET', headers: { Accept: 'text/html' } });
    if (r.status !== 200) return null;
    // Some versions embed the session information (including the database) in the login page.
    const si = /odoo\.__session_info__\s*=\s*(\{.*?\});/s.exec(r.text);
    if (si) {
      try {
        const info = JSON.parse(si[1]);
        if (info && typeof info.db === 'string' && info.db) return info.db;
      } catch (_) { /* ignore */ }
    }
    const m = /name="csrf_token"\s+value="([^"]+)"/.exec(r.text) || /csrf_token:\s*"([^"]+)"/.exec(r.text);
    if (!m) return null;
    const form = new URLSearchParams({ csrf_token: m[1], login: this.cfg.login, password: this.cfg.password, redirect: '/web' });
    const r2 = await this.http(`${this.base}/web/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: form.toString(),
    });
    if (![302, 303].includes(r2.status)) return null; // 200 = login form shown again (wrong credentials or API key)
    const loc = r2.headers.get('location') || '';
    if (/totp|mfa|2fa/i.test(loc)) {
      throw new OdooError('two-factor authentication is enabled for this account', 'mfa');
    }
    const info = await this.jsonRpc('/web/session/get_session_info', {});
    if (!info || !info.db || !info.uid) return null;
    this.adopt({ transport: 'web', db: info.db, uid: info.uid, name: info.name, login: info.username, companyName: companyNameFromSession(info), serverVersion: info.server_version });
    this.ready = true;
    return info.db;
  }

  adopt(s) {
    this.transport = s.transport;
    this.db = s.db;
    this.uid = s.uid;
    this.user = { name: s.name || null, login: s.login || this.cfg.login, company: s.companyName || null };
    if (s.serverVersion && !this.serverVersion) this.serverVersion = s.serverVersion;
  }

  async tryTransports(db, attempts) {
    if (!db) return false;
    let r = await this.tryWeb(db);
    attempts.push(Object.assign({ db, transport: 'web' }, r));
    if (r.ok) return true;
    if (r.reason === 'nodb') return false;

    if (!this.major || this.major >= 19) {
      r = await this.tryJson2(db);
      attempts.push(Object.assign({ db, transport: 'json2' }, r));
      if (r.ok) return true;
      if (r.reason === 'nodb') return false;
    }

    r = await this.tryLegacy(db);
    attempts.push(Object.assign({ db, transport: 'jsonrpc' }, r));
    return !!r.ok;
  }

  async tryWeb(db) {
    try {
      this.sessionId = null;
      const res = await this.jsonRpc('/web/session/authenticate', { db, login: this.cfg.login, password: this.cfg.password });
      if (res && typeof res.uid === 'number' && res.uid > 0) {
        this.adopt({ transport: 'web', db, uid: res.uid, name: res.name, login: res.username, companyName: companyNameFromSession(res), serverVersion: res.server_version });
        return { ok: true };
      }
      if (res && (res.uid === null || res.uid === false)) {
        return { ok: false, reason: 'mfa', message: 'two-factor authentication is enabled for this account' };
      }
      return { ok: false, reason: 'denied', message: 'login refused' };
    } catch (e) {
      if (e.kind === 'network') throw e;
      if (e.kind === 'auth') return { ok: false, reason: 'denied', message: 'login refused' };
      if (e.kind === 'db') return { ok: false, reason: 'nodb', message: e.message };
      if (e.kind === 'http' || e.kind === 'not_odoo') return { ok: false, reason: 'unavailable', message: e.message };
      return { ok: false, reason: 'error', message: e.message };
    }
  }

  async tryJson2(db) {
    try {
      const ctx = await this.json2Call('res.users', 'context_get', {}, db);
      const uid = ctx && ctx.uid;
      if (!uid) return { ok: false, reason: 'error', message: 'unexpected JSON-2 response' };
      const users = await this.json2Call('res.users', 'read', { ids: [uid], fields: ['name', 'login', 'company_id'] }, db);
      const u = (Array.isArray(users) && users[0]) || {};
      this.adopt({ transport: 'json2', db, uid, name: u.name, login: u.login, companyName: Array.isArray(u.company_id) ? u.company_id[1] : null });
      return { ok: true };
    } catch (e) {
      if (e.kind === 'network') throw e;
      if (e.kind === 'auth') return { ok: false, reason: 'denied', message: 'not accepted as an API key' };
      if (e.kind === 'db') return { ok: false, reason: 'nodb', message: e.message };
      if (e.httpStatus === 404 || e.httpStatus === 405 || e.kind === 'http') return { ok: false, reason: 'unavailable', message: 'JSON-2 API not available' };
      return { ok: false, reason: 'error', message: e.message };
    }
  }

  async tryLegacy(db) {
    try {
      const uid = await this.legacyCall('common', 'authenticate', [db, this.cfg.login, this.cfg.password, {}]);
      if (typeof uid === 'number' && uid > 0) {
        let u = {};
        try {
          const users = await this.legacyCall('object', 'execute_kw', [db, uid, this.cfg.password, 'res.users', 'read', [[uid]], { fields: ['name', 'login', 'company_id'] }]);
          u = (Array.isArray(users) && users[0]) || {};
        } catch (_) { /* name is optional */ }
        this.adopt({ transport: 'jsonrpc', db, uid, name: u.name, login: u.login, companyName: Array.isArray(u.company_id) ? u.company_id[1] : null });
        return { ok: true };
      }
      return { ok: false, reason: 'denied', message: 'login refused' };
    } catch (e) {
      if (e.kind === 'network') throw e;
      if (e.kind === 'auth') return { ok: false, reason: 'denied', message: 'login refused' };
      if (e.kind === 'db') return { ok: false, reason: 'nodb', message: e.message };
      if (e.httpStatus === 404 || e.httpStatus === 405 || e.kind === 'http' || e.kind === 'not_odoo') return { ok: false, reason: 'unavailable', message: 'legacy RPC not available' };
      return { ok: false, reason: 'error', message: e.message };
    }
  }

  summarizeFailure(candidates, attempts) {
    const host = (() => { try { return new URL(this.base).host; } catch (_) { return this.base; } })();
    const tried = attempts.map((a) => `${a.db} via ${a.transport}: ${a.ok ? 'ok' : (a.message || a.reason)}`).join('; ');
    const dbHint = 'Your database name is usually the first part of your Odoo address (mycompany for mycompany.odoo.com). ' +
      'On Odoo.sh it is the database name shown in your Odoo.sh project. Otherwise ask your Odoo administrator. ' +
      'Then set it in the "Database" field of the Odoo extension (or ODOO_DB).';

    const anyMfa = attempts.some((a) => a.reason === 'mfa');
    const anyDenied = attempts.some((a) => a.reason === 'denied');
    const allNodb = attempts.length > 0 && attempts.every((a) => a.reason === 'nodb');

    if (anyMfa) {
      return new OdooError(
        `Your Odoo account (${this.cfg.login}) uses two-factor authentication, so the password cannot be used by Claude. ` +
        'Create an API key instead: in Odoo click your name (top right) > Preferences > Account Security > New API Key, ' +
        'copy the key, and paste it in place of the password in the Odoo extension settings.', 'mfa', { tried });
    }
    if (candidates.length === 0) {
      const listNote = this.listedDbs && this.listedDbs.length > 1 ? ` This server hosts several databases: ${this.listedDbs.join(', ')}.` : '';
      return new OdooError(`Could not determine which Odoo database to use on ${host}.${listNote} ${dbHint}`, 'db', { tried });
    }
    if (allNodb) {
      const listNote = this.listedDbs && this.listedDbs.length ? ` Databases on this server: ${this.listedDbs.join(', ')}.` : '';
      return new OdooError(`The database "${candidates.join('", "')}" was not found on ${host}.${listNote} ${dbHint}`, 'db', { tried });
    }
    if (anyDenied) {
      return new OdooError(
        `Odoo at ${host} rejected the login for "${this.cfg.login}"${candidates.length === 1 ? ` on database "${candidates[0]}"` : ''}. ` +
        'Check the email and password (they are the ones you use to log into Odoo in the browser). ' +
        'If you sign in with Google/Microsoft or use two-factor authentication, create an API key in Odoo ' +
        '(your name > Preferences > Account Security > New API Key) and use it instead of the password. ' +
        'Note: on the Odoo Online "Standard" plan only the password works, API keys are a paid feature.', 'auth', { tried });
    }
    return new OdooError(`Could not log into Odoo at ${host}. Tried: ${tried}`, 'auth', { tried });
  }

  // ----- calls --------------------------------------------------------------
  guardReadOnly(method) {
    if (!this.cfg.readOnly) return;
    if (isReadMethod(method)) return;
    throw new OdooError(`This Odoo connection is in read-only mode, so "${method}" is not allowed. Turn off "Read-only mode" in the Odoo extension settings (or set ODOO_READ_ONLY=false) to allow changes.`, 'readonly');
  }

  async execute(model, method, args, kwargs) {
    args = args || [];
    kwargs = kwargs || {};
    await this.connect();
    this.guardReadOnly(method);
    try {
      return await this.dispatch(model, method, args, kwargs);
    } catch (e) {
      if (e.kind === 'session' && this.transport === 'web') {
        debug('web session expired, logging in again');
        const r = await this.tryWeb(this.db);
        if (r.ok) return await this.dispatch(model, method, args, kwargs);
      }
      throw this.decorateError(e, model, method);
    }
  }

  async dispatch(model, method, args, kwargs) {
    if (this.transport === 'web') {
      return this.jsonRpc(`/web/dataset/call_kw/${model}/${method}`, { model, method, args, kwargs });
    }
    if (this.transport === 'jsonrpc') {
      return this.legacyCall('object', 'execute_kw', [this.db, this.uid, this.cfg.password, model, method, args, kwargs]);
    }
    if (this.transport === 'json2') {
      return this.json2Call(model, method, json2Body(method, args, kwargs), this.db);
    }
    throw new OdooError('Not connected to Odoo.', 'config');
  }

  decorateError(e, model, method) {
    if (!(e instanceof OdooError)) return e;
    const msg = e.message || '';
    if ((/NotFound|KeyError/.test(e.odooException || '') || /does not exist|doesn't exist|Object .* doesn't exist/i.test(msg)) && !/field/i.test(msg) && /^(search|read|write|create|unlink|fields_get|name_search|search_count|search_read)/.test(method) === true && !/method/i.test(msg)) {
      return new OdooError(`The model "${model}" does not exist in this Odoo (or you have no access to it). Use odoo_search_models to find the right technical name.`, 'rpc', { odooException: e.odooException });
    }
    if (/does not exist/.test(msg) && /method/i.test(msg)) {
      return new OdooError(`${msg}. Check the method name (use odoo_call only with methods that exist on ${model}).`, 'rpc');
    }
    return e;
  }

  async fieldsGet(model, attributes) {
    const key = `${model}|${(attributes || []).join(',')}`;
    if (this.fieldsCache.has(key)) return this.fieldsCache.get(key);
    const res = await this.execute(model, 'fields_get', [], { attributes: attributes || ['string', 'type', 'required', 'readonly', 'relation', 'selection', 'help'] });
    this.fieldsCache.set(key, res);
    return res;
  }

  recordUrl(model, id) {
    if (versionAtLeast(this.major, this.minor, 17, 2)) return `${this.base}/odoo/${model}/${id}`;
    return `${this.base}/web#id=${id}&model=${model}&view_type=form`;
  }
}

function companyNameFromSession(res) {
  try {
    const uc = res.user_companies;
    if (!uc) return null;
    const cur = uc.current_company;
    if (Array.isArray(cur)) return cur[1] || null; // Odoo <= 14: [id, name]
    const all = uc.allowed_companies || {};
    if (Array.isArray(all)) { const f = all.find((c) => c[0] === cur); return f ? f[1] : null; }
    const c = all[cur] || all[String(cur)];
    return c ? c.name : null;
  } catch (_) { return null; }
}

const READ_METHODS = new Set([
  'search', 'search_read', 'search_count', 'read', 'read_group', 'formatted_read_group', 'web_read_group', 'web_search_read', 'web_read',
  'fields_get', 'fields_view_get', 'get_views', 'get_view', 'load_views', 'name_search', 'name_get', 'default_get', 'context_get',
  'check_access_rights', 'check_access_rule', 'check_access', 'has_group', 'exists', 'export_data', 'copy_data', 'get_metadata',
  'get_formview_action', 'get_formview_id', 'get_empty_list_help', 'read_progress_bar', 'search_fetch', 'display_name', 'get_external_id',
  'onchange', 'web_save_preview', 'get_installed', 'get_param',
]);
function isReadMethod(method) {
  if (READ_METHODS.has(method)) return true;
  return /^(get_|read_|search_|fields_|name_|check_|has_|is_|list_|compute_|_get|_read|_search|_fields|_name_get)/.test(method) && !/^(get_|read_|search_)?.*(write|create|unlink|delete|remove|set_|update|post|confirm|cancel|validate|send|apply|action_|button_|toggle)/.test(method);
}

const JSON2_POSITIONAL = {
  read: ['ids', 'fields'], write: ['ids', 'vals'], unlink: ['ids'], create: ['vals_list'], copy: ['ids', 'default'],
  search_read: ['domain', 'fields', 'offset', 'limit', 'order'], search: ['domain', 'offset', 'limit', 'order'], search_count: ['domain', 'limit'],
  fields_get: ['allfields', 'attributes'], name_search: ['name', 'domain', 'operator', 'limit'], name_get: ['ids'], default_get: ['fields_list'],
  read_group: ['domain', 'fields', 'groupby', 'offset', 'limit', 'orderby', 'lazy'], formatted_read_group: ['domain', 'groupby', 'aggregates', 'having', 'offset', 'limit', 'order'],
  check_access: ['ids', 'operation'], check_access_rights: ['operation', 'raise_exception'], exists: ['ids'], toggle_active: ['ids'],
  action_archive: ['ids'], action_unarchive: ['ids'], get_formview_action: ['ids'], message_post: ['ids'], get_metadata: ['ids'],
};
function json2Body(method, args, kwargs) {
  const body = Object.assign({}, kwargs);
  if (!args || args.length === 0) return body;
  const names = JSON2_POSITIONAL[method] || ((/^(action_|button_|do_|set_)/.test(method)) ? ['ids'] : null);
  args.forEach((a, i) => {
    let key = names ? names[i] : null;
    if (!key && i === 0 && Array.isArray(a) && a.every((x) => Number.isInteger(x))) key = 'ids';
    if (!key) throw new OdooError(`On this Odoo version, "${method}" must be called with named arguments. Put the parameters in "kwargs" by name and the record ids in "ids".`, 'rpc');
    body[key] = a;
  });
  return body;
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------
const PREFERRED_FIELDS = [
  'display_name', 'name', 'ref', 'default_code', 'barcode', 'email', 'phone', 'mobile', 'login', 'state', 'stage_id', 'kanban_state',
  'date', 'date_order', 'date_deadline', 'invoice_date', 'invoice_date_due', 'date_start', 'date_end', 'date_planned', 'scheduled_date',
  'amount_total', 'amount_untaxed', 'amount_residual', 'amount_tax', 'price_unit', 'price_subtotal', 'list_price', 'standard_price', 'expected_revenue', 'probability',
  'qty_available', 'virtual_available', 'product_uom_qty', 'quantity', 'product_qty', 'qty_delivered', 'qty_invoiced',
  'partner_id', 'commercial_partner_id', 'user_id', 'team_id', 'company_id', 'currency_id', 'product_id', 'order_id', 'invoice_origin', 'origin',
  'move_type', 'payment_state', 'invoice_status', 'delivery_status', 'priority', 'active', 'type', 'is_company', 'categ_id', 'country_id', 'city', 'parent_id',
  'picking_type_id', 'location_id', 'location_dest_id', 'journal_id', 'account_id', 'debit', 'credit', 'balance', 'description',
];
const DEFAULT_FIELD_SKIP_TYPES = new Set(['binary', 'html', 'one2many', 'many2many']);

function toIntArray(v, what) {
  if (v === undefined || v === null) throw new OdooError(`"${what}" is required.`, 'input');
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = v.split(/[,\s]+/).filter(Boolean); } }
  if (!Array.isArray(v)) v = [v];
  const out = v.map((x) => parseInt(x, 10));
  if (out.some((x) => !Number.isInteger(x))) throw new OdooError(`"${what}" must be a list of record ids (integers).`, 'input');
  return out;
}
function toDomain(v) {
  if (v === undefined || v === null || v === '') return [];
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { throw new OdooError('"domain" must be a JSON array like [["state","=","sale"]].', 'input'); } }
  if (!Array.isArray(v)) throw new OdooError('"domain" must be an array of [field, operator, value] triplets.', 'input');
  return v;
}
function toStringArray(v, what) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') { try { const p = JSON.parse(v); v = p; } catch (_) { v = v.split(/[,\s]+/).filter(Boolean); } }
  if (!Array.isArray(v)) throw new OdooError(`"${what}" must be a list of field names.`, 'input');
  return v.map(String);
}
function toObject(v, what) {
  if (v === undefined || v === null) throw new OdooError(`"${what}" is required.`, 'input');
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { throw new OdooError(`"${what}" must be a JSON object.`, 'input'); } }
  if (typeof v !== 'object' || Array.isArray(v)) throw new OdooError(`"${what}" must be a JSON object of field: value pairs.`, 'input');
  return v;
}
function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

async function defaultFields(client, model) {
  const all = await client.fieldsGet(model, ['type']);
  const names = Object.keys(all);
  const chosen = PREFERRED_FIELDS.filter((f) => names.includes(f) && !DEFAULT_FIELD_SKIP_TYPES.has(all[f].type));
  if (chosen.length < 3) {
    for (const n of names) {
      if (!DEFAULT_FIELD_SKIP_TYPES.has(all[n].type) && !chosen.includes(n) && chosen.length < 15) chosen.push(n);
    }
  }
  return chosen.slice(0, 25);
}

function formatRecords(model, records, fields) {
  if (!Array.isArray(records)) return JSON.stringify(records, null, 2);
  const lines = [`${records.length} record${records.length === 1 ? '' : 's'} from ${model}${fields ? ` (fields: ${fields.join(', ')})` : ''}`];
  for (const r of records) lines.push(JSON.stringify(r));
  return lines.join('\n');
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n... output truncated (${text.length} characters). Use a smaller limit, fewer fields, or offset to page through results.`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const DOMAIN_SCHEMA = {
  type: 'array',
  description: 'Odoo search domain: a list of [field, operator, value] conditions, combined with AND unless prefixed with "|" (OR) or "!" (NOT). Operators: =, !=, >, >=, <, <=, like, ilike, not ilike, in, not in, child_of. Examples: [["state","=","sale"]], [["amount_total",">",1000],["date_order",">=","2026-01-01"]], ["|",["email","ilike","@acme.com"],["phone","!=",false]], [["partner_id.country_id.code","=","US"]]. Empty array = all records.',
  items: {},
};

const TOOLS = [
  {
    name: 'odoo_check_connection',
    description: 'Verify that Claude can reach Odoo and log in. Returns the Odoo version, database, user, company and access mode. Call this when the user asks to check/test the Odoo connection, at the start of a session, or when another Odoo tool fails unexpectedly.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (client) => {
      client.ready = false; // force a fresh check
      client.fieldsCache.clear();
      const info = await client.connect();
      return [
        `Connected to Odoo.`,
        `  Address:   ${info.url}`,
        `  Database:  ${info.database}${info.database_source ? ` (${info.database_source})` : ''}`,
        `  Odoo:      ${info.odoo_version} ${info.edition}`,
        `  User:      ${info.user || '(unknown name)'} (${info.login}, id ${info.user_id})`,
        `  Company:   ${info.company || '(not reported)'}`,
        `  Method:    ${info.transport}`,
        `  Access:    ${info.read_only ? 'read-only' : 'read and write'}`,
      ].join('\n');
    },
  },
  {
    name: 'odoo_search_models',
    description: 'Find the technical model name for a business object, e.g. "customer" -> res.partner, "sales order" -> sale.order, "invoice" -> account.move, "product" -> product.template / product.product, "lead/opportunity" -> crm.lead, "employee" -> hr.employee, "task" -> project.task, "ticket" -> helpdesk.ticket, "stock move/transfer" -> stock.picking. Searches both the technical name and the human label.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Word to look for, e.g. "invoice", "sale", "partner", "stock".' } }, required: ['query'], additionalProperties: false },
    handler: async (client, a) => {
      const q = String(a.query || '').trim();
      if (!q) throw new OdooError('"query" is required.', 'input');
      const domain = ['|', ['model', 'ilike', q], ['name', 'ilike', q]];
      let res = await client.execute('ir.model', 'search_read', [domain], { fields: ['model', 'name', 'transient'], limit: 80, order: 'model' });
      if (!res.length) return `No model matches "${q}". Try a shorter or English word (Odoo model labels are in English).`;
      // Most useful first: real models before wizards, main models (short names, few dots) before their sub-models.
      const ql = q.toLowerCase();
      const score = (m) => (m.transient ? 1000 : 0) + (m.model.split('.').length * 10) + m.model.length - (m.name.toLowerCase() === ql || m.model === ql ? 500 : 0);
      res = res.sort((a, b) => score(a) - score(b) || a.model.localeCompare(b.model)).slice(0, 40);
      return [`${res.length} model${res.length === 1 ? '' : 's'} matching "${q}":`].concat(res.map((m) => `  ${m.model}  -  ${m.name}${m.transient ? '  (wizard, temporary)' : ''}`)).join('\n');
    },
  },
  {
    name: 'odoo_fields',
    description: 'List the fields of a model with their label, type, relation and selection values. Use it to learn the exact field names before searching, creating or updating records. Optional filter narrows by field name or label.',
    inputSchema: { type: 'object', properties: { model: { type: 'string', description: 'Technical model name, e.g. sale.order' }, filter: { type: 'string', description: 'Optional text to filter fields by name or label, e.g. "date" or "amount".' } }, required: ['model'], additionalProperties: false },
    handler: async (client, a) => {
      const model = String(a.model || '').trim();
      const all = await client.fieldsGet(model);
      const filter = String(a.filter || '').trim().toLowerCase();
      let names = Object.keys(all).sort();
      if (filter) names = names.filter((n) => n.toLowerCase().includes(filter) || String(all[n].string || '').toLowerCase().includes(filter));
      const total = names.length;
      const shown = names.slice(0, 200);
      const lines = [`${total} field${total === 1 ? '' : 's'} on ${model}${filter ? ` matching "${filter}"` : ''}${total > shown.length ? ` (showing ${shown.length}; use filter to narrow)` : ''}:`];
      for (const n of shown) {
        const f = all[n];
        let extra = '';
        if (f.relation) extra += ` -> ${f.relation}`;
        if (f.type === 'selection' && Array.isArray(f.selection)) extra += ` [${f.selection.map((s) => s[0]).join('|')}]`;
        if (f.required) extra += ' required';
        if (f.readonly) extra += ' readonly';
        lines.push(`  ${n} (${f.type}): ${f.string || ''}${extra}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'odoo_search_read',
    description: 'Search records of a model and return their field values. This is the main way to read data from Odoo (customers, orders, invoices, products, stock, tasks, employees...). Many2one fields come back as [id, "display name"]. Dates are "YYYY-MM-DD", datetimes "YYYY-MM-DD HH:MM:SS" in UTC. Use odoo_fields to find field names, odoo_count for totals, odoo_group_by for sums per group.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Technical model name, e.g. res.partner, sale.order, account.move, product.product, crm.lead' },
        domain: DOMAIN_SCHEMA,
        fields: { type: 'array', items: { type: 'string' }, description: 'Field names to return. Omit for a sensible default set. Related fields like "partner_id.email" are not supported here; read the related record instead.' },
        limit: { type: 'integer', description: 'Max records (default 20, max 500).' },
        offset: { type: 'integer', description: 'Skip this many records (paging).' },
        order: { type: 'string', description: 'Sort, e.g. "date_order desc", "name asc".' },
        include_archived: { type: 'boolean', description: 'Also return archived (inactive) records. Default false.' },
      },
      required: ['model'],
      additionalProperties: false,
    },
    handler: async (client, a) => {
      const model = String(a.model || '').trim();
      const domain = toDomain(a.domain);
      let fields = toStringArray(a.fields, 'fields');
      if (!fields || fields.length === 0) fields = await defaultFields(client, model);
      const kwargs = { fields, limit: clampInt(a.limit, 20, 1, 500), offset: clampInt(a.offset, 0, 0, 1e9) };
      if (a.order) kwargs.order = String(a.order);
      if (a.include_archived) kwargs.context = { active_test: false };
      const res = await client.execute(model, 'search_read', [domain], kwargs);
      return truncate(formatRecords(model, res, fields) + (res.length === kwargs.limit ? `\n(limit reached - there may be more; use offset ${kwargs.offset + kwargs.limit} or odoo_count)` : ''));
    },
  },
  {
    name: 'odoo_count',
    description: 'Count the records of a model that match a domain. Cheap - use it before fetching large result sets, or to answer "how many" questions.',
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, domain: DOMAIN_SCHEMA, include_archived: { type: 'boolean' } }, required: ['model'], additionalProperties: false },
    handler: async (client, a) => {
      const model = String(a.model || '').trim();
      const kwargs = a.include_archived ? { context: { active_test: false } } : {};
      const n = await client.execute(model, 'search_count', [toDomain(a.domain)], kwargs);
      return `${n} record${n === 1 ? '' : 's'} in ${model} match the domain.`;
    },
  },
  {
    name: 'odoo_read',
    description: 'Read specific records by id and return their field values.',
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, ids: { type: 'array', items: { type: 'integer' }, description: 'Record ids' }, fields: { type: 'array', items: { type: 'string' }, description: 'Fields to return; omit for a default set.' } }, required: ['model', 'ids'], additionalProperties: false },
    handler: async (client, a) => {
      const model = String(a.model || '').trim();
      const ids = toIntArray(a.ids, 'ids');
      let fields = toStringArray(a.fields, 'fields');
      if (!fields || fields.length === 0) fields = await defaultFields(client, model);
      const res = await client.execute(model, 'read', [ids], { fields });
      return truncate(formatRecords(model, res, fields));
    },
  },
  {
    name: 'odoo_name_search',
    description: 'Quickly find records by (partial) name and get their ids, e.g. the id of customer "Azure Interior" or product "Office Chair". Use the id afterwards in domains like [["partner_id","=",ID]] or in create/write values.',
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, name: { type: 'string', description: 'Text to match against the record display name.' }, limit: { type: 'integer', description: 'Default 10.' } }, required: ['model', 'name'], additionalProperties: false },
    handler: async (client, a) => {
      const model = String(a.model || '').trim();
      const res = await client.execute(model, 'name_search', [String(a.name || '')], { limit: clampInt(a.limit, 10, 1, 100) });
      if (!res.length) return `No ${model} record matches "${a.name}".`;
      return [`${res.length} match${res.length === 1 ? '' : 'es'} in ${model}:`].concat(res.map((r) => `  id ${r[0]}: ${r[1]}`)).join('\n');
    },
  },
  {
    name: 'odoo_group_by',
    description: 'Aggregate records: counts and sums grouped by one or more fields (like a pivot). Example: total sales per customer: model sale.order, groupby ["partner_id"], aggregates ["amount_total:sum"]. Date fields can be grouped by period: "date_order:month", "invoice_date:year".',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        domain: DOMAIN_SCHEMA,
        groupby: { type: 'array', items: { type: 'string' }, description: 'Fields to group by, e.g. ["partner_id"], ["state"], ["date_order:month"].' },
        aggregates: { type: 'array', items: { type: 'string' }, description: 'Aggregates as "field:sum|avg|min|max|count", e.g. ["amount_total:sum"]. The count of records is always included.' },
        limit: { type: 'integer', description: 'Max groups (default 50).' },
      },
      required: ['model', 'groupby'],
      additionalProperties: false,
    },
    handler: async (client, a) => {
      const model = String(a.model || '').trim();
      const domain = toDomain(a.domain);
      const groupby = toStringArray(a.groupby, 'groupby') || [];
      const aggregates = (toStringArray(a.aggregates, 'aggregates') || []).filter((s) => s && !/^__count/.test(s));
      const limit = clampInt(a.limit, 50, 1, 500);
      await client.connect();
      let rows;
      if (client.major >= 18) {
        rows = await client.execute(model, 'formatted_read_group', [domain, groupby, ['__count'].concat(aggregates)], { limit });
        rows = rows.map((r) => { const o = Object.assign({}, r); delete o.__extra_domain; delete o.__domain; return o; });
      } else {
        const fields = aggregates.map((s) => s.includes(':') ? s : `${s}:sum`);
        rows = await client.execute(model, 'read_group', [domain, fields, groupby], { lazy: false, limit });
        rows = rows.map((r) => { const o = Object.assign({}, r); delete o.__domain; delete o.__context; return o; });
      }
      return truncate([`${rows.length} group${rows.length === 1 ? '' : 's'} of ${model} by ${groupby.join(', ')}:`].concat(rows.map((r) => JSON.stringify(r))).join('\n'));
    },
  },
  {
    name: 'odoo_create',
    description: 'Create one record. Confirm the details with the user first - this changes data in Odoo. Values use technical field names; many2one fields take an id (find it with odoo_name_search); one2many lines use [[0, 0, {...}]]; many2many use [[6, 0, [ids]]].',
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, values: { type: 'object', description: 'Field values, e.g. {"name":"Acme","email":"hi@acme.com","is_company":true}', additionalProperties: true } }, required: ['model', 'values'], additionalProperties: false },
    handler: async (client, a) => {
      const model = String(a.model || '').trim();
      const values = toObject(a.values, 'values');
      const res = await client.execute(model, 'create', [values], {});
      const id = Array.isArray(res) ? res[0] : res;
      return `Created ${model} record id ${id}.\nOpen it: ${client.recordUrl(model, id)}`;
    },
  },
  {
    name: 'odoo_write',
    description: 'Update fields on existing records. Confirm with the user first - this changes data in Odoo.',
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, ids: { type: 'array', items: { type: 'integer' } }, values: { type: 'object', additionalProperties: true, description: 'Fields to change, e.g. {"phone":"+1 555 0100"}' } }, required: ['model', 'ids', 'values'], additionalProperties: false },
    handler: async (client, a) => {
      const model = String(a.model || '').trim();
      const ids = toIntArray(a.ids, 'ids');
      const values = toObject(a.values, 'values');
      await client.execute(model, 'write', [ids, values], {});
      return `Updated ${ids.length} ${model} record${ids.length === 1 ? '' : 's'} (ids ${ids.join(', ')}).`;
    },
  },
  {
    name: 'odoo_delete',
    description: 'Permanently delete records. Only use after the user explicitly confirmed the deletion; prefer archiving (odoo_write with {"active": false}) when in doubt. Requires confirm=true.',
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, ids: { type: 'array', items: { type: 'integer' } }, confirm: { type: 'boolean', description: 'Must be true. Set it only after the user confirmed.' } }, required: ['model', 'ids', 'confirm'], additionalProperties: false },
    handler: async (client, a) => {
      if (a.confirm !== true) throw new OdooError('Deletion not confirmed. Ask the user to confirm, then call again with confirm=true.', 'input');
      const model = String(a.model || '').trim();
      const ids = toIntArray(a.ids, 'ids');
      await client.execute(model, 'unlink', [ids], {});
      return `Deleted ${ids.length} ${model} record${ids.length === 1 ? '' : 's'} (ids ${ids.join(', ')}).`;
    },
  },
  {
    name: 'odoo_call',
    description: 'Call any public method of a model, for workflow actions and advanced needs: e.g. action_confirm on sale.order (confirm quotation), action_post on account.move (post invoice), action_cancel, button_validate on stock.picking, message_post to add a note, or read_group/formatted_read_group for custom reports. Pass record ids in "ids" for record methods; pass other parameters by name in "kwargs". Confirm with the user before actions that change data.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        method: { type: 'string', description: 'Method name, e.g. action_confirm' },
        ids: { type: 'array', items: { type: 'integer' }, description: 'Record ids the method runs on (omit for model-level methods).' },
        args: { type: 'array', items: {}, description: 'Extra positional arguments (rarely needed; prefer kwargs).' },
        kwargs: { type: 'object', additionalProperties: true, description: 'Keyword arguments, e.g. {"body":"Hello"} for message_post.' },
      },
      required: ['model', 'method'],
      additionalProperties: false,
    },
    handler: async (client, a) => {
      const model = String(a.model || '').trim();
      const method = String(a.method || '').trim();
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(method) || method.startsWith('_')) throw new OdooError('Only public method names (letters, digits, underscores, not starting with "_") can be called.', 'input');
      const args = [];
      if (a.ids !== undefined && a.ids !== null && !(Array.isArray(a.ids) && a.ids.length === 0)) args.push(toIntArray(a.ids, 'ids'));
      if (Array.isArray(a.args)) args.push(...a.args);
      let kwargs = a.kwargs || {};
      if (typeof kwargs === 'string') kwargs = toObject(kwargs, 'kwargs');
      const res = await client.execute(model, method, args, kwargs);
      return truncate(`Result of ${model}.${method}:\n${JSON.stringify(res, null, 2)}`);
    },
  },
  {
    name: 'odoo_record_link',
    description: 'Get the web link to open a record in Odoo, to share with the user.',
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, id: { type: 'integer' } }, required: ['model', 'id'], additionalProperties: false },
    handler: async (client, a) => {
      await client.connect();
      const id = parseInt(a.id, 10);
      if (!Number.isInteger(id)) throw new OdooError('"id" must be an integer.', 'input');
      return client.recordUrl(String(a.model || '').trim(), id);
    },
  },
];

const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

const INSTRUCTIONS = [
  'This server connects to the user\'s Odoo ERP (CRM, Sales, Invoicing, Inventory, Projects, HR, ...).',
  'Workflow: 1) if unsure about a model name, call odoo_search_models; 2) call odoo_fields to learn exact field names; 3) read with odoo_search_read / odoo_count / odoo_group_by; 4) only change data (odoo_create, odoo_write, odoo_delete, odoo_call actions) after the user has confirmed the exact change.',
  'Domains are lists of [field, operator, value]. Many2one values are returned as [id, name]; to filter on them use the id or a dotted path like ["partner_id.name","ilike","acme"].',
  'Keep results small: use limit, pick fields explicitly, and use odoo_count or odoo_group_by for totals instead of fetching everything.',
  'If a tool reports a connection or login problem, run odoo_check_connection and relay its explanation to the user.',
].join(' ');

// ---------------------------------------------------------------------------
// Error -> text for Claude
// ---------------------------------------------------------------------------
function errorText(e) {
  if (e instanceof OdooError) {
    const prefix = { config: 'Odoo is not configured', network: 'Cannot reach Odoo', not_odoo: 'Not an Odoo server', db: 'Database problem', auth: 'Login failed', mfa: 'Login needs an API key', readonly: 'Read-only mode', input: 'Invalid input', session: 'Session expired', http: 'Server error', rpc: 'Odoo error' }[e.kind] || 'Odoo error';
    return `${prefix}: ${e.message}`;
  }
  return `Error: ${(e && e.message) || String(e)}`;
}

// ---------------------------------------------------------------------------
// MCP protocol over stdio
// ---------------------------------------------------------------------------
function runMcpServer(client) {
  let buffer = '';
  const send = (msg) => {
    try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) { log(`stdout write failed: ${e.message}`); }
  };
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: Object.assign({ code, message }, data ? { data } : {}) });

  async function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { id, method, params } = msg;
    const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id') && id !== null && method;
    if (!method) return; // a response to something - we never send requests
    try {
      switch (method) {
        case 'initialize': {
          const requested = params && params.protocolVersion;
          const protocolVersion = (typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested)) ? requested : DEFAULT_PROTOCOL_VERSION;
          reply(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: 'Odoo', version: SERVER_VERSION },
            instructions: INSTRUCTIONS,
          });
          // Warm up the connection in the background so the first tool call is fast.
          client.connect().catch((e) => log(`Initial connection check: ${e.message}`));
          return;
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/roots/list_changed':
        case 'notifications/progress':
          return;
        case 'ping':
          return reply(id, {});
        case 'tools/list':
          return reply(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
        case 'tools/call': {
          const name = params && params.name;
          const tool = TOOL_INDEX.get(name);
          if (!tool) return fail(id, -32602, `Unknown tool: ${name}`);
          const args = (params && params.arguments) || {};
          try {
            const text = await tool.handler(client, args);
            return reply(id, { content: [{ type: 'text', text: String(text) }], isError: false });
          } catch (e) {
            debug(`tool ${name} failed: ${e && e.stack}`);
            return reply(id, { content: [{ type: 'text', text: errorText(e) }], isError: true });
          }
        }
        case 'resources/list':
          return reply(id, { resources: [] });
        case 'resources/templates/list':
          return reply(id, { resourceTemplates: [] });
        case 'prompts/list':
          return reply(id, { prompts: [] });
        case 'logging/setLevel':
          return reply(id, {});
        case 'completion/complete':
          return reply(id, { completion: { values: [], hasMore: false } });
        default:
          if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
          return;
      }
    } catch (e) {
      log(`Error handling ${method}: ${e && e.stack}`);
      if (isRequest) fail(id, -32603, `Internal error: ${e && e.message}`);
    }
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return fail(null, -32700, 'Parse error'); }
    if (Array.isArray(msg)) { for (const m of msg) handle(m); } else handle(msg);
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '').trim();
      buffer = buffer.slice(idx + 1);
      if (line) onLine(line);
    }
  });
  const shutdown = () => {
    debug('stdin closed, exiting');
    process.exitCode = 0;
    // Let in-flight work finish and the event loop drain; force the exit only if something lingers.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.on('error', shutdown);
  process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') shutdown(); });
  process.on('uncaughtException', (e) => log(`Uncaught exception: ${e && e.stack}`));
  process.on('unhandledRejection', (e) => log(`Unhandled rejection: ${e && (e.stack || e)}`));
  log(`Odoo MCP server ${SERVER_VERSION} started (node ${process.version}); config file: ${client.cfg.configFile}`);
}

// ---------------------------------------------------------------------------
// --test mode (used by the installers)
// ---------------------------------------------------------------------------
const EXIT_CODES = { config: 10, network: 2, not_odoo: 3, db: 4, auth: 5, mfa: 6 };

async function runTest(client, asJson) {
  const out = (s) => process.stdout.write(s + '\n');
  try {
    const info = await client.connect();
    if (asJson) { out(JSON.stringify(info)); return 0; }
    out('Connected to Odoo.');
    out(`  Address:   ${info.url}`);
    out(`  Database:  ${info.database}${info.database_source ? ` (${info.database_source})` : ''}`);
    out(`  Odoo:      ${info.odoo_version} ${info.edition}`);
    out(`  User:      ${info.user || '(unknown name)'} (${info.login})`);
    out(`  Company:   ${info.company || '(not reported)'}`);
    out(`  Method:    ${info.transport}`);
    out(`  Access:    ${info.read_only ? 'read-only' : 'read and write'}`);
    return 0;
  } catch (e) {
    const kind = (e && e.kind) || 'other';
    if (asJson) { out(JSON.stringify({ ok: false, kind, message: e.message, tried: e.tried || null })); } else {
      out('Could not connect to Odoo.');
      out(`  ${e.message}`);
      if (e.tried && DEBUG) out(`  Details: ${e.tried}`);
    }
    return EXIT_CODES[kind] || 1;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) { process.stdout.write(`${SERVER_VERSION}\n`); return; }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Odoo App MCP server\n  node index.js           start MCP server (stdio)\n  node index.js --test    check the Odoo connection\n  node index.js --test --json\n  node index.js --version\n');
    return;
  }
  const cfg = loadConfig();
  const client = new OdooClient(cfg);
  if (argv.includes('--test')) {
    runTest(client, argv.includes('--json')).then((code) => {
      process.exitCode = code;
      setTimeout(() => process.exit(code), 3000).unref();
    });
    return;
  }
  runMcpServer(client);
}

if (require.main === module) main();

module.exports = { OdooClient, loadConfig, normalizeUrl, json2Body, isReadMethod, TOOLS };
