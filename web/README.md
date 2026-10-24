# Site / Admin console route map

Planned website (not yet deployed):
- `/` — Zurvan introduction, download and FAQ
- `/pricing` — lifetime license regional pricing
- `/checkout` — secure order start, redirect to approved payment provider
- `/payment/result` — display verified server-side order status (return URLs are not trusted)
- `/account` — username/password, device binding, license state
- `/account/transfer` — transfer reason, step-up verification, replacement device
- `/account/recovery` — account recovery for lost devices
- `/admin` — privileged users, orders, gateway verifications, license state, audits

Architecture recommendation: static frontend + server-side API. Do not expose PostgreSQL credentials, signing keys or privileged DB roles in browser assets. Use HTTPS, CSRF protection where cookies are used, security headers, and accessible Persian RTL plus English UI.

Site source implementation to follow after UI/framework selection. No live checkout or admin page has been created yet.
