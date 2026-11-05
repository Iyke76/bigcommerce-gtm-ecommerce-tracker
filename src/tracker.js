/* Written in ES5 so GTM's Custom HTML validator accepts it.
 * Never write two opening curly braces in a row in this file: GTM reads them
 * as a variable and Script Manager reads them as Handlebars. The build fails if it happens. */
(function (w, d) {
  'use strict';
  if (w.__bcEcom) return;
  var VERSION = '__VERSION__';

  /* ---------------- CONFIG ---------------- */
  var CFG = {
    debug: false,            // true = log every push to the console
    // Customer data on purchase, for Google Ads Enhanced Conversions + Meta Advanced Matching.
    //   'plain'  = normalized values (Google tag + Meta Pixel hash them before sending)
    //   'hashed' = SHA-256 in the dataLayer (raw customer data never enters the dataLayer)
    //   'off'    = no customer data in the dataLayer
    userData: 'plain',
    // purchase value. 'net' = Google's spec (items after discounts, no tax or shipping).
    // 'total' = the full order total. order_total is always sent either way.
    purchaseValue: 'net',
    // Orders using one of these coupons push purchase_test instead of purchase.
    testCoupons: [],
    healthEvents: true,      // push bc_ecom_error when BigCommerce looks different than expected
    dataLayerName: 'dataLayer'
  };
  (function (o) {
    var k;
    if (o && typeof o === 'object') for (k in o) if (o.hasOwnProperty(k) && CFG.hasOwnProperty(k)) CFG[k] = o[k];
  })(w.BC_ECOM_CONFIG);

  if (!w.fetch || !w.Promise) return;

  var dl = w[CFG.dataLayerName] = w[CFG.dataLayerName] || [];
  var nativeFetch = w.fetch;
  var K_CART = 'bc_ecom_cart', K_CAT = 'bc_ecom_catalog', K_STEPS = 'bc_ecom_steps', K_DONE = 'bc_ecom_orders';
  var CART_URL = '/api/storefront/carts?include=lineItems.physicalItems.options,lineItems.digitalItems.options';
  var RX_MUTATE = /\/remote\/v1\/cart\/(add|update)|\/api\/storefront\/carts/;
  var RX_CONFIRM = /(order-confirmation|finishorder)/i;
  var RX_CHECKOUT = /^\/(checkout|checkout\.php)(\/|$)/i;
  var RX_CART = /^\/cart\.php/i;

  var seen = {}, errors = {}, recent = {}, history = [], lastList = null;
  var tail = Promise.resolve(), reconcileTimer = null, cartViewed = false;
  var purchaseStarted = false, bound = false;

  /* ---------------- helpers ---------------- */
  function log() {
    if (CFG.debug && w.console) w.console.log.apply(w.console, ['[bc-ecom]'].concat([].slice.call(arguments)));
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function round(n) { return Math.round((n + 1e-9) * 100) / 100; }
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function store(type, k, v) {
    try {
      var s = w[type];
      if (arguments.length === 2) return JSON.parse(s.getItem(k) || 'null');
      if (v === null) s.removeItem(k); else s.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
    return null;
  }
  function ss(k, v) { return arguments.length === 1 ? store('sessionStorage', k) : store('sessionStorage', k, v); }
  function ls(k, v) { return arguments.length === 1 ? store('localStorage', k) : store('localStorage', k, v); }
  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) { health('script_exception', e && e.message); }
      return undefined;
    };
  }
  function enqueue(fn) {
    tail = tail.then(fn)['catch'](function (e) { health('script_exception', e && e.message); });
    return tail;
  }
  function health(type, detail) {
    if (errors[type]) return;
    errors[type] = str(detail).slice(0, 150) || true;
    log('health', type, detail);
    if (CFG.healthEvents) {
      dl.push({ event: 'bc_ecom_error', error_type: type, error_detail: str(detail).slice(0, 150), bc_ecom_version: VERSION });
    }
  }
  function pushEcom(name, ecommerce, extra) {
    var o = { event: name, ecommerce: ecommerce }, k;
    if (extra) for (k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k];
    dl.push({ ecommerce: null });
    dl.push(o);
    history.push({ event: name, value: ecommerce && ecommerce.value, at: new Date().getTime() });
    if (history.length > 20) history.shift();
    log(name, ecommerce);
  }

  /* ---------------- catalog cache ---------------- */
  /* The cart and order APIs have no categories, so keep what BODL gave us earlier in the session. */
  function remember(li) {
    var id = str(li.product_id), cat;
    if (!id) return;
    cat = ss(K_CAT) || {};
    cat[id] = { b: li.brand_name || '', c: (li.category_names || []).slice(0, 1) };
    var keys = Object.keys(cat);
    if (keys.length > 200) delete cat[keys[0]];
    ss(K_CAT, cat);
  }
  function addCategories(item, names) {
    var parts = names && names[0] ? String(names[0]).split('/') : [], i;
    for (i = 0; i < parts.length && i < 5; i++) item[i === 0 ? 'item_category' : 'item_category' + (i + 1)] = parts[i];
  }

  /* ---------------- item mapping ---------------- */
  function fromBodl(li, i, price) {
    var item = {
      item_id: li.sku || str(li.product_id),
      item_name: li.product_name || '',
      price: round(price),
      quantity: 1,
      index: typeof li.index === 'number' ? li.index : i
    };
    if (li.brand_name) item.item_brand = li.brand_name;
    addCategories(item, li.category_names);
    return item;
  }
  function viewPrice(li) { return num(li.purchase_price) || num(li.sale_price) || num(li.base_price); }
  /* AJAX add/remove payloads carry sale_price WITH tax and base_price without it. */
  function mutationPrice(li) { return num(li.base_price) || num(li.sale_price) || num(li.purchase_price); }

  function allLines(lineItems) {
    var out = [];
    if (!lineItems) return out;
    [lineItems.physicalItems, lineItems.digitalItems, lineItems.customItems].forEach(function (list) {
      (list || []).forEach(function (l) { if (!l.parentId) out.push(l); });
    });
    (lineItems.giftCertificates || []).forEach(function (g) {
      out.push({ id: g.id, name: g.name || 'Gift certificate', sku: 'gift_certificate', quantity: g.quantity || 1, salePrice: g.amount, listPrice: g.amount });
    });
    return out;
  }
  function lineItem(l, i) {
    var price = l.salePrice !== undefined && l.salePrice !== null ? num(l.salePrice) : num(l.listPrice);
    var item = {
      item_id: l.sku || str(l.productId) || str(l.id),
      item_name: l.name || '',
      price: round(price),
      quantity: l.quantity || 1,
      index: i
    };
    var list = Math.max(num(l.listPrice), num(l.originalPrice));
    var cached = (ss(K_CAT) || {})[str(l.productId)];
    if (list > price) item.discount = round(list - price);
    if (l.brand || (cached && cached.b)) item.item_brand = l.brand || cached.b;
    if (cached) addCategories(item, cached.c);
    if (l.options && l.options.length) {
      item.item_variant = l.options.map(function (o) { return o.value; }).join(' / ').slice(0, 100);
    }
    return item;
  }
  function sum(items) {
    return round(items.reduce(function (t, it) { return t + num(it.price) * (it.quantity || 1); }, 0));
  }
  /* Coupons and order discounts are only reported at cart level. Spread them over
     the items so price is the discounted unit price and value = sum(price * quantity). */
  function allocate(items, target) {
    var total = sum(items);
    if (total <= 0 || Math.abs(total - target) < 0.005) return items;
    var ratio = target / total;
    items.forEach(function (it) {
      var net = round(it.price * ratio);
      it.discount = round(num(it.discount) + it.price - net);
      it.price = net;
    });
    return items;
  }

  /* ---------------- cart API ---------------- */
  function getJson(url) {
    return nativeFetch.call(w, url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('http_' + r.status);
      return r.json();
    });
  }
  function getCart() {
    return getJson(CART_URL).then(function (carts) {
      var cart = carts && carts[0];
      if (cart && !cart.lineItems) health('cart_shape', 'lineItems missing');
      return cart && cart.lineItems ? cart : null;
    });
  }
  function currencyOf(cart) { return (cart.currency && cart.currency.code) || 'USD'; }
  function cartItems(cart) {
    return allocate(allLines(cart.lineItems).map(lineItem), num(cart.cartAmount));
  }
  function couponOf(obj) {
    var c = obj && obj.coupons && obj.coupons[0];
    return c && c.code ? c.code : '';
  }
  function snapshot(cart) {
    var lines = {};
    allLines(cart.lineItems).forEach(function (l, i) {
      lines[l.id] = { p: str(l.productId), v: str(l.variantId), q: l.quantity || 1, item: lineItem(l, i) };
    });
    return { id: cart.id, lines: lines };
  }
  function findSnapLine(snap, productId, variantId) {
    var k, l, match = null;
    if (!snap) return null;
    for (k in snap.lines) {
      if (!snap.lines.hasOwnProperty(k)) continue;
      l = snap.lines[k];
      if (l.p === str(productId)) {
        if (variantId && l.v === str(variantId)) return { key: k, line: l };
        if (!match) match = { key: k, line: l };
      }
    }
    return match;
  }
  function pushMutation(name, items, currency) {
    if (!items.length) return;
    pushEcom(name, { currency: currency, value: sum(items), items: items });
  }

  /* Compares the cart with the last copy. Catches changes BODL doesn't announce,
     such as quantity changes on the cart page. */
  function reconcile() {
    return getCart().then(function (cart) {
      var prev = ss(K_CART), adds = [], removes = [], now = new Date().getTime();
      if (!cart) { ss(K_CART, null); return null; }
      var next = snapshot(cart);
      ss(K_CART, next);
      if (!prev || prev.id !== next.id) return cart;
      Object.keys(next.lines).forEach(function (k) {
        var n = next.lines[k], p = prev.lines[k], delta = n.q - (p ? p.q : 0), it;
        if (!delta) return;
        it = JSON.parse(JSON.stringify(n.item));
        it.quantity = Math.abs(delta);
        if (delta > 0) { recent[n.p] = now; adds.push(it); } else { removes.push(it); }
      });
      Object.keys(prev.lines).forEach(function (k) {
        if (!next.lines[k]) removes.push(prev.lines[k].item);
      });
      pushMutation('add_to_cart', adds, currencyOf(cart));
      pushMutation('remove_from_cart', removes, currencyOf(cart));
      return cart;
    })['catch'](function (e) { health('cart_api_failed', e && e.message); return null; });
  }
  function scheduleReconcile() {
    if (reconcileTimer) w.clearTimeout(reconcileTimer);
    reconcileTimer = w.setTimeout(function () { enqueue(reconcile); }, 1500);
  }

  /* ---------------- BODL cart events ---------------- */
  function onAdd(p) {
    var lis = (p.line_items || []).filter(function (li) {
      var t = recent[str(li.product_id)];
      return !(t && new Date().getTime() - t < 5000);
    });
    if (!lis.length) return;
    lis.forEach(remember);
    enqueue(function () {
      return getCart()['catch'](function (e) { health('cart_api_failed', e && e.message); return null; }).then(function (cart) {
        var snap = cart ? snapshot(cart) : null;
        var items = lis.map(function (li, i) {
          var hit = findSnapLine(snap, li.product_id, li.variant_id), it;
          it = hit ? JSON.parse(JSON.stringify(hit.line.item)) : fromBodl(li, i, mutationPrice(li));
          if (hit) addCategories(it, li.category_names);
          it.quantity = li.quantity > 0 ? li.quantity : 1;
          it.index = i;
          return it;
        });
        if (snap) ss(K_CART, snap);
        pushMutation('add_to_cart', items, p.currency || (cart && currencyOf(cart)) || 'USD');
      });
    });
  }
  /* Remove must push straight away: the cart page reloads right after this event. */
  function onRemove(p) {
    var snap = ss(K_CART);
    var items = (p.line_items || []).map(function (li, i) {
      var hit = findSnapLine(snap, li.product_id, li.variant_id), it, qty = li.quantity > 0 ? li.quantity : 1;
      it = hit ? JSON.parse(JSON.stringify(hit.line.item)) : fromBodl(li, i, mutationPrice(li));
      it.quantity = qty;
      it.index = i;
      if (hit) {
        hit.line.q -= qty;
        if (hit.line.q <= 0) delete snap.lines[hit.key];
      }
      return it;
    });
    if (snap) ss(K_CART, snap);
    pushMutation('remove_from_cart', items, p.currency || 'USD');
  }

  /* ---------------- view events ---------------- */
  function onProductView(p) {
    var lis = p.line_items || [];
    if (!lis.length) return;
    lis.forEach(remember);
    var items = lis.map(function (li, i) {
      return fromBodl(li, i, viewPrice(li)); /* BODL quantity here is stock on hand: never use it */
    });
    pushEcom('view_item', { currency: p.currency || 'USD', value: sum(items), items: items });
  }
  function onCategoryView(p) {
    var lis = p.line_items || [], listId = str(p.category_id), listName = p.category_name || '';
    if (!lis.length) return;
    lis.forEach(remember);
    var items = lis.map(function (li, i) {
      var it = fromBodl(li, i, viewPrice(li));
      it.item_list_id = listId;
      it.item_list_name = listName;
      return it;
    });
    lastList = { id: listId, name: listName, items: items, currency: (lis[0] && lis[0].currency) || 'USD', raw: lis };
    pushEcom('view_item_list', { item_list_id: listId, item_list_name: listName, items: items });
  }
  function onSearch(p) {
    if (p.search_keyword) {
      dl.push({ event: 'search', search_term: p.search_keyword });
      history.push({ event: 'search', at: new Date().getTime() });
      log('search', p.search_keyword);
    }
  }
  function viewCart(bodlPayload) {
    if (cartViewed) return;
    cartViewed = true;
    enqueue(function () {
      return reconcile().then(function (cart) {
        var items, lis;
        if (cart) {
          items = cartItems(cart);
          if (items.length) pushEcom('view_cart', { currency: currencyOf(cart), value: num(cart.cartAmount), items: items, coupon: couponOf(cart) || undefined });
          return;
        }
        lis = bodlPayload && bodlPayload.line_items;
        if (lis && lis.length) {
          items = lis.map(function (li, i) { var it = fromBodl(li, i, mutationPrice(li)); it.quantity = li.quantity || 1; return it; });
          pushEcom('view_cart', { currency: bodlPayload.currency || 'USD', value: sum(items), items: items });
        }
      });
    });
  }

  /* ---------------- checkout ---------------- */
  /* BODL can fire these steps several times per order, so each fires once per cart. */
  function checkoutStep(step, eventName, extra, bodlPayload) {
    enqueue(function () {
      return getCart()['catch'](function (e) { health('cart_api_failed', e && e.message); return null; }).then(function (cart) {
        var id = cart ? cart.id : 'nocart', steps = ss(K_STEPS) || {}, ecom, k, items, lis;
        if (!steps[id]) steps = {};
        steps[id] = steps[id] || {};
        if (steps[id][step]) return;
        if (cart) {
          items = cartItems(cart);
          ecom = { currency: currencyOf(cart), value: num(cart.cartAmount), items: items };
          if (couponOf(cart)) ecom.coupon = couponOf(cart);
        } else {
          lis = (bodlPayload && bodlPayload.line_items) || [];
          items = lis.map(function (li, i) { var it = fromBodl(li, i, num(li.sale_price) || viewPrice(li)); it.quantity = li.quantity || 1; return it; });
          ecom = { currency: (bodlPayload && bodlPayload.currency) || 'USD', value: bodlPayload ? num(bodlPayload.cart_value) : 0, items: items };
        }
        if (!items.length) return;
        for (k in extra) if (extra.hasOwnProperty(k) && extra[k]) ecom[k] = extra[k];
        steps[id][step] = 1;
        ss(K_STEPS, steps);
        pushEcom(eventName, ecom);
      });
    });
  }

  /* ---------------- customer data ---------------- */
  function clean(v) { return str(v).replace(/^\s+|\s+$/g, ''); }
  function phoneE164(raw, country) {
    var s = clean(raw), digits = s.replace(/\D/g, '');
    if (!digits) return '';
    if (s.charAt(0) === '+') return '+' + digits;
    if (country === 'US' || country === 'CA') {
      if (digits.length === 10) return '+1' + digits;
      if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
    }
    return ''; /* unknown dial code: a wrong number is worse than none */
  }
  function buildUserData(b) {
    var u = {}, a = {}, c = clean(b.countryCode).toUpperCase(), phone = phoneE164(b.phone, c);
    if (clean(b.email)) u.email = clean(b.email).toLowerCase();
    if (phone) u.phone_number = phone;
    if (clean(b.firstName)) a.first_name = clean(b.firstName).toLowerCase();
    if (clean(b.lastName)) a.last_name = clean(b.lastName).toLowerCase();
    if (clean(b.address1)) a.street = clean(b.address1).toLowerCase();
    if (clean(b.city)) a.city = clean(b.city).toLowerCase();
    if (clean(b.stateOrProvinceCode)) a.region = clean(b.stateOrProvinceCode).toLowerCase();
    if (clean(b.postalCode)) a.postal_code = clean(b.postalCode).toLowerCase();
    if (c) a.country = c;
    if (Object.keys(a).length) u.address = a;
    return u;
  }
  function metaFrom(u) {
    var a = u.address || {}, m = {};
    if (u.email) m.em = u.email;
    if (u.phone_number) m.ph = u.phone_number.replace(/\D/g, '');
    if (a.first_name) m.fn = a.first_name;
    if (a.last_name) m.ln = a.last_name;
    if (a.city) m.ct = a.city.replace(/\s/g, '');
    if (a.region) m.st = a.region;
    if (a.postal_code) m.zp = a.postal_code.replace(/\s/g, '');
    if (a.country) m.country = a.country.toLowerCase();
    return m;
  }
  function sha256(text) {
    return w.crypto.subtle.digest('SHA-256', new w.TextEncoder().encode(text)).then(function (buf) {
      return [].map.call(new w.Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  function hashValues(o) {
    var keys = Object.keys(o), out = {};
    return Promise.all(keys.map(function (k) {
      if (o[k] && typeof o[k] === 'object') return hashValues(o[k]).then(function (v) { out[k] = v; });
      if (k === 'country') { out[k] = o[k]; return null; }
      return sha256(o[k]).then(function (h) { out[k] = h; });
    })).then(function () { return out; });
  }
  function userDataFor(order) {
    var consent = w.bodl && w.bodl.data_consent, u;
    if (CFG.userData === 'off' || !order.billingAddress) return Promise.resolve(null);
    if (consent && consent.advertising === false) return Promise.resolve(null);
    u = buildUserData(order.billingAddress);
    if (CFG.userData !== 'hashed') return Promise.resolve({ user_data: u, meta_user_data: metaFrom(u) });
    if (!w.crypto || !w.crypto.subtle) { health('hash_unavailable', ''); return Promise.resolve(null); }
    return Promise.all([hashValues(u), hashValues(metaFrom(u))]).then(function (r) {
      return { user_data: r[0], meta_user_data: r[1] };
    })['catch'](function () { health('hash_unavailable', ''); return null; });
  }

  /* ---------------- purchase ---------------- */
  function validId(v) { return /^\d+$/.test(str(v)) ? str(v) : ''; }
  function findOrderId() {
    var id = validId(w.bcOrderId), scripts, i, m;
    if (id) return id;
    scripts = d.getElementsByTagName('script');
    for (i = 0; i < scripts.length; i++) {
      if (scripts[i].src) continue;
      m = /["'\\]*orderId["'\\]*\s*:\s*["'\\]*(\d+)/.exec(scripts[i].textContent || '');
      if (m) return m[1];
    }
    return '';
  }
  function isDone(id) { return (ls(K_DONE) || []).indexOf(id) > -1; }
  function markDone(id) {
    var a = ls(K_DONE) || [];
    a.push(id);
    ls(K_DONE, a.slice(-50));
  }
  function isTestOrder(order) {
    var list = (CFG.testCoupons || []).map(function (c) { return str(c).toUpperCase(); });
    return (order.coupons || []).some(function (c) { return list.indexOf(str(c.code).toUpperCase()) > -1; });
  }
  function pushPurchase(id, order) {
    var fees = (order.fees || []).reduce(function (t, f) { return t + num(f.cost || f.amount); }, 0);
    var extras = num(order.handlingCostTotal) + num(order.giftWrappingCostTotal) + fees;
    var shipping = num(order.shippingCostTotal) + num(order.handlingCostTotal);
    var total = num(order.orderAmount);
    var net = round(Math.max(0, total - num(order.taxTotal) - num(order.shippingCostTotal) - extras));
    var items = allocate(allLines(order.lineItems).map(lineItem), net);
    if (!items.length) health('order_shape', 'no line items');
    var ecom = {
      transaction_id: id,
      currency: (order.currency && order.currency.code) || 'USD',
      value: CFG.purchaseValue === 'total' ? total : net,
      tax: round(num(order.taxTotal)),
      shipping: round(shipping),
      order_total: total,
      items: items
    };
    if (couponOf(order)) ecom.coupon = couponOf(order);
    var test = isTestOrder(order);
    return (test ? Promise.resolve(null) : userDataFor(order)).then(function (ud) {
      var extra = { event_id: 'purchase_' + id }, cleared = {};
      if (ud) { extra.user_data = ud.user_data; extra.meta_user_data = ud.meta_user_data; }
      if (test) extra.test_order = true;
      if (isDone(id)) return;
      markDone(id);
      pushEcom(test ? 'purchase_test' : 'purchase', ecom, extra);
      if (ud) {
        cleared.user_data = null;
        cleared.meta_user_data = null;
        w.setTimeout(function () { dl.push(cleared); }, 5000);
      }
      ss(K_CART, null);
    });
  }
  function fetchOrder(id, attempt) {
    return getJson('/api/storefront/orders/' + id)['catch'](function (e) {
      if (attempt >= 3) throw e;
      return new Promise(function (res) { w.setTimeout(res, 1500 * attempt); }).then(function () { return fetchOrder(id, attempt + 1); });
    });
  }
  function startPurchase(idHint) {
    var tries = 0;
    if (purchaseStarted) return;
    purchaseStarted = true;
    (function attempt() {
      var id = validId(idHint) || findOrderId();
      if (!id) {
        if (++tries < 40) { w.setTimeout(safe(attempt), 250); return; }
        health('order_id_missing', location.pathname);
        return;
      }
      if (isDone(id)) { log('order already tracked', id); return; }
      enqueue(function () {
        return fetchOrder(id, 1).then(function (order) { return pushPurchase(id, order); })['catch'](function (e) {
          health('order_api_failed', e && e.message);
        });
      });
    })();
  }

  /* ---------------- BODL wiring ---------------- */
  /* Page-load events live in bodl.events and subscribers also get a replay, so every
     event passes through route() and is handled once by name + id. */
  var routes = {
    bodl_v1_product_page_viewed: onProductView,
    bodl_v1_product_category_viewed: onCategoryView,
    bodl_v1_keyword_search: onSearch,
    bodl_v1_cart_viewed: viewCart,
    bodl_v1_cart_product_added: onAdd,
    bodl_v1_cart_product_removed: onRemove,
    bodl_v1_begin_checkout: function (p) { checkoutStep('begin', 'begin_checkout', {}, p); },
    bodl_v1_shipping_information_added: function (p) { checkoutStep('shipping', 'add_shipping_info', { shipping_tier: p.shipping_method }, p); },
    bodl_v1_payment_information_added: function (p) { checkoutStep('payment', 'add_payment_info', { payment_type: p.payment_type }, p); },
    bodl_v1_order_purchased: function (p) { startPurchase(p.order_id); }
  };
  function route(name, p) {
    var key = name + ':' + (p && p.event_id);
    if (!routes[name] || (p && p.event_id && seen[key])) return;
    seen[key] = 1;
    routes[name](p || {});
  }
  function scanBodl() {
    var events = (w.bodl && w.bodl.events) || [];
    events.forEach(function (e) {
      Object.keys(e).forEach(function (name) { safe(route)(name, e[name]); });
    });
  }
  function sub(group, method, name) {
    var be = w.bodlEvents;
    if (be && be[group] && typeof be[group][method] === 'function') {
      be[group][method](safe(function (p) { route(name, p); }));
      return;
    }
    health('bodl_events_changed', group + '.' + method);
  }
  function bindBodl() {
    if (bound) return;
    bound = true;
    sub('product', 'pageViewed', 'bodl_v1_product_page_viewed');
    sub('product', 'categoryViewed', 'bodl_v1_product_category_viewed');
    sub('product', 'searchPerformed', 'bodl_v1_keyword_search');
    sub('cart', 'viewed', 'bodl_v1_cart_viewed');
    sub('cart', 'addItem', 'bodl_v1_cart_product_added');
    sub('cart', 'removeItem', 'bodl_v1_cart_product_removed');
    sub('checkout', 'checkoutBegin', 'bodl_v1_begin_checkout');
    sub('checkout', 'shippingDetailsProvided', 'bodl_v1_shipping_information_added');
    sub('checkout', 'paymentDetailsProvided', 'bodl_v1_payment_information_added');
    sub('checkout', 'orderPurchased', 'bodl_v1_order_purchased');
  }
  function waitForBodl() {
    var tries = 0;
    (function poll() {
      if (w.bodl) scanBodl();
      if (w.bodlEvents && w.bodlEvents.cart) { bindBodl(); return; }
      if (++tries < 100) { w.setTimeout(safe(poll), 100); return; }
      health('bodl_missing', 'enable BODL or check the theme');
    })();
  }

  /* ---------------- network watcher (cart changes BODL misses) ---------------- */
  function watches(url, method) {
    return RX_MUTATE.test(str(url)) && str(method || 'GET').toUpperCase() !== 'GET';
  }
  function hookNetwork() {
    w.fetch = function (input, init) {
      var url = input && input.url ? input.url : input;
      var method = (init && init.method) || (input && input.method);
      var result = nativeFetch.apply(this, arguments);
      try {
        if (watches(url, method)) result.then(scheduleReconcile, function () {});
      } catch (e) { /* never affect the store's own request */ }
      return result;
    };
    var X = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
    if (!X) return;
    var open = X.open, send = X.send;
    X.open = function (method, url) {
      try { this.__bcEcomWatch = watches(url, method); } catch (e) { /* ignore */ }
      return open.apply(this, arguments);
    };
    X.send = function () {
      try { if (this.__bcEcomWatch) this.addEventListener('loadend', scheduleReconcile); } catch (e) { /* ignore */ }
      return send.apply(this, arguments);
    };
  }

  /* ---------------- select_item ---------------- */
  function closest(el, sel) {
    while (el && el.nodeType === 1) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentNode;
    }
    return null;
  }
  function onClick(ev) {
    if (!lastList) return;
    var a = closest(ev.target, 'a[href]'), card, id, titleEl, title, i, idx = -1;
    if (!a) return;
    card = closest(a, '[data-entity-id],[data-product-id],.card,article');
    if (!card) return;
    id = card.getAttribute('data-entity-id') || card.getAttribute('data-product-id');
    titleEl = card.querySelector('.card-title,[data-test-info-type="productName"],h3,h4');
    title = clean(titleEl ? titleEl.textContent : a.textContent);
    for (i = 0; i < lastList.raw.length; i++) {
      if ((id && str(lastList.raw[i].product_id) === id) || (title && lastList.raw[i].product_name === title)) { idx = i; break; }
    }
    if (idx < 0) return;
    pushEcom('select_item', {
      item_list_id: lastList.id,
      item_list_name: lastList.name,
      currency: lastList.currency,
      value: lastList.items[idx].price,
      items: [lastList.items[idx]]
    });
  }

  /* ---------------- boot ---------------- */
  w.__bcEcom = {
    version: VERSION,
    status: function () {
      return {
        version: VERSION,
        config: CFG,
        bodl: !!w.bodl,
        bodlEvents: !!w.bodlEvents,
        bound: bound,
        orderId: findOrderId(),
        cart: ss(K_CART),
        errors: errors,
        lastEvents: history.slice(-10)
      };
    }
  };

  safe(function () {
    var path = location.pathname, customer;
    hookNetwork();
    d.addEventListener('click', safe(onClick), true);

    if (w.bodl && w.bodl.shopper && w.bodl.shopper.customer_id) {
      customer = str(w.bodl.shopper.customer_id);
      dl.push({ event: 'user_info', user_id: customer });
    }

    waitForBodl();
    w.addEventListener('load', safe(scanBodl));

    if (RX_CONFIRM.test(path) || validId(w.bcOrderId)) {
      startPurchase();
      return;
    }
    if (RX_CART.test(path)) {
      /* BODL normally triggers this. The timer covers BODL being off. */
      w.setTimeout(safe(function () { viewCart(null); }), 2500);
    } else if (RX_CHECKOUT.test(path)) {
      w.setTimeout(safe(function () { checkoutStep('begin', 'begin_checkout', {}, null); }), 3000);
    }
    log('ready', VERSION);
  })();
})(window, document);
