// What Claude Desktop does with the extension, for the tests: turn the values of the settings form into the
// launch command (same rules as getMcpConfigForManifest in @anthropic-ai/mcpb, src/shared/config.ts), start
// that command and speak MCP to it. Also a small zip reader for .mcpb files.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export function withTimeout(p, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function replaceVariables(value, variables) {
  if (typeof value === 'string') {
    let result = value;
    for (const [key, replacement] of Object.entries(variables)) {
      const pattern = new RegExp(`\\$\\{${key}\\}`, 'g');
      if (result.match(pattern) && !Array.isArray(replacement)) result = result.replace(pattern, replacement);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => replaceVariables(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceVariables(v, variables)]));
  return value;
}

function requiredConfigMissing(manifest, userConfig) {
  return Object.entries(manifest.user_config || {}).some(([key, option]) => option.required && (userConfig[key] === undefined || userConfig[key] === null || userConfig[key] === ''));
}

// The launch command for an installed extension, or undefined while required settings are missing.
export function mcpConfigFor(manifest, extensionPath, userConfig) {
  if (requiredConfigMissing(manifest, userConfig)) return undefined;
  const variables = { __dirname: extensionPath, pathSeparator: path.sep, '/': path.sep, HOME: os.homedir() };
  const merged = {};
  for (const [key, option] of Object.entries(manifest.user_config || {})) if (option.default !== undefined) merged[key] = option.default;
  Object.assign(merged, userConfig);
  for (const [key, value] of Object.entries(merged)) variables[`user_config.${key}`] = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  return replaceVariables({ ...manifest.server.mcp_config }, variables);
}

// What the settings form holds when the person clicks Save: the defaults, plus what they typed.
export function formValues(manifest, typed) {
  const values = {};
  for (const [key, option] of Object.entries(manifest.user_config)) if (option.default !== undefined) values[key] = option.default;
  return Object.assign(values, typed);
}

// A clean environment for the server: nothing from the developer's shell, no configuration file from an installer.
export function cleanEnv(extra) {
  const env = {};
  for (const k of ['SystemRoot', 'PATH', 'Path', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

// Starts an MCP server and returns a small client. "node" is replaced by this Node.js, as Claude Desktop supplies the runtime.
export function launchServer(command, args, env) {
  const child = spawn(command === 'node' ? process.execPath : command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let id = 0, buf = '', stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line); // stdout must carry nothing but MCP messages
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  const request = (method, params) => withTimeout(new Promise((resolve) => { const i = ++id; pending.set(i, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); }), 90000, method);
  return {
    async init() {
      const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r.result;
    },
    async tools() { return (await request('tools/list', {})).result.tools; },
    async call(name, args) { const m = await request('tools/call', { name, arguments: args || {} }); return { text: m.result.content.map((c) => c.text).join('\n'), isError: !!m.result.isError }; },
    async close() {
      child.stdin.end();
      const code = await withTimeout(new Promise((r) => child.on('exit', r)), 8000, 'server exit');
      assert.equal(code, 0, `server exit code ${code}\n${stderr}`);
    },
  };
}

// Reads a zip archive (stored or deflated entries) into { name: Buffer }.
export function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, 'bad central directory');
    const method = buf.readUInt16LE(off + 10), size = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    files[name] = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
