# Local account completion test (development only)

Prerequisites:
1. Initial device enrollment functions and database tables must exist.
2. Run supabase/migrations/20261104220000_account_auth_link.sql in the Supabase SQL Editor.
3. In Authentication settings enable email signups and email confirmation, and review redirect URLs.
4. Deploy supabase/functions/account-complete-registration/index.ts as account-complete-registration. Set Verify JWT legacy secret OFF; this function checks user tokens with Supabase Auth.
5. Restrict access to this development workflow. Production rate limiting, abuse controls, recovery, and threat modeling remain unfinished.

Test:
1. git pull origin main
2. Serve web/tests with py -m http.server 8085 --bind 127.0.0.1
3. Refresh http://localhost:8085/device-enrollment.html
4. Complete Turnstile plus both initial enrollment buttons; receive provisional account HTTP 201.
5. Without refreshing, enter the Supabase PUBLIC publishable/anon key, a test email, password, and username.
6. Sign up, confirm email in a separate browser tab, return to the original test page, and log in.
7. Start the account-binding challenge, then sign it with the same device key; expect HTTP 200 and state active.

Important: never enter service_role or secret keys in a browser. Do not share passwords, tokens, or private keys.
Browser test device keys only exist in memory: reloading loses them. Do not use customer data or announce a public launch.
No payment or license is issued by this account-registration test.