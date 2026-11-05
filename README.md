# BigCommerce GTM Ecommerce Tracker

Full GA4 ecommerce tracking for BigCommerce Stencil stores, with Enhanced Conversions data on `purchase`. One script, installed through Google Tag Manager or BigCommerce Script Manager. You choose.

It reads BigCommerce's own data: the Big Open Data Layer (BODL) for what happened, and the Storefront Cart and Orders APIs for correct prices. Nothing is scraped from the theme, so theme edits don't break it.

## Why this exists

Copying BODL straight into the dataLayer gives wrong numbers. Logged on a live store:

- BODL's add and remove payloads can include tax in `sale_price` ($10.69 for a $9.99 item), while the cart page payload doesn't.
- On product and category pages, BODL's `quantity` is stock on hand, not a quantity. Value = price x 198 if you use it.
- Changing a quantity on the cart page fired no BODL add event in testing.
- BODL's payment step can fire more than once per order, and before a payment method is chosen.
- `bodl_v1_order_purchased` did not fire on a tested $0 order, so `purchase` can't rely on it.

## Choose an install

Every option pushes the same events. Install **one**. A second copy on the same page does nothing.

| | File in `dist/` | Where | Updates |
|---|---|---|---|
| **A. GTM, paste** | `gtm-paste.html` | GTM Custom HTML tag | You paste each new version |
| **B. GTM, hosted** | `gtm-hosted.html` | GTM Custom HTML tag | Fixes in version 1.x arrive from this repo |
| **C. Script Manager, paste** | `script-manager-paste.html` | Script Manager | You paste each new version |
| **D. Script Manager, hosted** | `script-manager-hosted.html` | Script Manager | Fixes in version 1.x arrive from this repo |

**GTM vs Script Manager:** GTM gives you Preview, versions and rollback, and needs no store admin access. Script Manager gets the order number officially from BigCommerce. In GTM the script reads it from the confirmation page instead, which isn't a documented BigCommerce feature, so add the one-line helper below as a backup.

**Paste vs hosted:** paste has no outside dependency, and nothing changes until you change it. Hosted means one fix reaches every store, but your tracking then relies on jsDelivr and on trusting this repo's releases. For a locked-down setup, fork the repo and point the loader at your fork.

Neither route adapts to a BigCommerce change by itself. Someone has to ship the fix. The `bc_ecom_error` health event is how you find out it's needed.

### GTM (A or B)

1. Create a **Custom HTML** tag, paste the file, trigger **All Pages** (or Initialization - All Pages).
2. Recommended: in Script Manager, add `gtm-order-id-helper.script-manager.html`. Placement: **Footer**. Location: **Order confirmation**. Category: **Essential**. Script type: **Script**.
3. Check that the GTM container loads on checkout and order confirmation. It must be installed through Script Manager with **All pages** selected, or in the theme for those pages too.

### Script Manager (C or D)

Create a script. Placement: **Footer**. Location: **All pages**. Script type: **Script**. Paste the file.

"All pages" is the option that includes checkout and order confirmation. "Storefront pages" does not. If the store uses the cookie consent banner, the category you choose decides when the script may load.

A new script can take a few minutes to appear on the storefront. It took about five in testing, so wait before deciding it failed.

**Checkout security:** BigCommerce asks for an integrity hash on URL-type scripts that run on checkout (PCI DSS 6.4.3). The hosted options load the file from a small inline script, so no hash is enforced, and a future 1.x update can change what runs on your checkout. If the store has PCI requirements, use a paste option or pin an exact version such as `@1.0.0`, and include the script in your PCI script inventory.

### Send the events to your tags

1. **Custom Event** trigger, regex on:
   `^(view_item_list|select_item|view_item|add_to_cart|remove_from_cart|view_cart|begin_checkout|add_shipping_info|add_payment_info|purchase)$`
2. **GA4 Event** tag: event name `{{Event}}`, More Settings > Ecommerce > **Send Ecommerce data**, source Data Layer.
3. Google Ads conversion tag: read `ecommerce.value`, `ecommerce.transaction_id`, `ecommerce.currency`.
4. Remove every older ecommerce script, or events will double count. Check Script Manager, Data Solutions (Affiliate Conversion Tracking) and the theme.

## Events

| Event | When | Source |
|---|---|---|
| `view_item_list` | Category or brand page | BODL |
| `select_item` | Click on a product card in that list | BODL + page |
| `view_item` | Product page | BODL |
| `search` | Keyword search (`search_term`) | BODL |
| `add_to_cart` | Add, or quantity raised on the cart page | BODL + Cart API |
| `remove_from_cart` | Remove, or quantity lowered | BODL + Cart API |
| `view_cart` | Cart page, not when empty | Cart API |
| `begin_checkout` | Once per cart | BODL + Cart API |
| `add_shipping_info` | Once per cart (`shipping_tier`) | BODL + Cart API |
| `add_payment_info` | Once per cart (`payment_type`) | BODL + Cart API |
| `purchase` | Confirmation page, once per order | Orders API |
| `purchase_test` | As `purchase`, for a coupon in `testCoupons` | Orders API |
| `user_info` | Logged-in shopper (`user_id` only) | BODL |
| `bc_ecom_error` | Health event | Script |

## Purchase payload

```js
{
  event: "purchase",
  event_id: "purchase_700254",       // use as Meta eventID
  ecommerce: {
    transaction_id: "700254",
    currency: "USD",
    value: 9.99,                     // items after discounts, no tax or shipping
    tax: 0.70,
    shipping: 6.80,                  // shipping + handling
    order_total: 17.49,              // what the customer paid
    coupon: "SAVE10",
    items: [{
      item_id: "SKU123",
      item_name: "Display cable",
      item_brand: "Dell",
      item_category: "Shop By Type",
      item_category2: "Monitors",
      price: 9.99,                   // discounted unit price
      discount: 0,
      quantity: 1,
      index: 0
    }]
  },
  user_data: {                       // Google Enhanced Conversions
    email: "jane@example.com",
    phone_number: "+18475550100",
    address: { first_name: "jane", last_name: "doe", street: "1 main st", city: "chicago", region: "il", postal_code: "60601", country: "US" }
  },
  meta_user_data: { em: "jane@example.com", ph: "18475550100", fn: "jane", ln: "doe", ct: "chicago", st: "il", zp: "60601", country: "us" }
}
```

**Value:** Google's event reference says `value` is the sum of `price * quantity`, without tax or shipping. That's the default, so GA4 revenue won't equal BigCommerce order totals, by design. Use `order_total` to reconcile, or set `purchaseValue: 'total'`. If you switch an existing Google Ads account to `net`, conversion values will drop, so review any value-based bidding targets first.

## Enhanced Conversions

**The default `userData: 'plain'` puts readable customer data in the dataLayer on the `purchase` push, on the confirmation page only.** Any script on that page can read it, as it can read the page itself. Choose `'hashed'` for SHA-256 values or `'off'` for none. The script removes these keys from the GTM data model 5 seconds after the push.

- **Google Ads:** create a User-Provided Data variable, type Manual, and map Data Layer Variables such as `user_data.email`, `user_data.phone_number`, `user_data.address.first_name`.
- **GA4:** don't send `user_data` to GA4 event tags. GA4's terms prohibit personal data in event parameters.
- Customer data is left out when BODL reports advertising consent as refused.
- Phone numbers are only sent when the dial code is known: a number already starting with `+`, or a US or Canadian billing address.

## Configuration

Set in `window.BC_ECOM_CONFIG`, at the top of each install file.

| Option | Default | What it does |
|---|---|---|
| `debug` | `false` | Console logs. Testing only |
| `userData` | `'plain'` | `'plain'`, `'hashed'` or `'off'` |
| `purchaseValue` | `'net'` | `'net'` (Google's spec) or `'total'` (full order total) |
| `testCoupons` | `[]` | Orders using these codes push `purchase_test`, without customer data |
| `healthEvents` | `true` | Push `bc_ecom_error` |
| `dataLayerName` | `'dataLayer'` | A different array name. Useful for testing beside live tags |

`testCoupons` matters because excluding test orders in GA4 doesn't stop the Google Ads purchase tag firing.

## Health events

`bc_ecom_error` carries `error_type`, `error_detail` and `bc_ecom_version`. Send it to GA4 and set an alert.

| Type | Meaning |
|---|---|
| `bodl_missing` | BODL never loaded |
| `bodl_events_changed` | A BODL method this script uses has gone |
| `cart_api_failed`, `cart_shape` | The Cart API failed or looks different |
| `order_id_missing` | No order number on the confirmation page |
| `order_api_failed`, `order_shape` | The Orders API failed or looks different |
| `hash_unavailable` | `'hashed'` mode without browser crypto |
| `script_exception` | An error inside the script. The store isn't affected |

## Debugging

```js
window.__bcEcom.status()
```

Returns version, config, BODL state, order ID, cart copy, errors and the last 10 events.

## Tested

- 26 jsdom tests: `npm test`.
- Live on one store (November 2026, Stencil, tax-exclusive, USD, guest shopper): every event above except `user_info` and `bc_ecom_error`, AJAX and link-based add to cart, quantity up and down, trash removal, $0 orders, reload protection and `purchase_test`.
- Real installs of the hosted route on that store: a GTM tag in Preview, where `user_data.email` reached the Google Ads tags with no helper line, and a temporary Script Manager script, where `{{checkout.order.id}}` supplied the order number and stayed empty on other pages.

## Not yet verified on a live store

- A paid order, the paste options, or `user_data` delivery confirmed in Google Ads reporting
- Logged-in customers, variants with options, sale-priced products, digital items, bundles, gift certificates
- Tax-inclusive stores: non-purchase values include tax there because the Cart API prices do, and `purchase` net value relies on `taxTotal`
- Multi-currency stores, order-level discounts other than coupons
- Other themes: `select_item` relies on product card markup and may not fire

## Known limitations

- Stencil only. Headless and Catalyst stores don't have this checkout or BODL setup.
- `add_shipping_info` and `add_payment_info` follow BODL's timing. `add_payment_info` fires on reaching the payment step, before a card is entered.
- Purchases need the buyer to reach the confirmation page. Offsite payment methods that don't return, refunds and phone orders aren't tracked.
- `purchase` deduplication uses `localStorage`, so the same order reopened in another browser can fire again. Google and GA4 should treat it as a duplicate through `transaction_id`.
- Needs a Custom HTML tag in GTM. Containers that block Custom HTML must use Script Manager.
- Consent is handled by your tags, apart from the customer data rule above.

## Development

Edit `src/tracker.js`, then `npm test`. The source must stay ES5 and must never contain two opening curly braces in a row, because GTM and Script Manager would read them as template syntax. The build fails if either rule is broken.

## License

MIT. See [LICENSE](LICENSE).

## Author

Iyke Abel
LinkedIn: https://www.linkedin.com/in/iykeabel/
Email: abeliyke05@gmail.com
