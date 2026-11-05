# Changelog

## Unreleased

- Added `dist/bigcommerce-gtm-ecommerce-container.json`, a GTM import file. The tracker code is unchanged.

## 1.0.0 (2026-11-05)

First public release.

- GA4 ecommerce funnel from BODL plus the Storefront Cart and Orders APIs.
- Four install routes from one source: GTM or Script Manager, pasted or hosted.
- Pre-tax cart prices, quantity change detection, once-per-cart checkout steps and once-per-order purchase.
- `user_data` and `meta_user_data` on purchase: plain, hashed or off.
- `purchaseValue`, `testCoupons`, the `bc_ecom_error` health event and `window.__bcEcom.status()`.
