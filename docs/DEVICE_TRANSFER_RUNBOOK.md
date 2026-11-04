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
- The local development page now stores the replacement private CryptoKey as a non-extractable structured-cloned IndexedDB value scoped to the browser origin and authenticated Google user. It survives reload in that browser, but site-data removal, profile replacement, browser changes, malicious same-origin scripts, or key-loss still break access. It is NOT equivalent to Android Keystore and must not be used for actual customer transfers.
- Existing transfer requests created **before** this change cannot recover their lost private key. Do not approve them. Wait until expired and submit a fresh request with the revised page.
- The initial SQL migration sets expires_at to ten minutes. This deadline applies to administrative approval as well as signature proof, and is typically too short for manual support review. Do not approve real transfers under this temporary contract; split proof expiry and review expiry in a separate migration before releasing.

## Additional production blockers
- Per-account and per-IP rate limiting, support review roles/permissions, request notification, audit and alerting.
- Mandatory step-up verification and recovery flow for lost/stolen devices.
- Database transaction for concurrency-safe request creation and expiration, protection against account enumeration, clean retry semantics.
- Full regression tests, API access controls, and license/activation schema reconciliation.
- No public rollout yet.

## Testing after the IndexedDB browser update
1. Pull the latest main branch; restart the local server rooted at web/tests. Hard refresh device-management.html.
2. Authenticate and press status. Old pending request may still exist. If older than ten minutes, wait for expiry then create a new one (request_start expires stale pending rows).
3. Start a new test transfer and record request_id. The private CryptoKey is saved in IndexedDB immediately after successful server request_start.
4. Reload the same page at the SAME origin (localhost, not 127.0.0.1), enter the public key and connect. The pending key should restore, and you may sign if not already signed and not expired.
5. After successful HTTP 202, reload again and confirm status remains pending. Do not manually approve the request: only the request/proof path is verified at this stage.

## Read-only support diagnostics
```sql
select r.id, a.username, r.reason, r.state,
       r.proof_verified_at is not null as device_proof_verified,
       r.created_at, r.expires_at
from public.device_transfer_requests r
join public.accounts a on a.id = r.account_id
order by r.created_at desc limit 20;
```
Never paste private keys, bearer tokens, or user recovery codes into a support ticket.
