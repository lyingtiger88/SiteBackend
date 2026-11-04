-- Repair for a Supabase project where the challenge and enrollment RPC exist
-- but public.accounts and public.devices were not created.
-- Non-destructive, intended for the development environment.
begin;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  username text unique,
  password_hash text,
  recovery_email text,
  recovery_verified_at timestamptz,
  state text not null default 'provisional'
    check (state in ('provisional','active','suspended')),
  created_at timestamptz not null default now(),
  constraint accounts_credentials_pair check (
    (username is null and password_hash is null)
    or (username is not null and password_hash is not null)
  )
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  public_key text not null,
  key_fingerprint text not null unique,
  platform text not null,
  device_label text,
  created_at timestamptz not null default now(),
  unique(id, account_id)
);

alter table public.accounts enable row level security;
alter table public.devices enable row level security;
alter table public.accounts force row level security;
alter table public.devices force row level security;

revoke all on table public.accounts from anon, authenticated;
revoke all on table public.devices from anon, authenticated;

-- No client-facing policies: privileged server actions only.
-- The existing SECURITY DEFINER function is responsible for atomic enrollment.
commit;
