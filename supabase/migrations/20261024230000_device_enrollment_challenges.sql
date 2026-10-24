-- Phase 2: short-lived proof-of-possession challenges.
-- Run only after initial Zurvan migration has been verified.
begin;
create table if not exists public.device_enrollment_challenges (
 id uuid primary key default gen_random_uuid(),
 public_key text not null,
 platform text not null check(platform in ('android','windows','ios')),
 nonce text not null unique,
 expires_at timestamptz not null,
 consumed_at timestamptz,
 created_at timestamptz not null default now()
);
create index if not exists device_enrollment_challenges_expiry on public.device_enrollment_challenges(expires_at);
alter table public.device_enrollment_challenges enable row level security;
alter table public.device_enrollment_challenges force row level security;
revoke all on public.device_enrollment_challenges from anon, authenticated;
commit;
