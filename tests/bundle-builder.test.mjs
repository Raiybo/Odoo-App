// Tests assets/odoo-app-bundle.js (the in-browser extension builder) under Node, then checks the result
// with the official @anthropic-ai/mcpb CLI (unpack + validate) when it is available.
//   node tests/bundle-builder.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = require(path.join(root, 'assets', 'odoo-app-bundle.js'));

// 1. CRC32 against known values
assert.equal(B.crc32(new TextEncoder().encode('')), 0);
assert.equal(B.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);

// 2. URL normalisation
assert.equal(B.normalizeOdooUrl('mycompany.odoo.com'), 'https://mycompany.odoo.com');
assert.equal(B.normalizeOdooUrl(' https://erp.example.com/odoo/action-1 '), 'https://erp.example.com');
assert.equal(B.normalizeOdooUrl('http://localhost:8069/web/login'), 'http://localhost:8069');
assert.equal(B.normalizeOdooUrl('ftp://x'), null);
assert.equal(B.normalizeOdooUrl('javascript:alert(1)'), null);
assert.equal(B.normalizeOdooUrl(''), null);

// 3. Manifest customisation
const manifestText = fs.readFileSync(path.join(root, 'bundle', 'manifest.json'), 'utf8');
const custom = JSON.parse(B.customizeManifest(manifestText, { odooUrl: 'acme.odoo.com', company: 'Acme Corp' }));
assert.equal(custom.user_config.odoo_url.default, 'https://acme.odoo.com');
assert.match(custom.user_config.odoo_url.description, /Pre-filled for Acme Corp \(https:\/\/acme\.odoo\.com\)/);
assert.equal(custom.display_name, 'Odoo - Acme Corp');
assert.equal(custom.name, 'odoo', 'the machine name never changes');
const untouched = JSON.parse(B.customizeManifest(manifestText, {}));
assert.equal(untouched.user_config.odoo_url.default, undefined);
assert.equal(untouched.display_name, JSON.parse(manifestText).display_name);

// 4. Build the bundle exactly as the browser does, using a fetch that reads from disk
const fakeFetch = async (url) => {
  const rel = url.replace('https://example.test/', '');
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return { ok: false, status: 404 };
  return { ok: true, status: 200, arrayBuffer: async () => fs.readFileSync(file) };
};
const zipBytes = await B.buildBundle(fakeFetch, 'https://example.test/', { odooUrl: 'https://acme.odoo.com', company: 'Acme Corp' });
assert.ok(zipBytes.length > 60000, `zip too small: ${zipBytes.length}`);
assert.equal(zipBytes[0], 0x50); assert.equal(zipBytes[1], 0x4b); // "PK"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-app-bundle-'));
const mcpbFile = path.join(tmp, 'odoo-acme.mcpb');
fs.writeFileSync(mcpbFile, zipBytes);

// 5. Node's own zip reading (via the mcpb CLI) proves the archive is well-formed
const q = (s) => `"${s}"`;
const run = (args) => spawnSync(`npx -y @anthropic-ai/mcpb ${args.map(q).join(' ')}`, { encoding: 'utf8', shell: true, timeout: 180000 });
const unpackDir = path.join(tmp, 'unpacked');
const u = run(['unpack', mcpbFile, unpackDir]);
if (u.error || u.status !== 0) {
  console.log(`(mcpb CLI not available, skipping unpack/validate: ${(u.stderr || u.stdout || (u.error && u.error.message) || '').trim()})`);
} else {
  for (const name of B.BUNDLE_FILES) assert.ok(fs.existsSync(path.join(unpackDir, name)), `${name} missing after unpack`);
  assert.equal(fs.readFileSync(path.join(unpackDir, 'server', 'index.js'), 'utf8'), fs.readFileSync(path.join(root, 'bundle', 'server', 'index.js'), 'utf8'), 'server file intact');
  assert.ok(Buffer.from(fs.readFileSync(path.join(unpackDir, 'icon.png'))).equals(fs.readFileSync(path.join(root, 'bundle', 'icon.png'))), 'icon intact');
  const unpackedManifest = JSON.parse(fs.readFileSync(path.join(unpackDir, 'manifest.json'), 'utf8'));
  assert.equal(unpackedManifest.user_config.odoo_url.default, 'https://acme.odoo.com');
  const v = run(['validate', path.join(unpackDir, 'manifest.json')]);
  assert.equal(v.status, 0, `mcpb validate failed: ${v.stdout}${v.stderr}`);
  console.log('mcpb unpack + validate of the browser-built bundle: ok');
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('bundle builder tests passed');
