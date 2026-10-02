// Preload for tests (node --require): resolves every *.odoo-app.test host name to 127.0.0.1, so the
// connector can be pointed at the fake Odoo through a host name instead of an IP address.
'use strict';

const dns = require('dns');

const realLookup = dns.lookup;
dns.lookup = function lookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (!/\.odoo-app\.test$/.test(String(hostname))) return realLookup.call(dns, hostname, options, cb);
  if (options && options.all) return process.nextTick(cb, null, [{ address: '127.0.0.1', family: 4 }]);
  return process.nextTick(cb, null, '127.0.0.1', 4);
};
