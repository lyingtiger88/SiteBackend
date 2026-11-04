# Google OAuth PKCE — local device-binding test

Status: committed to repository, not yet browser-verified. This is a developer-only flow.

1. Confirm Google provider is enabled in Supabase Auth with Google web OAuth client ID and secret configured.
2. Add http://localhost:8085/** to Auth Redirect URLs and configure localhost:8085/device-enrollment.html as Site URL for development.
3. Ensure Google Auth Platform Audience includes your test Google identity if the OAuth app is in Testing.
4. Deploy the account-complete-registration Edge Function from supabase/functions/account-complete-registration/index.ts and run the auth_link SQL migration.
5. Pull GitHub changes; run the local test server from web/tests on 127.0.0.1:8085; navigate using http://localhost:8085/device-enrollment.html (use localhost consistently for OAuth redirects).
6. Enter Turnstile public site key and complete initial two-stage device enrollment to create a provisional account.
7. Enter Supabase PUBLIC publishable key (never service role) and a username.
8. Click 'ورود با Google'. The test page stores the non-extractable browser test signing key in IndexedDB and the public Supabase key locally before redirect.
9. Sign in with Google; return to exactly http://localhost:8085/device-enrollment.html. The Supabase client performs PKCE code exchange and the test page restores device key proof from IndexedDB.
10. Click 'شروع اتصال حساب به دستگاه', then 'امضای چالش و تکمیل حساب'. Expect HTTP 200, state=active, and the chosen username.

Security notes:
- Browser IndexedDB CryptoKey is non-extractable, but scripts executing on the same origin can still invoke signing operations. This is ONLY a development simulation; production Android key custody must use Android Keystore.
- Supabase JS persists the user session in browser storage by default for this local demo. Never host this page for production users.
- No server signing key, Google OAuth Client Secret, or Supabase service role token belongs in public web files.
- OAuth verifies the user; the separately signed device challenge links the provisional account. A public account ID alone cannot bind an account.
- Rate limiting, theft/recovery, device transfer, production provider review, and payment processing are not yet complete.
- If a test fails, do not paste passwords, JWTs, OAuth codes, or secret keys into reports.