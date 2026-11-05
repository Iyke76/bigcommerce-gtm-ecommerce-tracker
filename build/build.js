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

const FUNNEL = '^(view_item_list|select_item|view_item|add_to_cart|remove_from_cart|view_cart|begin_checkout|add_shipping_info|add_payment_info|purchase)$';
const P = (type, key, value) => ({ type, key, value });
const T = (key, value) => P('TEMPLATE', key, value);
const B = (key, value) => P('BOOLEAN', key, String(value));
const IDS = { accountId: '0', containerId: '0', fingerprint: '0' };

function buildContainer(trackerHtml) {
  let id = 0;
  const next = () => String(++id);
  const dlv = (name) => ({ ...IDS, variableId: next(), name: 'BC DLV - ' + name, type: 'v', parameter: [P('INTEGER', 'dataLayerVersion', '2'), B('setDefaultValue', false), T('name', name)] });
  const constant = (name, value) => ({ ...IDS, variableId: next(), name, type: 'c', parameter: [T('value', value)] });
  const ce = (name, value) => ({ ...IDS, triggerId: next(), name, type: 'CUSTOM_EVENT', customEventFilter: [{ type: 'MATCH_REGEX', parameter: [T('arg0', '{{_event}}'), T('arg1', value)] }] });

  const fields = { email: 'email', phone_number: 'phone_number', first_name: 'address.first_name', last_name: 'address.last_name', street: 'address.street', city: 'address.city', region: 'address.region', postal_code: 'address.postal_code', country: 'address.country' };
  const health = ['error_type', 'error_detail', 'bc_ecom_version'];
  const variable = [
    constant('BC - GA4 Measurement ID', 'G-XXXXXXXXXX'),
    constant('BC - Google Ads Conversion ID', '123456789'),
    constant('BC - Google Ads Conversion Label', 'REPLACE_WITH_LABEL'),
    ...['ecommerce.value', 'ecommerce.transaction_id', 'ecommerce.currency'].map(dlv),
    ...health.map(dlv),
    ...Object.values(fields).map((f) => dlv('user_data.' + f))
  ];
  variable.push({
    ...IDS, variableId: next(), name: 'BC - User-Provided Data', type: 'awec',
    parameter: [T('mode', 'MANUAL'), ...Object.entries(fields).map(([k, f]) => T(k, '{{BC DLV - user_data.' + f + '}}'))]
  });

  const funnel = ce('BC CE - Ecommerce funnel', FUNNEL);
  const purchase = ce('BC CE - purchase', '^purchase$');
  const error = ce('BC CE - bc_ecom_error', '^bc_ecom_error$');

  const tag = [
    {
      ...IDS, tagId: next(), name: 'BC - Ecommerce Tracker', type: 'html',
      parameter: [T('html', trackerHtml), B('supportDocumentWrite', false)],
      firingTriggerId: ['2147479553'], tagFiringOption: 'ONCE_PER_LOAD',
      notes: 'GTM paste option, on All Pages. Edit BC_ECOM_CONFIG at the top. Remove older ecommerce scripts before publishing or events double count.'
    },
    {
      ...IDS, tagId: next(), name: 'GA4 - BC ecommerce events', type: 'gaawe',
      parameter: [T('eventName', '{{Event}}'), T('measurementIdOverride', '{{BC - GA4 Measurement ID}}'), B('sendEcommerceData', true), T('getEcommerceDataFrom', 'dataLayer')],
      firingTriggerId: [funnel.triggerId], tagFiringOption: 'ONCE_PER_EVENT',
      notes: 'Sends the funnel with the items array. Do not add user_data here: GA4 terms prohibit personal data in event parameters.'
    },
    {
      ...IDS, tagId: next(), name: 'GA4 - bc_ecom_error', type: 'gaawe',
      parameter: [
        T('eventName', 'bc_ecom_error'), T('measurementIdOverride', '{{BC - GA4 Measurement ID}}'), B('sendEcommerceData', false),
        { type: 'LIST', key: 'eventSettingsTable', list: health.map((h) => ({ type: 'MAP', map: [T('parameter', h), T('parameterValue', '{{BC DLV - ' + h + '}}')] })) }
      ],
      firingTriggerId: [error.triggerId], tagFiringOption: 'ONCE_PER_EVENT',
      notes: 'Health event. Set an alert on it in GA4.'
    },
    {
      ...IDS, tagId: next(), name: 'GAds - BC purchase (paused)', type: 'awct', paused: true,
      parameter: [
        T('conversionId', '{{BC - Google Ads Conversion ID}}'), T('conversionLabel', '{{BC - Google Ads Conversion Label}}'),
        T('conversionValue', '{{BC DLV - ecommerce.value}}'), T('orderId', '{{BC DLV - ecommerce.transaction_id}}'), T('currencyCode', '{{BC DLV - ecommerce.currency}}'),
        B('enableEnhancedConversion', true), T('cssProvidedEnhancedConversionValue', '{{BC - User-Provided Data}}'),
        B('enableConversionLinker', true), T('conversionCookiePrefix', '_gcl'), B('enableProductReporting', false), B('enableNewCustomerReporting', false), B('enableShippingData', false), B('rdp', false)
      ],
      firingTriggerId: [purchase.triggerId], tagFiringOption: 'ONCE_PER_EVENT',
      notes: 'Paused so it cannot fire with placeholders. Set the conversion ID and label variables, then unpause. If you already have a purchase tag, delete this one and reuse the variables.'
    }
  ];

  const exportTime = '2026-11-05 00:00:00';
  const container = { path: 'accounts/0/containers/0', accountId: '0', containerId: '0', name: 'BigCommerce GTM Ecommerce Tracker', publicId: 'GTM-XXXXXXX', usageContext: ['WEB'], fingerprint: '0', tagManagerUrl: '' };
  return {
    exportFormatVersion: 2,
    exportTime,
    containerVersion: {
      path: 'accounts/0/containers/0/versions/0', accountId: '0', containerId: '0', containerVersionId: '0',
      name: 'BigCommerce GTM Ecommerce Tracker v' + VERSION,
      container, tag, trigger: [funnel, purchase, error], variable,
      builtInVariable: [{ accountId: '0', containerId: '0', type: 'EVENT', name: 'Event' }],
      fingerprint: '0'
    }
  };
}

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
  // GTM container for Admin > Import Container
  const container = buildContainer(files['gtm-paste.html']);
  const containerFile = 'bigcommerce-gtm-ecommerce-container.json';
  fs.writeFileSync(path.join(dist, containerFile), JSON.stringify(container, null, 2) + '\n');
  console.log(containerFile.padEnd(45), JSON.stringify(container).length);
  if (files['gtm-paste.html'].length > 102400) fail('GTM paste is over the Custom HTML limit');
  if (files['script-manager-paste.html'].length > 65536) fail('Script Manager paste is over 65,536 characters');
})();
