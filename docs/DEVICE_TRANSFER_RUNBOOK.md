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


## Admin review release (new migration)
1. Review and apply `supabase/migrations/20261105090000_admin_device_transfer_review.sql` in Supabase SQL Editor. This migration adds the explicit admin allow-list and audit table, extends proof-verified requests to a seven-day review window, and adds a transaction that moves device binding and all active license activations atomically.
2. Add the trusted operator to the allow-list only after independently verifying their identity. Obtain their Supabase Auth user UUID from Authentication > Users, then run:
```sql
insert into public.zurvan_admin_users(auth_user_id,role)
values ('REPLACE-WITH-VERIFIED-AUTH-USER-UUID','superadmin');
```
Do not use the ordinary customer account unless it is intentionally designated as an administrator.
3. Deploy `admin-device-transfers` via GitHub Actions. Select that function in the workflow. Deploy `device-management` again too, so successful proof extends the review deadline to seven days.
4. Use `http://localhost:8085/admin-device-transfers.html` in the same browser profile with the allow-listed admin session and publishable key.
5. Approve only after out-of-band owner verification. Approval revokes the previous device row, inserts the new device, revokes old active license activations, increments active license generations, inserts new activations, updates request state, and writes an admin audit row in one DB transaction.
6. Rejection requires a reason and leaves the current device binding unchanged.

## Critical release caveats
- The initial migration and admin function assume the existing live schema has `public.accounts`, `public.devices`, `public.licenses`, and `public.activations`. Verify all four before running the migration. The repo also contains an alternate `zurvan_*` schema; the currently deployed enrollment/device API uses the unprefixed tables.
- Admin allow-list bootstrap is a privileged manual action; never expose the service-role key in browser code.
- Test first with a disposable account that has no paid license, then with a dedicated test license. Verify rollback behavior and audit rows.
- Offline clients may continue using previously cached authorization until their next online check; immediate offline revocation is impossible.


## 42P01 hotfix / live schema mismatch (2026-11-05)
Apply `supabase/migrations/20261105093000_fix_admin_transfer_schema.sql` AFTER the admin review migration and BEFORE any further approval tests. The earlier admin_review_device_transfer() body mistakenly references missing `public.licenses` and `public.activations` tables. The canonical paid-license tables are `public.zurvan_licenses`, `public.zurvan_activations`, and `public.zurvan_devices` while enrollment and transfer requests use `public.accounts` / `public.devices`.

The hotfix atomically updates the enrollment device and, if active paid licenses exist for `req.auth_user_id`, updates their activations on a separate `zurvan_devices` row, increments license generations, and logs `zurvan_device_transfers`. It rejects any case where the active license binding cannot be matched by exact current device key fingerprint. This is deliberate; never bypass the mismatch check by replacing the missing tables with duplicate placeholders.

To see whether this account has any canonical licenses BEFORE approving, run in SQL Editor:
```sql
select l.id,l.status,l.generation,l.account_id,
       a.id as activation_id,a.revoked_at,d.key_fingerprint
from public.zurvan_licenses l
left join public.zurvan_activations a on a.license_id=l.id and a.revoked_at is null
left join public.zurvan_devices d on d.id=a.device_id
where l.account_id=(
 select auth_user_id from public.accounts
 where username='zurvan_admin01'
)
order by l.created_at;
```
If this returns zero rows, the account has no paid license in the canonical schema. An approved transfer changes the registered device only, not a paid license. A browser-only Ed25519 key must NOT be treated as a hardware-bound Android device key. Test approvals only with disposable accounts and confirm audit output and rollback behavior. No automatic deployment of SQL migrations occurs in the existing GitHub workflow.
