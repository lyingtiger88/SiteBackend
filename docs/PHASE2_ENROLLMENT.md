# Phase 2 — Secure enrollment implementation checklist

Database baseline: 11 application tables exist in Supabase project yztithydgdvydaktuxlw (user-confirmed, not independently queried). GitHub integration is linked, production auto-deployment OFF.

## Security prerequisites
1. Verify RLS is enabled on all 11 public tables.
2. Check anon and authenticated roles cannot read or write accounts/devices/licenses (no broad grants or permissive policies).
3. Build separate staging rollout; never paste service-role keys into frontend.
4. Use Supabase Auth or another established identity provider for usernames/passwords; do not hand-roll password/session protocols. If mapping username -> email or internal auth identity, prevent account enumeration.
5. Enrollment challenge MUST be rate limited, cryptographically random, single-use and short-lived; verify signature before binding public key to device.
6. Bind device/identity atomically in a trusted server transaction. Existing accounts and devices are currently a draft schema; no endpoint is deployed.
7. Device identifier alone (including ANDROID_ID) is not proof of device ownership.
8. Provide username + password and verified recovery email or equivalent before transfer to protect purchased license.
9. Never grant a paid license from enrollment alone.

## First endpoints to implement
- POST /v2/devices/enroll/start: create short-lived challenge for a new install.
- POST /v2/devices/enroll/finish: verify public-key signature; create provisional account+device transactionally; return limited enrollment token.
- POST /v2/accounts/complete-registration: associate verified identity credentials with provisional account.
- GET /v2/accounts/me: return user/device registration state.

## Test matrix
- Same challenge reused: reject.
- Invalid signature: reject without account creation.
- Tampered public key: reject.
- Parallel double enroll with same device key: exactly one binding.
- Unauthenticated read of accounts/licenses: denied.
- Device A key cannot complete device B challenge.
- Registration with no internet: local pending state, no paid activation.

## Verification query (run from Supabase SQL Editor, read-only)
```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('accounts','devices','products','prices','orders','payments','licenses','activations','device_transfers','license_checks','audit_logs')
order by tablename;
```
Expect all 11 `rowsecurity = true`. This alone does not prove all policies/privileges are safe, but is the first required check.
