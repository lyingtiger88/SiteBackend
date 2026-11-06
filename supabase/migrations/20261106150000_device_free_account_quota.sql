-- One initial free account per physical Android installation/device identity.
-- Each successfully activated paid subscription grants exactly one additional
-- free-account slot on that same device. No client can modify quota counters.
begin;

create table if not exists public.zurvan_hardware_registry (
  id uuid primary key default gen_random_uuid(),
  hardware_fingerprint text not null unique
    check (hardware_fingerprint ~ '^[0-9a-f]{64}$'),
  platform text not null check (platform in ('android','ios','windows')),
  free_account_limit integer not null default 1 check (free_account_limit >= 1),
  free_accounts_created integer not null default 0
    check (free_accounts_created >= 0 and free_accounts_created <= free_account_limit),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.zurvan_hardware_account_links (
  account_id uuid primary key references public.zurvan_accounts(id) on delete restrict,
  hardware_id uuid not null references public.zurvan_hardware_registry(id) on delete restrict,
  account_number integer not null check (account_number >= 1),
  created_at timestamptz not null default now(),
  unique(hardware_id, account_number)
);

create table if not exists public.zurvan_hardware_quota_grants (
  id uuid primary key default gen_random_uuid(),
  hardware_id uuid not null references public.zurvan_hardware_registry(id) on delete restrict,
  license_id uuid not null unique references public.zurvan_licenses(id) on delete restrict,
  account_id uuid not null references public.zurvan_accounts(id) on delete restrict,
  granted_at timestamptz not null default now()
);

alter table public.authenticated_device_enrollment_challenges
  add column if not exists hardware_fingerprint text;

alter table public.zurvan_hardware_registry enable row level security;
alter table public.zurvan_hardware_registry force row level security;
alter table public.zurvan_hardware_account_links enable row level security;
alter table public.zurvan_hardware_account_links force row level security;
alter table public.zurvan_hardware_quota_grants enable row level security;
alter table public.zurvan_hardware_quota_grants force row level security;
revoke all on public.zurvan_hardware_registry from public,anon,authenticated;
revoke all on public.zurvan_hardware_account_links from public,anon,authenticated;
revoke all on public.zurvan_hardware_quota_grants from public,anon,authenticated;

-- Atomic, race-safe enrollment quota check. The row lock serializes simultaneous
-- registration attempts from the same device.
create or replace function public.complete_authenticated_device_enrollment(
    p_challenge_id uuid, p_auth_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
 ch public.authenticated_device_enrollment_challenges%rowtype;
 new_account uuid;
 new_device uuid;
 license_device uuid;
 fingerprint text;
 user_email text;
 hardware public.zurvan_hardware_registry%rowtype;
 account_number integer;
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
 select u.email into user_email from auth.users u
   where u.id=p_auth_user_id and u.email_confirmed_at is not null;
 if user_email is null then
   raise exception 'email_not_confirmed' using errcode='42501';
 end if;
 if ch.username !~ '^[a-z][a-z0-9_]{3,23}$'
    or ch.public_key !~ '^[A-Za-z0-9_-]{43}$'
    or ch.platform not in ('android','ios','windows')
    or ch.hardware_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_enrollment' using errcode='22023';
 end if;
 if exists(select 1 from public.accounts a where a.auth_user_id=p_auth_user_id)
    or exists(select 1 from public.zurvan_hardware_account_links l
              join public.zurvan_hardware_registry h on h.id=l.hardware_id
              where h.hardware_fingerprint=ch.hardware_fingerprint
                and l.account_id=p_auth_user_id) then
   raise exception 'already_registered' using errcode='23505';
 end if;

 insert into public.zurvan_hardware_registry(hardware_fingerprint,platform)
 values(ch.hardware_fingerprint,ch.platform)
 on conflict(hardware_fingerprint) do update
   set last_seen_at=now()
 returning * into hardware;

 select * into hardware from public.zurvan_hardware_registry
   where id=hardware.id for update;
 if hardware.free_accounts_created >= hardware.free_account_limit then
   raise exception 'free_account_device_locked' using errcode='P0001';
 end if;
 account_number:=hardware.free_accounts_created+1;
 update public.zurvan_hardware_registry
   set free_accounts_created=account_number,last_seen_at=now()
   where id=hardware.id;

 fingerprint:=encode(extensions.digest(ch.public_key,'sha256'),'hex');
 insert into public.accounts(username,auth_user_id,state,recovery_email,recovery_verified_at)
 values(ch.username,p_auth_user_id,'active',user_email,now())
 returning id into new_account;

 insert into public.zurvan_accounts(id,username,recovery_email,recovery_verified_at,status)
 values(p_auth_user_id,ch.username,user_email,now(),'active')
 on conflict(id) do update set
   username=excluded.username,recovery_email=excluded.recovery_email,
   recovery_verified_at=excluded.recovery_verified_at,status='active';

 insert into public.zurvan_hardware_account_links(account_id,hardware_id,account_number)
 values(p_auth_user_id,hardware.id,account_number);

 insert into public.devices(account_id,public_key,key_fingerprint,platform,device_label)
 values(new_account,ch.public_key,fingerprint,ch.platform,'Zurvan enrolled device')
 returning id into new_device;

 insert into public.zurvan_devices(account_id,key_fingerprint,public_key,platform,label)
 values(p_auth_user_id,fingerprint,ch.public_key,ch.platform,'Zurvan enrolled device')
 on conflict(key_fingerprint) do nothing;
 select id into license_device from public.zurvan_devices
   where key_fingerprint=fingerprint and account_id=p_auth_user_id;

 update public.authenticated_device_enrollment_challenges
   set consumed_at=now() where id=ch.id;

 return jsonb_build_object(
   'account_id',new_account,'license_account_id',p_auth_user_id,
   'device_id',new_device,'license_device_id',license_device,
   'hardware_account_number',account_number,
   'free_accounts_remaining',hardware.free_account_limit-account_number,
   'state','active','username',ch.username
 );
end
$$;

revoke all on function public.complete_authenticated_device_enrollment(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.complete_authenticated_device_enrollment(uuid,uuid)
  to service_role;

-- A paid subscription activation/upgrade creates one additional account slot.
-- The unique license_id in the ledger prevents duplicate grants on retries.
create or replace function public.grant_next_free_account_after_subscription()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare
 hardware_id_value uuid;
begin
 if new.type='subscription' and new.status='active'
    and (tg_op='INSERT' or old.type is distinct from 'subscription'
         or old.status is distinct from 'active') then
   select hardware_id into hardware_id_value
     from public.zurvan_hardware_account_links
     where account_id=new.account_id;
   if hardware_id_value is not null then
     insert into public.zurvan_hardware_quota_grants(hardware_id,license_id,account_id)
     values(hardware_id_value,new.id,new.account_id)
     on conflict(license_id) do nothing;
     if found then
       update public.zurvan_hardware_registry
         set free_account_limit=free_account_limit+1,last_seen_at=now()
         where id=hardware_id_value;
     end if;
   end if;
 end if;
 return new;
end
$$;

drop trigger if exists zurvan_subscription_grants_account_slot on public.zurvan_licenses;
create trigger zurvan_subscription_grants_account_slot
after insert or update of type,status on public.zurvan_licenses
for each row execute function public.grant_next_free_account_after_subscription();

revoke all on function public.grant_next_free_account_after_subscription()
  from public,anon,authenticated;

commit;
