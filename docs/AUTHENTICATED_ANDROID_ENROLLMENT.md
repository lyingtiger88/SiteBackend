# Verified Android account-device enrollment

This is an **additional** first-device path for a user already authenticated with confirmed Supabase email. It does not replace the CAPTCHA-protected anonymous browser enrollment or the support-reviewed device transfer flow.

## Deploy in this order

1. In Supabase project's SQL Editor, review and run `supabase/migrations/20261105120000_authenticated_device_enrollment.sql`.
2. In GitHub Actions > Deploy Zurvan Supabase Function > Run workflow, select `authenticated-device-enrollment` on `main`. It must show a green deploy.
3. Install an Android debug build containing `ZurvanDeviceEnrollment.kt` and the new enrollment UI.
4. Sign in with a confirmed email that has **no row in public.accounts** linked by `auth_user_id`.
5. Choose a username (lowercase a-z, digits, underscore, 4-24 chars; begins with a letter) and tap **تکمیل ثبت‌نام و اتصال دستگاه**.
6. App creates an Ed25519 software key. Private seed is encrypted at rest with AES-GCM key from Android Keystore; **the Ed25519 private key itself is not hardware-backed**.
7. API verifies JWT, creates an expiring challenge, checks signature possession, and calls a restricted atomic database transaction. On successful response, account is active and one device is registered. Reusing the same Auth account rejects with 409.

## Read-only verification

```sql
select u.id as auth_id,u.email,a.id as account_id,a.username,a.state,
 d.id as device_id,d.platform,d.revoked_at
from auth.users u
left join public.accounts a on a.auth_user_id=u.id
left join public.devices d on d.account_id=a.id and d.revoked_at is null
where u.id='5fcfb06c-7344-4c1f-9063-589daf145038';
```

Do not reset the previously registered demo account and do not insert a license as a side effect. Licensing is separate.

## Security scope

- Authenticated and confirmed email required.
- Signature covers challenge id, nonce, user id, username; challenge is single-use and 5 minutes long.
- Five challenge-start requests per authenticated user per hour. This is an application-layer throttle, not a substitute for edge/per-IP controls.
- RPC callable by service-role only. SQL enforces unique Auth user ID and device fingerprint, and username uniqueness; conflicts roll back.
- Android Keystore wrapping protects the software Ed25519 seed at rest; an unlocked compromised device can still access a running client process. Do not advertise hardware-bound key guarantees.
- Before general availability: test replay, race, offline support, key-loss recovery, and backend error paths; implement abuse monitoring. Do not turn this into automatic license issuance.
