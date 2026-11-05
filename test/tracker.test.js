// jsdom checks using payload shapes logged from a live store. Run: npm test
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const code = fs.readFileSync(path.join(__dirname, '../dist/bigcommerce-ecommerce-tracker.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LINE = {
  id: 'line-1', parentId: null, variantId: 3986, productId: 3999, sku: 'SKU1', name: 'Cable', quantity: 1, brand: 'Dell',
  discountAmount: 0, couponAmount: 0, originalPrice: 9.99, listPrice: 9.99, salePrice: 9.99
};
const cartOf = (lines, amount) => ({
  id: 'cart-1', currency: { code: 'USD' }, cartAmount: amount, baseAmount: amount, coupons: [],
  lineItems: { physicalItems: lines, digitalItems: [], giftCertificates: [], customItems: [] }
});
const BODL_LINE = {
  product_id: '3999', sku: 'SKU1', variant_id: 3986, product_name: 'Cable', purchase_price: 10.69, sale_price: 10.69,
  base_price: 9.99, quantity: 1, brand_name: 'Dell', category_names: ['Shop By Type/Monitors', 'Shop by Brand/Dell'], currency: 'USD'
};
const ORDER = {
  orderId: 700251, currency: { code: 'USD' }, orderAmount: 17.49, taxTotal: 0.7, shippingCostTotal: 6.8, handlingCostTotal: 0,
  giftWrappingCostTotal: 0, fees: [], coupons: [],
  lineItems: { physicalItems: [{ ...LINE }], digitalItems: [], giftCertificates: [], customItems: [] },
  billingAddress: { firstName: ' Test ', lastName: 'Order', email: 'Test@Example.com ', address1: '1 Main St', city: 'Wauconda',
    stateOrProvinceCode: 'IL', countryCode: 'US', postalCode: '60084', phone: '8475550100' }
};

function setup(opts) {
  const o = Object.assign({ url: 'https://shop.test/', cart: null, order: null, events: [], config: {}, html: '', bodl: true }, opts);
  const dom = new JSDOM(`<!doctype html><body>${o.html}</body>`, { url: o.url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const state = { cart: o.cart, order: o.order, requests: [] };
  w.Promise = Promise;
  w.fetch = (u) => {
    state.requests.push(String(u));
    const u2 = String(u);
    const body = u2.includes('/carts') ? (state.cart ? [state.cart] : []) : u2.includes('/orders/') ? state.order : {};
    if (u2.includes('/orders/') && !state.order) return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) });
  };
  const subs = {};
  const on = (name) => (fn) => { (subs[name] = subs[name] || []).push(fn); };
  if (o.bodl) {
    w.bodl = { events: o.events, shopper: o.shopper || {}, data_consent: o.consent || { advertising: true } };
    w.bodlEvents = {
      cart: { viewed: on('bodl_v1_cart_viewed'), addItem: on('bodl_v1_cart_product_added'), removeItem: on('bodl_v1_cart_product_removed') },
      product: { pageViewed: on('bodl_v1_product_page_viewed'), categoryViewed: on('bodl_v1_product_category_viewed'), searchPerformed: on('bodl_v1_keyword_search') },
      checkout: { checkoutBegin: on('bodl_v1_begin_checkout'), shippingDetailsProvided: on('bodl_v1_shipping_information_added'),
        paymentDetailsProvided: on('bodl_v1_payment_information_added'), orderPurchased: on('bodl_v1_order_purchased') }
    };
  }
  w.BC_ECOM_CONFIG = o.config;
  if (o.preScript) o.preScript(w);
  w.eval(code);
  const fire = (name, p) => (subs[name] || []).forEach((f) => f(p));
  const events = (n) => (w.dataLayer || []).filter((e) => e.event === n);
  return { w, state, fire, events, dom };
}

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('view_item forces quantity 1 and ignores stock on hand', async () => {
  const t = setup({ url: 'https://shop.test/p/', events: [{ bodl_v1_product_page_viewed: { event_id: 'a', currency: 'USD', line_items: [{ ...BODL_LINE, quantity: 198, purchase_price: 9.99, sale_price: null, base_price: null }] } }] });
  const e = t.events('view_item');
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].ecommerce.value, 9.99);
  assert.strictEqual(e[0].ecommerce.items[0].quantity, 1);
  assert.strictEqual(e[0].ecommerce.items[0].item_category, 'Shop By Type');
  assert.strictEqual(e[0].ecommerce.items[0].item_category2, 'Monitors');
});

test('page-load event and subscriber replay fire once', async () => {
  const p = { event_id: 'a', currency: 'USD', line_items: [BODL_LINE] };
  const t = setup({ events: [{ bodl_v1_product_page_viewed: p }] });
  await sleep(150);
  t.fire('bodl_v1_product_page_viewed', p);
  assert.strictEqual(t.events('view_item').length, 1);
});

test('view_item_list has list fields, select_item matches by title', async () => {
  const t = setup({
    html: '<article class="card"><a id="l" href="/x/"><h4 class="card-title">Cable</h4></a></article>',
    events: [{ bodl_v1_product_category_viewed: { event_id: 'c', category_id: 333, category_name: 'Epson', line_items: [{ ...BODL_LINE, quantity: null, purchase_price: 9.99 }] } }]
  });
  const e = t.events('view_item_list')[0];
  assert.strictEqual(e.ecommerce.item_list_name, 'Epson');
  assert.strictEqual(e.ecommerce.items[0].item_list_id, '333');
  const a = t.w.document.getElementById('l');
  a.addEventListener('click', (ev) => ev.preventDefault());
  a.click();
  assert.strictEqual(t.events('select_item').length, 1);
  assert.strictEqual(t.events('select_item')[0].ecommerce.items[0].item_id, 'SKU1');
});

test('search', async () => {
  const t = setup({ events: [{ bodl_v1_keyword_search: { event_id: 's', search_keyword: 'cable' } }] });
  assert.strictEqual(t.events('search')[0].search_term, 'cable');
});

test('add_to_cart uses the pre-tax cart price, not BODL sale_price', async () => {
  const t = setup({ cart: cartOf([{ ...LINE }], 9.99) });
  await sleep(150);
  t.fire('bodl_v1_cart_product_added', { event_id: 'add', currency: 'USD', product_value: 10.69, line_items: [BODL_LINE] });
  await sleep(50);
  const e = t.events('add_to_cart');
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].ecommerce.value, 9.99);
  assert.strictEqual(e[0].ecommerce.items[0].item_category, 'Shop By Type');
});

test('add_to_cart falls back to base_price when the cart API fails', async () => {
  const t = setup({ cart: null });
  t.w.fetch = () => Promise.reject(new Error('down'));
  await sleep(10);
  t.fire('bodl_v1_cart_product_added', { event_id: 'add', currency: 'USD', line_items: [BODL_LINE] });
  await sleep(50);
  assert.strictEqual(t.events('add_to_cart').length, 1);
});

test('remove_from_cart pushes synchronously at the pre-tax price', async () => {
  const t = setup({ url: 'https://shop.test/cart.php', cart: cartOf([{ ...LINE }], 9.99),
    events: [{ bodl_v1_cart_viewed: { event_id: 'v', currency: 'USD', line_items: [BODL_LINE] } }] });
  await sleep(150);
  t.fire('bodl_v1_cart_product_removed', { event_id: 'r', currency: 'USD', line_items: [BODL_LINE] });
  const e = t.events('remove_from_cart');
  assert.strictEqual(e.length, 1, 'must exist before any await');
  assert.strictEqual(e[0].ecommerce.value, 9.99);
});

test('quantity increase on cart page fires add_to_cart with the delta only', async () => {
  const t = setup({ url: 'https://shop.test/cart.php', cart: cartOf([{ ...LINE }], 9.99),
    events: [{ bodl_v1_cart_viewed: { event_id: 'v', currency: 'USD', line_items: [BODL_LINE] } }] });
  await sleep(150);
  t.state.cart = cartOf([{ ...LINE, quantity: 3 }], 29.97);
  await t.w.fetch('/remote/v1/cart/update', { method: 'POST' });
  await sleep(1700);
  const e = t.events('add_to_cart');
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].ecommerce.items[0].quantity, 2);
  assert.strictEqual(e[0].ecommerce.value, 19.98);
});

test('quantity decrease fires remove_from_cart', async () => {
  const t = setup({ url: 'https://shop.test/cart.php', cart: cartOf([{ ...LINE, quantity: 3 }], 29.97),
    events: [{ bodl_v1_cart_viewed: { event_id: 'v', currency: 'USD', line_items: [BODL_LINE] } }] });
  await sleep(150);
  t.state.cart = cartOf([{ ...LINE, quantity: 1 }], 9.99);
  await t.w.fetch('/remote/v1/cart/update', { method: 'POST' });
  await sleep(1700);
  assert.strictEqual(t.events('remove_from_cart')[0].ecommerce.items[0].quantity, 2);
});

test('BODL add followed by watcher does not double count', async () => {
  const t = setup({ cart: cartOf([], 0) });
  await sleep(50);
  t.state.cart = cartOf([{ ...LINE }], 9.99);
  await t.w.fetch('/remote/v1/cart/add', { method: 'POST' });
  t.fire('bodl_v1_cart_product_added', { event_id: 'add', currency: 'USD', line_items: [BODL_LINE] });
  await sleep(1700);
  assert.strictEqual(t.events('add_to_cart').length, 1);
});

test('view_cart fires once from the cart API, skips empty carts', async () => {
  const t = setup({ url: 'https://shop.test/cart.php', cart: cartOf([{ ...LINE }], 9.99),
    events: [{ bodl_v1_cart_viewed: { event_id: 'v', currency: 'USD', line_items: [BODL_LINE] } }] });
  await sleep(100);
  assert.strictEqual(t.events('view_cart').length, 1);
  assert.strictEqual(t.events('view_cart')[0].ecommerce.value, 9.99);
  const t2 = setup({ url: 'https://shop.test/cart.php', cart: null, events: [{ bodl_v1_cart_viewed: { event_id: 'v', currency: null, line_items: [] } }] });
  await sleep(100);
  assert.strictEqual(t2.events('view_cart').length, 0);
});

test('checkout steps fire once per cart, with the coupon spread over items', async () => {
  const c = cartOf([{ ...LINE }], 0);
  c.coupons = [{ code: 'SAVE' }];
  const t = setup({ url: 'https://shop.test/checkout', cart: c });
  await sleep(50);
  const b = { event_id: 'x', currency: 'USD', cart_value: 0, line_items: [BODL_LINE] };
  t.fire('bodl_v1_begin_checkout', b);
  t.fire('bodl_v1_shipping_information_added', { ...b, shipping_method: 'UPS Ground' });
  t.fire('bodl_v1_payment_information_added', { ...b, payment_type: 'Credit Card' });
  await sleep(50);
  t.fire('bodl_v1_payment_information_added', { ...b, event_id: 'y', payment_type: 'Credit Card' });
  await sleep(50);
  assert.strictEqual(t.events('begin_checkout').length, 1);
  assert.strictEqual(t.events('add_shipping_info')[0].ecommerce.shipping_tier, 'UPS Ground');
  const pay = t.events('add_payment_info');
  assert.strictEqual(pay.length, 1);
  assert.strictEqual(pay[0].ecommerce.payment_type, 'Credit Card');
  assert.strictEqual(pay[0].ecommerce.value, 0);
  assert.strictEqual(pay[0].ecommerce.items[0].price, 0);
  assert.strictEqual(pay[0].ecommerce.items[0].discount, 9.99);
  assert.strictEqual(pay[0].ecommerce.coupon, 'SAVE');
});

const confirmHtml = '<script type="text/plain">x</script>';
function confirm(extra) {
  return setup(Object.assign({ url: 'https://shop.test/checkout/order-confirmation', order: ORDER, html: confirmHtml,
    preScript: (w) => { w.bcOrderId = '700251'; } }, extra));
}

test('purchase value excludes tax and shipping and equals sum of items', async () => {
  const t = confirm();
  await sleep(50);
  const e = t.events('purchase')[0];
  assert.strictEqual(e.ecommerce.transaction_id, '700251');
  assert.strictEqual(e.ecommerce.value, 9.99);
  assert.strictEqual(e.ecommerce.tax, 0.7);
  assert.strictEqual(e.ecommerce.shipping, 6.8);
  assert.strictEqual(e.ecommerce.order_total, 17.49);
  assert.strictEqual(e.ecommerce.items[0].price, 9.99);
});

test('purchaseValue total mode', async () => {
  const t = confirm({ config: { purchaseValue: 'total' } });
  await sleep(50);
  assert.strictEqual(t.events('purchase')[0].ecommerce.value, 17.49);
});

test('user_data normalized, at top level, and cleared later', async () => {
  const t = confirm();
  await sleep(50);
  const e = t.events('purchase')[0];
  assert.strictEqual(e.ecommerce.user_data, undefined);
  assert.strictEqual(e.user_data.email, 'test@example.com');
  assert.strictEqual(e.user_data.phone_number, '+18475550100');
  assert.strictEqual(e.user_data.address.first_name, 'test');
  assert.strictEqual(e.user_data.address.region, 'il');
  assert.strictEqual(e.meta_user_data.ph, '18475550100');
  assert.ok(!t.w.dataLayer.some((x) => /view|cart/.test(x.event || '') && x.user_data));
});

test('userData off, and advertising consent refused, send no customer data', async () => {
  const a = confirm({ config: { userData: 'off' } });
  await sleep(50);
  assert.strictEqual(a.events('purchase')[0].user_data, undefined);
  const b = confirm({ consent: { advertising: false } });
  await sleep(50);
  assert.strictEqual(b.events('purchase')[0].user_data, undefined);
});

test('reload of the confirmation page does not double fire', async () => {
  const t = confirm();
  await sleep(50);
  assert.strictEqual(t.events('purchase').length, 1);
  const stored = t.w.localStorage.getItem('bc_ecom_orders');
  const t2 = confirm({ preScript: (w) => { w.bcOrderId = '700251'; w.localStorage.setItem('bc_ecom_orders', stored); } });
  await sleep(50);
  assert.strictEqual(t2.events('purchase').length, 0);
});

test('test coupon pushes purchase_test with no customer data', async () => {
  const t = confirm({ config: { testCoupons: ['mytest'] }, order: { ...ORDER, orderAmount: 0, taxTotal: 0, shippingCostTotal: 0, coupons: [{ code: 'MYTEST' }] } });
  await sleep(50);
  assert.strictEqual(t.events('purchase').length, 0);
  const e = t.events('purchase_test')[0];
  assert.strictEqual(e.test_order, true);
  assert.strictEqual(e.user_data, undefined);
  assert.strictEqual(e.ecommerce.value, 0);
  assert.strictEqual(e.ecommerce.items[0].discount, 9.99);
});

test('order ID found in inline page config when no helper is installed', async () => {
  const t = setup({ url: 'https://shop.test/checkout/order-confirmation', order: ORDER,
    preScript: (w) => { const s = w.document.createElement('script'); s.type = 'text/plain'; s.textContent = 'renderOrderConfirmation({"orderId":700251,"containerId":"x"})'; w.document.body.appendChild(s); } });
  await sleep(100);
  assert.strictEqual(t.events('purchase')[0].ecommerce.transaction_id, '700251');
});

test('unrendered Handlebars or empty helper value is ignored', async () => {
  const t = setup({ url: 'https://shop.test/', preScript: (w) => { w.bcOrderId = ''; } });
  await sleep(30);
  assert.strictEqual(t.state.requests.filter((r) => r.includes('/orders/')).length, 0);
});

test('digital items and gift certificates included, bundle children excluded', async () => {
  const order = { ...ORDER, orderAmount: 37.5, lineItems: {
    physicalItems: [{ ...LINE }, { ...LINE, id: 'child', parentId: 'line-1', salePrice: 0, listPrice: 0 }],
    digitalItems: [{ ...LINE, id: 'd', sku: 'DIG', salePrice: 10, listPrice: 10, originalPrice: 10 }],
    giftCertificates: [{ id: 'g', name: 'Gift', amount: 10.01, quantity: 1 }], customItems: [] } };
  const t = confirm({ order });
  await sleep(50);
  const e = t.events('purchase')[0];
  assert.strictEqual(e.ecommerce.items.length, 3);
  assert.strictEqual(e.ecommerce.value, 30);
});

test('health event when the order API fails', async () => {
  const t = confirm({ order: null });
  await sleep(4800);
  const e = t.events('bc_ecom_error');
  assert.ok(e.some((x) => x.error_type === 'order_api_failed'));
  assert.strictEqual(t.events('purchase').length, 0);
});

test('health event when a BODL method disappears, and script survives', async () => {
  const t = setup({ preScript: (w) => { delete w.bodlEvents.cart.addItem; } });
  await sleep(150);
  assert.ok(t.events('bc_ecom_error').some((x) => x.error_type === 'bodl_events_changed'));
  assert.strictEqual(t.w.__bcEcom.status().bound, true);
});

test('store requests pass through the network hook untouched', async () => {
  const t = setup({});
  const r = await t.w.fetch('/api/storefront/carts');
  assert.strictEqual(r.ok, true);
});

test('double install is ignored', async () => {
  const t = setup({ events: [{ bodl_v1_keyword_search: { event_id: 's', search_keyword: 'x' } }] });
  t.w.eval(code);
  assert.strictEqual(t.events('search').length, 1);
});

test('logged-in user_info has no customer details', async () => {
  const t = setup({ shopper: { customer_id: 605, email: 'a@b.com' } });
  const e = t.events('user_info')[0];
  assert.strictEqual(e.user_id, '605');
  assert.strictEqual(JSON.stringify(e).includes('a@b.com'), false);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok   ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
