// Runs the extension the way Claude Desktop does. Unpacks odoo.mcpb into a folder named like Claude's
// extension folder, turns the values of the settings form into the launch command (tests/lib/host.mjs),
// starts that command and speaks MCP to it against the fake Odoo.
//   node tests/extension-host.test.mjs
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { withTimeout, mcpConfigFor, formValues, cleanEnv, launchServer, unzip } from './lib/host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const B = require(path.join(root, 'assets', 'odoo-app-bundle.js'));

const LOGIN = 'jane@example.com';
const PASSWORD = 'S3cret!"quote';

async function startMock(env) {
  const child = spawn(process.execPath, [path.join(here, 'mock-odoo.mjs')], { env: { ...process.env, WATCH_STDIN: '1', MOCK_LOGIN: LOGIN, MOCK_PASSWORD: PASSWORD, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const info = await withTimeout(new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(JSON.parse(buf.slice(0, i))); });
    child.on('exit', (c) => reject(new Error(`mock exited with ${c}`)));
  }), 10000, 'mock start');
  return { url: `http://127.0.0.1:${info.port}`, stop: () => { child.stdin.end(); child.kill(); } };
}

const launch = (cfg) => {
  assert.equal(cfg.command, 'node');
  return launchServer(cfg.command, cfg.args, cleanEnv({ ODOO_CONFIG_FILE: path.join(here, 'no-such-config.json'), ...cfg.env }));
};

// ---------------------------------------------------------------------------
// The extension folder, as Claude Desktop lays it out (the path contains a space)
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-app-host-'));
const extDir = path.join(tmp, 'Claude Extensions', 'local.mcpb.raiybo.odoo');
const packed = unzip(fs.readFileSync(path.join(root, 'odoo.mcpb')));
for (const [name, data] of Object.entries(packed)) {
  fs.mkdirSync(path.dirname(path.join(extDir, name)), { recursive: true });
  fs.writeFileSync(path.join(extDir, name), data);
  assert.ok(data.equals(fs.readFileSync(path.join(root, 'bundle', name))), `${name} in odoo.mcpb differs from bundle/ (run "npm run build")`);
}
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
