-- Special "Super" accounts: perpetual premium access with an exclusive identity/theme.
-- Grants are managed only from the trusted Supabase SQL Editor / service role.
begin;

create table if not exists public.zurvan_special_profiles (
  account_id uuid primary key references public.zurvan_accounts(id) on delete restrict,
  tier text not null default 'super' check (tier='super'),
  display_name text not null default 'Zurvan Sovereign',
  theme_key text not null default 'super_aurora',
  granted_at timestamptz not null default now(),
  granted_by text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint special_display_name_length check (
    char_length(display_name) between 2 and 48
  ),
  constraint special_theme_key_format check (
    theme_key ~ '^[a-z][a-z0-9_]{2,31}$'
  )
);

alter table public.zurvan_special_profiles enable row level security;
alter table public.zurvan_special_profiles force row level security;
revoke all on public.zurvan_special_profiles from public, anon, authenticated;

-- Service-only lookup; the public license-status Edge Function performs this
-- lookup after authenticating the caller and returns only that caller's profile.
comment on table public.zurvan_special_profiles is
  'Private allowlist of perpetual Super accounts and their exclusive Zurvan theme identity.';

commit;

-- Assign a Super identity by verified email. Run only in the trusted SQL Editor.
-- Replace the email and display name with the intended values.
-- This is an example template and is intentionally NOT executed by this migration:
-- insert into public.zurvan_special_profiles(account_id,display_name,theme_key,granted_by)
-- select id,'Zurvan Inner Circle','super_aurora','owner'
-- from public.zurvan_accounts
-- where id=(select id from auth.users where lower(email)=lower('friend@example.com'))
--   and status='active'
-- on conflict(account_id) do update set
--   display_name=excluded.display_name, theme_key=excluded.theme_key,
--   revoked_at=null, granted_at=now(), granted_by=excluded.granted_by;
