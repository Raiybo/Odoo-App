// Assembles build/site: exactly the files the public site serves (the guide, the extension, the installers
// and what they download). That folder is what gets deployed; nothing else from the repository is published.
//
//   node scripts/build-site.mjs        (run `npm run build` first so bundle/ and odoo.mcpb are current)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build', 'site');

const FILES = [
  'index.html', 'icon.png', 'odoo.mcpb',
  'assets/odoo-app-bundle.js',
  'bundle/manifest.json', 'bundle/package.json', 'bundle/icon.png', 'bundle/server/index.js',
  'install.sh', 'install.ps1',
  'server/index.js', 'server/setup.js',
  // Two tiny test pages, so the deployed site can be checked with BASE_URL=... npm run test:browser
  'tests/browser/bundle-test.html', 'tests/browser/redirect-test.html',
];

// The installers are piped into a shell, so they must arrive as plain text.
const HEADERS = `/install.sh
  Content-Type: text/plain; charset=utf-8
/install.ps1
  Content-Type: text/plain; charset=utf-8
/odoo.mcpb
  Content-Type: application/octet-stream
`;

fs.rmSync(out, { recursive: true, force: true });
for (const rel of FILES) {
  const from = path.join(root, rel);
  if (!fs.existsSync(from)) throw new Error(`${rel} is missing (run "npm run build" first)`);
  const to = path.join(out, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
fs.writeFileSync(path.join(out, '_headers'), HEADERS);

// Guards for mistakes that only show up on a teammate's computer.
const read = (rel) => fs.readFileSync(path.join(out, rel));
if (read('install.sh').includes(13)) throw new Error('install.sh has Windows line endings; bash would fail on it');
if (!read('bundle/server/index.js').equals(read('server/index.js'))) throw new Error('bundle/ is stale: run "npm run build"');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (JSON.parse(read('bundle/manifest.json')).version !== pkg.version) throw new Error('bundle/manifest.json is stale: run "npm run build"');
for (const rel of ['install.sh', 'install.ps1', 'bundle/manifest.json', 'server/index.js', 'server/setup.js', 'assets/odoo-app-bundle.js']) {
  if (/github/i.test(read(rel).toString('utf8'))) throw new Error(`${rel} mentions GitHub; teammates must only see the site address`);
}

const total = FILES.reduce((n, rel) => n + read(rel).length, 0);
console.log(`built build/site: ${FILES.length} files + _headers, ${Math.round(total / 1024)} KB, version ${pkg.version}`);
