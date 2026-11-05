# SiteBackend — Zurvan License and Subscription Server

Central source repository for Zurvan identity, annual subscription entitlements, device licensing and payment integration.

> **Status: architecture/database and payment adapter source code only. No production payment gateway, deployed API or live subscription service is active yet.**

## Agreed product rules
- **Prepaid annual subscription**; each verified payment grants 12 months. No lifetime license.
- Renewal extends the existing entitlement by 12 months from the later of now or current expiry.
- Premium features are available only while the server-side entitlement is valid.
- Exactly **one active device binding per account/product** at the server.
- Account creation is free and enables the basic calendar tier; purchasing a valid annual subscription unlocks premium features.
- Iran: prices in **toman** (convert explicitly to gateway rial); other regions require a separately approved provider. Never treat a return URL as payment confirmation.
- Check entitlement status every **72 hours** when online. Previously activated clients may continue offline after a network failure subject to the approved offline grace policy.
- Account recovery/transfer: sign in on the new device, step-up authentication, declare reason (broken/sold/lost/upgrade), revoke prior device binding atomically, advance license generation, bind new device.
- Legacy special codes must be migrated securely without hard-coding credentials in distributed clients.

## Payment and deployment
Zarinpal v4 adapter source is under `supabase/functions/zurvan-create-zarinpal-payment` and `supabase/functions/zurvan-zarinpal-callback`. GitHub is the source repository, not the running server. Merchant credentials and signing keys belong only in Supabase secrets.

## Delivery milestones
1. Schema review, migrations and backend authorization.
2. Identity and device challenge/proof-of-possession.
3. Signed entitlement issuance, validation and transfer transaction.
4. Zarinpal sandbox verification, renewal and expiry tests.
5. Storefront/admin pricing and subscription management.
6. Android/Windows entitlement integration and automated security tests.
