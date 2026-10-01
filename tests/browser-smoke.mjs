// Real-browser test of the landing page, using a headless Chromium browser (Microsoft Edge or Google Chrome).
//   node tests/browser-smoke.mjs            run checks
//   SCREENSHOTS=dir node tests/browser-smoke.mjs   also save screenshots of the page (Mac and Windows views)
// Set BROWSER_BIN to the browser executable if it is not found automatically.
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = require(path.join(root, 'assets', 'odoo-app-bundle.js'));

function findBrowser() {
  if (process.env.BROWSER_BIN) return process.env.BROWSER_BIN;
  const candidates = process.platform === 'win32' ? [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return candidates.find((c) => fs.existsSync(c));
}

const browser = findBrowser();
if (!browser) { console.log('No Chromium-based browser found; skipping browser smoke test.'); process.exit(0); }
console.log(`browser: ${browser}`);

const server = spawn(process.execPath, [path.join(root, 'tests', 'serve-repo.mjs')], { env: { ...process.env, WATCH_STDIN: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
const port = await new Promise((resolve) => { let b = ''; server.stdout.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) resolve(JSON.parse(b.slice(0, i)).port); }); });
const base = `http://127.0.0.1:${port}/`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-app-browser-'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
function dumpDom(url, extra = []) {
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions', `--user-data-dir=${profile}`, `--user-agent=${UA}`, '--virtual-time-budget=20000', '--window-size=1280,2600', ...extra, url];
  const r = spawnSync(browser, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  if (r.error) throw r.error;
  return r.stdout;
}

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${(e.stack || e).toString().split('\n').join('\n      ')}`); }
}

await check('in-browser bundle builder produces byte-identical output to the Node builder', async () => {
  const dom = dumpDom(`${base}tests/browser/bundle-test.html?odoo=https://acme.odoo.com&company=Acme%20Corp`, ['--dump-dom']);
  const m = /<pre id="out">(OK|ERR):([\s\S]*?)<\/pre>/.exec(dom);
  assert.ok(m, `no result in DOM:\n${dom.slice(0, 500)}`);
  assert.equal(m[1], 'OK', m[2]);
  const browserBytes = Buffer.from(m[2].trim(), 'base64');
  const fakeFetch = async (u) => { const f = path.join(root, u.replace(base, '')); return { ok: fs.existsSync(f), status: 200, arrayBuffer: async () => fs.readFileSync(f) }; };
  const nodeBytes = Buffer.from(await B.buildBundle(fakeFetch, base, { odooUrl: 'https://acme.odoo.com', company: 'Acme Corp' }));
  assert.ok(browserBytes.length > 60000, `too small: ${browserBytes.length}`);
  assert.ok(browserBytes.equals(nodeBytes), 'browser and Node builds differ');
});

const textOf = (dom) => dom.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');

await check('landing page: Mac view with a team link pre-fills the Odoo address everywhere', async () => {
  const dom = dumpDom(`${base}index.html?os=mac&odoo=https://acme.odoo.com&company=Acme%20Corp`, ['--dump-dom']);
  const text = textOf(dom);
  assert.ok(/<html[^>]*data-os="mac"/.test(dom), 'mac selected');
  assert.ok(!/id="banner" hidden/.test(dom) && dom.includes('id="banner"'), 'team banner shown');
  assert.ok(text.includes('Acme Corp'), 'company name shown');
  assert.ok(text.includes('https://acme.odoo.com'), 'odoo address shown');
  assert.ok(dom.includes('ODOO_URL="https://acme.odoo.com" /bin/bash -c'), 'mac command pre-filled');
  assert.ok(dom.includes('https://acme.odoo.com/web#action=base.action_res_users_my'), 'profile link points at the company Odoo');
  assert.ok(dom.includes('https://acme.odoo.com/web/login'), 'open-odoo link');
  assert.ok(/pre-set for acme\.odoo\.com/i.test(text), 'download button mentions the pre-set address');
  assert.ok(dom.includes('https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect'), 'mac download link');
  assert.ok(dom.includes('https://claude.ai/api/desktop/win32/x64/setup/latest/redirect'), 'windows download link present in DOM (shown via CSS)');
  assert.ok(dom.includes('https://claude.ai/login'), 'sign-in link');
  assert.ok(/<title>Odoo App - Acme Corp<\/title>/.test(dom), 'title personalised');
});

await check('landing page: Windows view without a team link shows generic instructions', async () => {
  const dom = dumpDom(`${base}index.html?os=win`, ['--dump-dom']);
  const text = textOf(dom);
  assert.ok(/<html[^>]*data-os="win"/.test(dom), 'windows selected');
  assert.ok(/id="banner" hidden/.test(dom), 'no team banner');
  assert.ok(dom.includes('<code id="cmd-win">irm https://raw.githubusercontent.com/Raiybo/Odoo-App/main/install.ps1 | iex</code>'), 'windows command without a pre-filled address');
  assert.ok(dom.includes('<code id="cmd-mac">/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Raiybo/Odoo-App/main/install.sh)"</code>'), 'mac command without a pre-filled address');
  assert.ok(text.includes('Check my Odoo connection'), 'test prompt shown');
  assert.ok(/We think you are on|Pick the kind of computer/.test(text), 'detection note rendered by JS');
  assert.ok(text.includes('Download the Odoo extension (a 33 KB file called odoo.mcpb)') || text.includes('Download the Odoo extension'), 'plain download button');
});

if (process.env.ONLINE === '1') {
  // Informational only: claude.ai sits behind bot protection that may refuse headless browsers, so a
  // failure here does not prove the links are broken for real people (they are the links used by claude.com/download).
  const dom = dumpDom(`${base}tests/browser/redirect-test.html`, ['--dump-dom']);
  const m = /<pre id="out">DONE\n([\s\S]*?)<\/pre>/.exec(dom);
  const lines = m ? m[1].trim().split('\n') : ['(no result)'];
  const ok = lines.every((l) => l.startsWith('opaqueredirect '));
  console.log(`${ok ? 'PASS' : 'INFO'}  Anthropic "latest installer" links from this headless browser:\n      ${lines.join('\n      ')}`);
}

await check('landing page: team link generator produces a correct link', async () => {
  const dom = dumpDom(`${base}index.html?os=mac&gen=erp.example.com&genname=Example%20Inc`, ['--dump-dom']);
  assert.ok(dom.includes('?odoo=https%3A%2F%2Ferp.example.com&amp;company=Example%20Inc') || dom.includes('?odoo=https%3A%2F%2Ferp.example.com&company=Example%20Inc'), `generated link missing:\n${(/id="gen-out"[\s\S]{0,400}/.exec(dom) || [''])[0]}`);
});

if (process.env.SCREENSHOTS) {
  fs.mkdirSync(process.env.SCREENSHOTS, { recursive: true });
  for (const [name, q] of [['mac-team', '?os=mac&odoo=https://acme.odoo.com&company=Acme%20Corp'], ['win-plain', '?os=win'], ['mac-mobile', '?os=mac&odoo=https://acme.odoo.com&company=Acme%20Corp']]) {
    const file = path.join(process.env.SCREENSHOTS, `${name}.png`);
    const size = name.endsWith('mobile') ? '390,3200' : '1280,2600';
    dumpDom(`${base}index.html${q}`, [`--screenshot=${file}`, `--window-size=${size}`, '--hide-scrollbars']);
    console.log(`screenshot: ${file}`);
  }
}

server.stdin.end(); server.kill();
fs.rmSync(profile, { recursive: true, force: true });
console.log(failed ? `\n${failed} browser check(s) failed` : '\nbrowser smoke test passed');
process.exit(failed ? 1 : 0);
