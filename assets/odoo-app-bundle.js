/*
 * Odoo App - builds a personalised copy of the Claude Desktop extension (odoo.mcpb) in the browser.
 *
 * The published extension is a zip of four files (bundle/manifest.json, bundle/server/index.js,
 * bundle/icon.png, bundle/package.json). When a team link carries the company's Odoo address
 * (?odoo=https://mycompany.odoo.com) the landing page fetches those files, writes the address into
 * the manifest as the default value of the "Odoo address" field, and zips them again (stored, no
 * compression) so the teammate only has to type their email and password.
 *
 * Works in browsers and in Node (used by the tests): no dependencies.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OdooAppBundle = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function utf8(str) { return new TextEncoder().encode(str); }

  function writeU16(view, off, v) { view.setUint16(off, v & 0xffff, true); }
  function writeU32(view, off, v) { view.setUint32(off, v >>> 0, true); }

  // Builds a zip archive (method 0 = stored) from [{ name, data: Uint8Array }]. Fixed timestamp so
  // the same input always gives the same bytes.
  function buildZip(files) {
    var DOS_TIME = 0;
    var DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
    var parts = [];
    var centrals = [];
    var offset = 0;
    files.forEach(function (f) {
      var name = utf8(f.name);
      var data = f.data;
      var crc = crc32(data);
      var lh = new Uint8Array(30 + name.length);
      var v = new DataView(lh.buffer);
      writeU32(v, 0, 0x04034b50); writeU16(v, 4, 20); writeU16(v, 6, 0x0800); writeU16(v, 8, 0);
      writeU16(v, 10, DOS_TIME); writeU16(v, 12, DOS_DATE); writeU32(v, 14, crc); writeU32(v, 18, data.length);
      writeU32(v, 22, data.length); writeU16(v, 26, name.length); writeU16(v, 28, 0);
      lh.set(name, 30);
      parts.push(lh, data);
      var ch = new Uint8Array(46 + name.length);
      var cv = new DataView(ch.buffer);
      writeU32(cv, 0, 0x02014b50); writeU16(cv, 4, 0x031e); writeU16(cv, 6, 20); writeU16(cv, 8, 0x0800); writeU16(cv, 10, 0);
      writeU16(cv, 12, DOS_TIME); writeU16(cv, 14, DOS_DATE); writeU32(cv, 16, crc); writeU32(cv, 20, data.length); writeU32(cv, 24, data.length);
      writeU16(cv, 28, name.length); writeU16(cv, 30, 0); writeU16(cv, 32, 0); writeU16(cv, 34, 0); writeU16(cv, 36, 0);
      writeU32(cv, 38, (0x81a4 << 16) >>> 0); writeU32(cv, 42, offset);
      ch.set(name, 46);
      centrals.push(ch);
      offset += lh.length + data.length;
    });
    var cdSize = centrals.reduce(function (s, c) { return s + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    writeU32(ev, 0, 0x06054b50); writeU16(ev, 4, 0); writeU16(ev, 6, 0); writeU16(ev, 8, files.length); writeU16(ev, 10, files.length);
    writeU32(ev, 12, cdSize); writeU32(ev, 16, offset); writeU16(ev, 20, 0);
    var all = parts.concat(centrals, [eocd]);
    var total = all.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(total);
    var pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  // Normalises what a person typed as an Odoo address into https://host[:port], or returns null.
  function normalizeOdooUrl(input) {
    var s = String(input || '').trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try {
      var u = new URL(s);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (!u.hostname || !/^[a-z0-9.-]+$/i.test(u.hostname)) return null;
      return u.protocol + '//' + u.host;
    } catch (e) { return null; }
  }

  // Writes the company's Odoo address (and name) into the manifest so the field is pre-filled.
  function customizeManifest(manifestText, opts) {
    var m = JSON.parse(manifestText);
    var odooUrl = opts && normalizeOdooUrl(opts.odooUrl);
    var company = opts && String(opts.company || '').trim().slice(0, 60);
    if (odooUrl) {
      var field = m.user_config.odoo_url;
      field.default = odooUrl;
      field.description = 'Pre-filled for ' + (company || 'your company') + ' (' + odooUrl + '). Only change it if you log into Odoo at a different address.';
    }
    if (company) m.display_name = 'Odoo - ' + company;
    return JSON.stringify(m, null, 2) + '\n';
  }

  var BUNDLE_FILES = ['manifest.json', 'server/index.js', 'icon.png', 'package.json'];

  // fetchFn(url) must resolve to a Response-like object with arrayBuffer(). baseUrl ends with "/".
  function buildBundle(fetchFn, baseUrl, opts) {
    return Promise.all(BUNDLE_FILES.map(function (name) {
      return fetchFn(baseUrl + 'bundle/' + name).then(function (res) {
        if (!res.ok) throw new Error('Could not download ' + name + ' (HTTP ' + res.status + ')');
        return res.arrayBuffer();
      }).then(function (buf) { return { name: name, data: new Uint8Array(buf) }; });
    })).then(function (files) {
      files[0].data = utf8(customizeManifest(new TextDecoder().decode(files[0].data), opts));
      return buildZip(files);
    });
  }

  return { crc32: crc32, buildZip: buildZip, normalizeOdooUrl: normalizeOdooUrl, customizeManifest: customizeManifest, buildBundle: buildBundle, BUNDLE_FILES: BUNDLE_FILES };
});
