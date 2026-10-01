// Builds odoo.mcpb (the one-click Claude Desktop extension) and icon.png.
//
//   node scripts/build-mcpb.mjs
//
// Steps: stage extension/manifest.json (tool list and version filled in from the server and
// package.json) + server/index.js + icon.png + package.json into build/mcpb/, then zip them into
// odoo.mcpb with a small built-in zip writer (an .mcpb is a plain zip with manifest.json at its root).
// No dependencies are needed. If the official @anthropic-ai/mcpb CLI is available it is used to
// validate the manifest and to print the bundle info afterwards.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, 'build', 'mcpb');
const out = path.join(root, 'odoo.mcpb');

// ---------------------------------------------------------------------------
// CRC32 (shared by the zip writer and the PNG encoder)
// ---------------------------------------------------------------------------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf, seed = 0) {
  let c = seed ^ -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// Icon: Odoo purple rounded square with a white ring (an "O") and a small spark.
// ---------------------------------------------------------------------------
function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [0x71, 0x4b, 0x67]; // Odoo purple
  const fg = [0xff, 0xff, 0xff];
  const accent = [0xf0, 0xb3, 0x56];
  const r = size * 0.22; // corner radius
  const cx = size / 2, cy = size / 2;
  const ringR = size * 0.30, ringW = size * 0.11;
  const sparkX = size * 0.74, sparkY = size * 0.26, sparkR = size * 0.075;
  const smooth = (d) => Math.max(0, Math.min(1, 0.5 - d)); // d = signed distance in px -> coverage
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const X = x + 0.5, Y = y + 0.5;
      // rounded square coverage
      const qx = Math.abs(X - cx) - (size / 2 - r), qy = Math.abs(Y - cy) - (size / 2 - r);
      const dBox = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const aBox = smooth(dBox);
      // ring coverage
      const dRing = Math.abs(Math.hypot(X - cx, Y - cy) - ringR) - ringW / 2;
      const aRing = smooth(dRing);
      // spark (small filled circle) coverage
      const dSpark = Math.hypot(X - sparkX, Y - sparkY) - sparkR;
      const aSpark = smooth(dSpark);
      let col = bg.slice();
      col = col.map((c, i) => c * (1 - aRing) + fg[i] * aRing);
      col = col.map((c, i) => c * (1 - aSpark) + accent[i] * aSpark);
      const o = (y * size + x) * 4;
      px[o] = Math.round(col[0]); px[o + 1] = Math.round(col[1]); px[o + 2] = Math.round(col[2]); px[o + 3] = Math.round(255 * aBox);
    }
  }
  // PNG encode
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Minimal zip writer (deflate, UTF-8 names, forward slashes, fixed timestamp for reproducible builds)
// ---------------------------------------------------------------------------
function zip(files) {
  const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01 00:00
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = comp.length < data.length;
    const payload = useDeflate ? comp : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, payload);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(payload.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((f.mode || 0o100644) << 16 >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const { TOOLS } = require(path.join(root, 'server', 'index.js'));
manifest.version = pkg.version;
manifest.tools = TOOLS.map((t) => ({ name: t.name, description: t.description.split('. ')[0].replace(/\.$/, '') + '.' }));

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'server'), { recursive: true });
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.copyFileSync(path.join(root, 'server', 'index.js'), path.join(stage, 'server', 'index.js'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'odoo-app-mcp', version: pkg.version, description: manifest.description, main: 'server/index.js', license: 'MIT', private: true }, null, 2) + '\n');
const icon = makeIcon(512);
fs.writeFileSync(path.join(stage, 'icon.png'), icon);
fs.writeFileSync(path.join(root, 'icon.png'), icon);

const files = ['manifest.json', 'package.json', 'icon.png', 'server/index.js'].map((name) => ({ name, data: fs.readFileSync(path.join(stage, name)) }));
fs.writeFileSync(out, zip(files));
console.log(`built ${path.relative(root, out)} (${fs.statSync(out).size} bytes) with ${files.length} files; icon.png updated`);

// Optional verification with the official CLI (needs network for npx the first time).
if (process.env.MCPB_VERIFY !== '0') {
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const run = (args) => spawnSync(`npx -y @anthropic-ai/mcpb ${args.map(q).join(' ')}`, { encoding: 'utf8', shell: true, timeout: 180000 });
  const v = run(['validate', path.join(stage, 'manifest.json')]);
  if (v.error || v.status !== 0) console.log(`(mcpb validate skipped or failed: ${(v.stderr || v.stdout || v.error && v.error.message || '').trim()})`);
  else console.log(`mcpb validate: ${(v.stdout || '').trim()}`);
  const info = run(['info', out]);
  if (!info.error && info.status === 0) console.log((info.stdout || '').trim());
}
