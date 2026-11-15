# Kaliia Soft — Website routes

Brand: **کالیا سافت (Kaliia Soft)**.

## Implemented static pages
- `web/index.html` — storefront home and product cards.
- `web/products/zurvan/index.html` — Zurvan product page.
- `web/products/maal/index.html` — Maal product page.
- `web/products/shopmanager/index.html` — ShopManager product page.
- `web/products/health-bridge/index.html` — informational-only Health Bridge page (no checkout).
- `web/manual-payment/index.html` — account registration/login, manual payment receipt submission, customer request history, admin tariff and payment review.
- `web/admin/documents.html` — private document archive for customers and administrators.

## Product catalog
- Zurvan, Maal and ShopManager: commercial products. Checkout links pass the selected product to `/manual-payment/?product=<product-id>`.
- پل سلامت (`health-bridge`): informational-only product; not shown as purchasable in the checkout catalog.

## Replaceable screenshot placeholders
Product detail pages intentionally contain separate Desktop and Android screenshot placeholders. Replace each placeholder with approved product screenshots only after the final images are supplied. The home page also has a clearly marked hero image placeholder per product.

## Deployment
Publish the contents of the `web/` directory as the static website document root over HTTPS. Preserve the directory structure so `/products/<id>/`, `/manual-payment/` and `/admin/documents.html` resolve. If hosting does not support directory index files, configure a fallback/rewrite to each `index.html`.

Supabase Edge Function CORS currently allows `https://kaliia.ir`, `https://www.kaliia.ir` and localhost development origins. If the final public domain differs, update both Edge Function allowlists and redeploy before production.

## Still required before accepting real payments
1. Publish the site to the actual hosting account and configure DNS/HTTPS.
2. Admin enters the real destination card number and cardholder name in the payment page.
3. Admin enters real tariffs for each product and duration; no plan is enabled by default.
4. Complete an end-to-end test using a verified customer account and an authorized superadmin.
5. Configure and test database and Storage backups.
6. Supply and replace screenshot placeholders; confirm product descriptions and feature lists against the actual released builds.
7. Connect and test product-specific license checks in all desktop and Android clients.

## Multi-product licensing API
- Supabase Edge Function: `kaliia-entitlement` (JWT verification required).
- Request: `POST /functions/v1/kaliia-entitlement` with `{action:"status"|"start_trial", product_id:"zurvan"|"maal"|"shopmanager"}`.
- Trial issuance is server-side, account/product scoped, one-time, and 45 days. An existing expired/revoked/suspended license is never replaced with a fresh trial.
- Response includes `entitlement.can_write`, `status`, `expires_at`, `days_remaining`, and `trial_available`.
- Client applications must use verified Supabase Auth access tokens and the publishable key only. Never distribute the service-role key.
- Client-side enforcement must be integrated at repository/domain mutation boundaries and, for online APIs, server-side command handlers. Disabling buttons alone is not sufficient.
