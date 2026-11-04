# Deploy Zurvan Edge Functions from GitHub Actions

This workflow deploys **one** selected Supabase Edge Function at a time. It has **no push trigger** and never runs database migrations.

## One-time owner setup

1. In the Supabase dashboard, open **Account > Access Tokens** and create a dedicated personal access token used only for deployment. This is NOT the project's anon key, publishable key, service_role key, or database password.
2. In GitHub repository **Settings > Secrets and variables > Actions > New repository secret**, add:
   - Name: SUPABASE_ACCESS_TOKEN
   - Value: the Supabase personal access token
   Never paste this token in issues, chat or source files.
3. In repository **Settings > Environments**, check the `zurvan-production` environment. Add required reviewers / protected branch rules if your plan supports them; merely naming an environment does not enforce human approval.
4. Open **Actions > Deploy Zurvan Supabase Function > Run workflow** on main.
5. Choose `device-management` to deploy only that function. The action will validate the secret and deploy via the Supabase CLI.
6. Open the workflow run logs and confirm success. Test the function separately against known-good requests; successful deployment does not prove business logic correctness.

## Database migration is separate
Before `device-management` can work, manually run and verify:
`supabase/migrations/20261104223000_device_transfer_requests.sql`

Run it through the project's SQL Editor after reviewing it and ensuring there is a database backup. No migration is automatically applied by this workflow.

## Function authentication
See `supabase/config.toml` for gateway JWT verification flags. The application functions validate user access tokens internally where required. The enrollment start function separately validates Turnstile, and remains development-only without complete network rate limiting.

## Troubleshooting
- Missing token: check the Actions secret name `SUPABASE_ACCESS_TOKEN`. The secret is intentionally never printed.
- No workflow on Actions tab: check repository Actions permissions, default branch, and the workflow file at `.github/workflows/deploy-zurvan-supabase.yml`.
- Deploy command fails: inspect workflow logs (redact sensitive headers and tokens); verify Supabase token has access to the selected project.
- Successful deploy but API fails: review the Edge Function's logs and prerequisite migration, not the workflow itself.

Do not automatically deploy all functions or migrations to the existing production-named project before security review.
