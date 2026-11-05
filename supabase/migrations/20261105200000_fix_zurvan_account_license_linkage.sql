-- Ensure authenticated enrollment creates both identity records used by the
-- account UI and license subsystem. Safe to apply after the existing enrollment migration.
begin;

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
    or ch.platform not in ('android','ios','windows') then
    raise exception 'invalid_enrollment' using errcode='22023';
 end if;
 if exists(select 1 from public.accounts a where a.auth_user_id=p_auth_user_id) then
   raise exception 'already_registered' using errcode='23505';
 end if;
 fingerprint:=encode(extensions.digest(ch.public_key,'sha256'),'hex');

 insert into public.accounts(username,auth_user_id,state,recovery_email,recovery_verified_at)
 values(ch.username,p_auth_user_id,'active',user_email,now())
 returning id into new_account;

 -- zurvan_accounts.id is intentionally the Supabase Auth UUID; license tables
 -- reference this ID. Keep username synchronized as a public account alias.
 insert into public.zurvan_accounts(id,username,recovery_email,recovery_verified_at,status)
 values(p_auth_user_id,ch.username,user_email,now(),'active')
 on conflict(id) do update set
   username=excluded.username,
   recovery_email=excluded.recovery_email,
   recovery_verified_at=excluded.recovery_verified_at,
   status='active';

 insert into public.devices(account_id,public_key,key_fingerprint,platform,device_label)
 values(new_account,ch.public_key,fingerprint,ch.platform,'Android enrolled device')
 returning id into new_device;

 insert into public.zurvan_devices(account_id,key_fingerprint,public_key,platform,label)
 values(p_auth_user_id,fingerprint,ch.public_key,ch.platform,'Android enrolled device')
 on conflict(key_fingerprint) do nothing;
 select id into license_device from public.zurvan_devices
   where key_fingerprint=fingerprint and account_id=p_auth_user_id;

 update public.authenticated_device_enrollment_challenges
 set consumed_at=now() where id=ch.id;

 return jsonb_build_object('account_id',new_account,'license_account_id',p_auth_user_id,
   'device_id',new_device,'license_device_id',license_device,'state','active','username',ch.username);
end
$$;
revoke all on function public.complete_authenticated_device_enrollment(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.complete_authenticated_device_enrollment(uuid,uuid)
  to service_role;
commit;
