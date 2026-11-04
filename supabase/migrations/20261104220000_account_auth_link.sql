-- Zurvan v2: link a provisional device-bound account to a verified Supabase Auth user.
-- Run ONLY after the accounts/devices repair and registration test succeeded.
begin;

-- Credentials are managed by Supabase Auth; the old local password constraint
-- would reject a non-null username with a null local password_hash.
alter table public.accounts drop constraint if exists accounts_credentials_pair;
alter table public.accounts
  add column if not exists auth_user_id uuid unique references auth.users(id);

create table if not exists public.account_registration_challenges (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  auth_user_id uuid not null references auth.users(id),
  nonce text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists registration_challenges_expiry
  on public.account_registration_challenges(expires_at);
alter table public.account_registration_challenges enable row level security;
alter table public.account_registration_challenges force row level security;
revoke all on public.account_registration_challenges from anon, authenticated;

-- Username is an alias; Supabase Auth manages password hashes, email confirmation and sessions.
-- Ownership is proved by signing a short-lived server nonce with the registered device key.
create or replace function public.complete_account_registration(
  p_challenge_id uuid, p_auth_user_id uuid, p_username text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ch record;
  ac record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_username !~ '^[a-z][a-z0-9_]{3,23}$' then
    raise exception 'invalid_username' using errcode = '22023';
  end if;
  select * into ch from public.account_registration_challenges
    where id = p_challenge_id for update;
  if not found or ch.consumed_at is not null or ch.expires_at <= now()
     or ch.auth_user_id <> p_auth_user_id then
    raise exception 'invalid_challenge' using errcode = '22023';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = p_auth_user_id and u.email_confirmed_at is not null
  ) then
    raise exception 'email_not_verified' using errcode = '42501';
  end if;
  select * into ac from public.accounts where id=ch.account_id for update;
  if not found or ac.state <> 'provisional' or ac.auth_user_id is not null then
    raise exception 'account_already_registered' using errcode = '23505';
  end if;
  update public.accounts
    set username = p_username, auth_user_id = p_auth_user_id, state='active'
    where id = ch.account_id;
  update public.account_registration_challenges
    set consumed_at=now() where id = p_challenge_id;
  return jsonb_build_object('account_id', ch.account_id, 'username',p_username,'state','active');
end;
$$;
revoke all on function public.complete_account_registration(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.complete_account_registration(uuid,uuid,text) to service_role;
commit;
