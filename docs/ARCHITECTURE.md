# Zurvan License Server v2 — Architecture and API rules

## Actors
- Device client (Android first; desktop later)
- Public storefront (no database secrets)
- Backend API (authoritative)
- Regional payment gateway (IR or eligible global)
- Admin console (separate privileged role)

## Enrollment
1. On first launch generate a random installation UUID and non-exportable signing key pair in OS secure storage.
2. With network connectivity POST /v2/devices/enroll (public key, platform, optional diagnostic identifier). Server returns provisional account ID and signed challenge. Client proves possession of device private key.
3. User chooses a unique username and strong password. Credentials belong to the **account**, while device key authenticates the bound install. Store only Argon2id password hashes server-side.
4. Without internet provisional install may exist locally, but no paid activation is possible.

## Purchase
- Store immutable amount and currency snapshot on each order.
- IR displays toman; explicit conversion to gateway currency units must be tested with gateway integration. Global may display USD/EUR for eligible merchants and customers. The gateway is configured by server-side policy; do not rely on client region alone.
- Payment browser return is informational. Verify gateway signature/server-to-server API, amount, currency, order, merchant and final state. Reject duplicate events.
- Within one DB transaction mark paid and issue lifetime license (or return same license for retried event).
- Sign license payload (account_id, license_id, device_key_fingerprint, generation, issued_at, kind=lifetime) using server Ed25519 private key; publish key ID and verification public key only.

## Check + offline
- Try online status check when 72h has elapsed since last verified check, on next app open or when connectivity returns. Use backoff, not a busy network loop.
- A valid signed cached activation continues to work during real network outages with **no predetermined offline expiry**. Do not trust plaintext flags.
- Online ACTIVE refreshes signed grant. Online REVOKED / TRANSFERRED / SUSPENDED invalidates the local authorization. Network failures must not be confused with revocation.
- Client monotonic clock plus last server time may help detect clock rollback; no client-only scheme guarantees anti-tamper protection.
- Indefinitely offline old devices **cannot be revoked immediately**; one-device constraint is authoritative on server.

## Device transfer
1. Install app on new device, generate new key pair; use "I already have an account".
2. Authenticate username/password **plus step-up verification** (verified recovery email OTP, with guarded manual recovery if email unavailable).
3. Require reason: broken/sold/lost/upgrade and signed proof of new device key possession.
4. Lock license row; revoke existing activation, increment generation, insert new activation, write device_transfers + audit_logs atomically.
5. Return new signed grant. Old device stops at its next successful online verification.

## API (contract)
POST /v2/devices/enroll
POST /v2/accounts/complete-registration
POST /v2/auth/login
POST /v2/auth/recover
GET /v2/products/zurvan/prices
POST /v2/orders
POST /v2/payments/checkout
POST /v2/webhooks/iran
POST /v2/webhooks/global
GET /v2/licenses/me
POST /v2/licenses/activate
POST /v2/licenses/check
POST /v2/licenses/transfer-device
GET /v2/admin/licenses

Authenticated requests use scoped JWT/session tokens; admin routes enforce role-based controls. Rate-limit enrollment, login, OTP and transfer. Do not log tokens, passwords, device secrets, or unredacted payment payloads.

## Legacy migration
Keep two existing special-case activations as **grandfathered entitlements** with their original display texts. Import their hashed credentials/entitlements privately via an administrative process; do not publish old activation codes to this repository. Existing offline-only legacy versions cannot be remotely disabled.

## Acceptance tests
- Payment webhook replay issues just one license; amount mismatch issues none.
- Concurrent activation attempts cannot create two active bindings.
- Concurrent transfer requests are serialized.
- Old offline client stays usable per policy; old online client gets transferred/revoked response.
- Cached grant tampering or copied grant on another key is rejected.
- Reinstallation/key loss requires authenticated recovery.
- Incorrect OTP / brute force attempts are throttled and audited.
- RLS prevents cross-account access.
