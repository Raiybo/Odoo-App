// Serves the repository folder over HTTP on 127.0.0.1 so the installers can be tested locally
// (ODOO_CLAUDE_BASE_URL=http://127.0.0.1:<port>). Prints {"port":N} on stdout.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(parseInt(process.env.PORT || '0', 10), '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'));
if (process.env.WATCH_STDIN === '1') { process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); }
