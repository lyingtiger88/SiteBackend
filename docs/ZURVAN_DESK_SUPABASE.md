# Zurvan Desk API — Supabase deployment

## Deployment target

- Supabase project: `yztithydgdvydaktuxlw`
- Project URL: `https://yztithydgdvydaktuxlw.supabase.co`
- Edge Function: `zurvan-desk-api`
- API base URL: `https://yztithydgdvydaktuxlw.supabase.co/functions/v1/zurvan-desk-api`
- Health probe: `GET /health`
- Storage bucket: `zurvan-desk-encrypted` (private)
- Maximum object size on the Free plan: 50 MiB.

## Identity and security boundary

Zurvan Desk accounts are stored in `zurvan_desk_accounts` and are intentionally separate from Supabase Auth users and the license/device tables. Desk sessions are random bearer tokens; only SHA-256 token hashes are stored. Passwords are salted and derived with PBKDF2-HMAC-SHA-256 (210,000 iterations). Auth attempts are throttled atomically in Postgres.

The client encrypts file contents and filename metadata before upload. The Edge Function stores ciphertext and never receives a Vault Key or recovery phrase. The storage bucket is private and has no client policies. Only the server-side service key can access it, after the function validates the independent Desk session. Never put the Supabase secret/service-role key in Android, Windows, source control, or a public build.

The function has gateway JWT verification disabled because it uses its own Desk bearer sessions. Supabase's public publishable key is still required in the `apikey` header to reach the Edge Function gateway. A publishable key is safe to ship in clients; a secret/service-role key is not.

## One-time database setup

1. Open the Supabase project above.
2. Open **SQL Editor** and create a new query.
3. Copy the complete contents of:
   `supabase/migrations/20261106230000_zurvan_desk_cloud.sql`
4. Run it once and confirm the four `zurvan_desk_*` tables and private bucket `zurvan-desk-encrypted` exist.
5. Confirm the bucket is **Private** and has a 50 MiB file limit.

This migration is additive. It does not modify existing license accounts, device tables, functions, or data.

## Deploy the Edge Function

1. Confirm the GitHub repository secret `SUPABASE_ACCESS_TOKEN` is configured in `lyingtiger88/SiteBackend`.
2. Open **Actions → Deploy Zurvan Supabase Function → Run workflow**.
3. Select `zurvan-desk-api`.
4. Run the workflow from the branch containing this implementation, then confirm the job succeeds.
5. Test:
   `GET https://yztithydgdvydaktuxlw.supabase.co/functions/v1/zurvan-desk-api/health`
   Include the project's publishable key in the `apikey` header. Expected JSON: `{"service":"zurvan-desk-api","status":"ok","apiVersion":"v1"}`.

The workflow deploys only the selected function; it does not apply SQL migrations.

## API contract

All routes are relative to the API base URL. Every request must include `apikey: <project-publishable-key>`. Authenticated requests also include `Authorization: Bearer <desk-session-token>`.

- `POST /api/v1/auth/register` — JSON: `identifier,password,displayName`
- `POST /api/v1/auth/login` — JSON: `identifier,password`
- `POST /api/v1/auth/logout`
- `GET /api/v1/account`
- `PUT /api/v1/recovery` — JSON: `payload`
- `GET /api/v1/recovery`
- `GET /api/v1/files`
- `POST /api/v1/files` — binary encrypted envelope; header `X-Zurvan-Encrypted-Name`
- `GET /api/v1/files/{fileId}` — returns encrypted envelope bytes
- `PUT /api/v1/files/{fileId}/metadata` — JSON: `encryptedName`
- `DELETE /api/v1/files/{fileId}`

## Free-plan constraints

The Supabase Free plan is suitable for development and demonstrations, not a production availability guarantee. It includes 1 GB Storage, 5 GB egress and a 50 MiB maximum file size; inactive projects can be paused after a week. Monitor usage and upgrade or migrate before real customers depend on the service. The Desk API has no dependency on Arvan S3 credentials, and its data model keeps a future storage-provider migration straightforward.
