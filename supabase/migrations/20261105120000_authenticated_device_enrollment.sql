-- Authenticated Android enrollment: verified Supabase identity + device proof.
-- Apply manually through reviewed Supabase SQL Editor before deploying the function.
begin;

create table if not exists public.authenticated_device_enrollment_challenges (
    id uuid primary key default gen_random_uuid(),
    auth_user_id uuid not null references auth.users(id),
    username text not null,
    public_key text not null,
    platform text not null check (platform in ('android','ios','windows')),
    nonce text not null unique,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    consumed_at timestamptz
);
create index if not exists authenticated_device_enrollment_by_user
  on public.authenticated_device_enrollment_challenges(auth_user_id,created_at desc);
alter table public.authenticated_device_enrollment_challenges enable row level security;
alter table public.authenticated_device_enrollment_challenges force row level security;
revoke all on public.authenticated_device_enrollment_challenges from public,anon,authenticated;

-- All account/device writes happen atomically. The Edge function verifies the
-- current user's Supabase JWT and Ed25519 signature before invoking this RPC.
create or replace function public.complete_authenticated_device_enrollment(
    p_challenge_id uuid, p_auth_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
 ch public.authenticated_device_enrollment_challenges%rowtype;
 new_account uuid;
 new_device uuid;
 fingerprint text;
begin
 if auth.role() is distinct from 'service_role' then
   raise exception 'forbidden' using errcode='42501';
 end if;
 select * into ch from public.authenticated_device_enrollment_challenges
   where id=p_challenge_id for update;
 if not found or ch.consumed_at is not null or ch.expires_at<=now()
   or ch.auth_user_id is distinct from p_auth_user_id then
   raise exception 'invalid_challenge' using errcode='22023';
 end if;
 if not exists (select 1 from auth.users u where u.id=p_auth_user_id
     and u.email_confirmed_at is not null) then
   raise exception 'email_not_confirmed' using errcode='42501';
 end if;
 if ch.username !~ '^[a-z][a-z0-9_]{3,23}$'
    or ch.public_key !~ '^[A-Za-z0-9_-]{43}$'
    or ch.platform not in ('android','ios','windows') then
    raise exception 'invalid_enrollment' using errcode='22023';
 end if;
 if exists(select 1 from public.accounts a where a.auth_user_id=p_auth_user_id) then
   raise exception 'already_registered' using errcode='23505';
 end if;
 fingerprint:=encode(extensions.digest(ch.public_key,'sha256'),'hex');
 insert into public.accounts(username,auth_user_id,state,recovery_email,recovery_verified_at)
 select ch.username,p_auth_user_id,'active',u.email,now()
 from auth.users u where u.id=p_auth_user_id
 returning id into new_account;
 insert into public.devices(account_id,public_key,key_fingerprint,platform,device_label)
 values(new_account,ch.public_key,fingerprint,ch.platform,'Android enrolled device')
 returning id into new_device;
 update public.authenticated_device_enrollment_challenges
 set consumed_at=now() where id=ch.id;
 return jsonb_build_object('account_id',new_account,'device_id',new_device,'state','active','username',ch.username);
end
$$;
revoke all on function public.complete_authenticated_device_enrollment(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.complete_authenticated_device_enrollment(uuid,uuid)
  to service_role;
commit;
