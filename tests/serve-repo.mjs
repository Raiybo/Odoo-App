// Serves the repository folder over HTTP on 127.0.0.1 so the installers and the landing page can be
// tested locally (ODOO_CLAUDE_BASE_URL=http://127.0.0.1:<port>). Prints {"port":N} on stdout.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8', '.ps1': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
server.listen(parseInt(process.env.PORT || '0', 10), '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'));
if (process.env.WATCH_STDIN === '1') { process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); }
