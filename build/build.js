#!/usr/bin/env node
// Builds every install file in dist/ from src/tracker.js.
'use strict';
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { minify } = require('terser');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const MAJOR = VERSION.split('.')[0];
const REPO = 'Iyke76/bigcommerce-gtm-ecommerce-tracker';
const CDN = `https://cdn.jsdelivr.net/gh/${REPO}@${MAJOR}/dist/bigcommerce-ecommerce-tracker.min.js`;
const dist = path.join(root, 'dist');

const banner = `/*!
 * BigCommerce GTM Ecommerce Tracker v${VERSION} (BigCommerce -> GA4 ecommerce dataLayer)
 * https://github.com/${REPO}
 * MIT License (c) 2026 Iyke Abel
 */
`;
const CONFIG = `window.BC_ECOM_CONFIG = {
  debug: false,          // true = log every push to the console
  userData: 'plain',     // 'plain' | 'hashed' | 'off': customer data on purchase, for Enhanced Conversions
  purchaseValue: 'net',  // 'net' = Google's spec, no tax or shipping | 'total' = full order total
  testCoupons: []        // e.g. ['MYTEST']: orders with these coupons push purchase_test instead
};
`;
const ORDER_LINE = `window.bcOrderId = '{{checkout.order.id}}';`;

function fail(msg) { console.error('BUILD FAILED: ' + msg); process.exit(1); }

(async () => {
  const src = fs.readFileSync(path.join(root, 'src/tracker.js'), 'utf8').replace(/__VERSION__/g, VERSION);
  if (src.includes('{{')) fail('source contains two opening braces');
  try { acorn.parse(src, { ecmaVersion: 5 }); } catch (e) { fail('not ES5: ' + e.message); }

  const min = (await minify(src, { ecma: 5, compress: true, mangle: true, format: { comments: false } })).code;
  if (min.includes('{{')) fail('minified output contains two opening braces');
  acorn.parse(min, { ecmaVersion: 5 });

  fs.mkdirSync(dist, { recursive: true });
  const loader = `(function () {
  var s = document.createElement('script');
  s.src = '${CDN}';
  s.async = true;
  document.head.appendChild(s);
})();`;
  const files = {
    'bigcommerce-ecommerce-tracker.js': banner + src,
    'bigcommerce-ecommerce-tracker.min.js': banner + min + '\n',
    // Option A: GTM, paste
    'gtm-paste.html': `<script>\n${banner}${CONFIG}${min}\n</script>\n`,
    // Option B: GTM, hosted
    'gtm-hosted.html': `<script>\n${CONFIG}${loader}\n</script>\n`,
    // Optional companion for A and B
    'gtm-order-id-helper.script-manager.html': `<script>${ORDER_LINE}</script>\n`,
    // Option C: Script Manager, paste
    'script-manager-paste.html': `<script>\n${banner}${ORDER_LINE}\n${CONFIG}${min}\n</script>\n`,
    // Option D: Script Manager, hosted
    'script-manager-hosted.html': `<script>\n${ORDER_LINE}\n${CONFIG}${loader}\n</script>\n`
  };
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dist, name), body);
    console.log(name.padEnd(45), body.length);
  }
  if (files['gtm-paste.html'].length > 102400) fail('GTM paste is over the Custom HTML limit');
  if (files['script-manager-paste.html'].length > 65536) fail('Script Manager paste is over 65,536 characters');
})();
