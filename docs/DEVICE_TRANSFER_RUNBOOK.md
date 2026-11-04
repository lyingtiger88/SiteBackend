# Zurvan device management and transfer — development release

## Scope
- Authenticated account owners can view the current device without exposing device public keys.
- They can submit a reason (broken, sold, lost, upgrade) and replacement Ed25519 public key.
- A server nonce must be signed with the replacement device private key.
- Requests remain PENDING. No self-service transfer is enabled; an independently verified support/admin step is REQUIRED.
- Database ensures at most one non-revoked device per account via partial unique index. Existing account registration API does not check revoked_at; update before production if re-registration/recovery flows are added.

## Setup
1. Run supabase/migrations/20261104223000_device_transfer_requests.sql in Supabase SQL Editor after verifying accounts and devices exist.
2. Confirm the new table and partial index exist. Do not rerun the original, incomplete database/001_initial.sql.
3. Deploy supabase/functions/device-management/index.ts to the Edge Function named device-management, with legacy JWT verification OFF. It explicitly validates the caller's Supabase JWT using auth.getUser().
4. On localhost:8085, use the existing authenticated Google session in web/tests/device-management.html. Enter ONLY the public publishable key.
5. Test action status (expect account and device). Test request_start (HTTP 201) then request_finish (HTTP 202, PENDING).
6. Do not approve a transfer without independent owner verification. No in-app support-review console, step-up challenge, or operational authorization control has yet been built.

## SQL read-only verification
select id,account_id,reason,state,proof_verified_at,expires_at from public.device_transfer_requests order by created_at desc limit 10;

## Administrator workflow (not yet production ready)
- The database migration includes admin_approve_device_transfer(UUID,TEXT), executable only in the privileged postgres SQL Editor, not through the API.
- It requires a pending, unexpired request with verified new key proof and existing active device.
- Until an independent step-up and support review procedure is established, DO NOT invoke it on real accounts.
- A change of database binding does NOT revoke an old client's offline cached authorization immediately.
- When payments/licenses are added, incorporate activation revocation and license generation bump atomically; the current admin function intentionally does NOT issue or transfer a license.
- The temporary browser-generated private key is NOT durable on the replacement device; approval should only be tested using disposable data. Implement durable keystore signing on the actual replacement device before real use.

## Additional production blockers
- Per-account and per-IP rate limiting, support review roles/permissions, request notification, audit and alerting.
- Mandatory step-up verification and recovery flow for lost/stolen devices.
- Database transaction for concurrency-safe request creation and expiration, protection against account enumeration, clean retry semantics.
- Full regression tests, API access controls, and license/activation schema reconciliation.
- No public rollout yet.