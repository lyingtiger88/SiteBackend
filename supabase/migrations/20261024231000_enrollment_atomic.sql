-- Atomic device enrollment completion (requires challenge table and initial schema).
begin;
create or replace function public.complete_device_enrollment(p_challenge_id uuid, p_public_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ch record;
  existing_device uuid;
  new_account uuid;
  new_device uuid;
  fingerprint text;
begin
  -- Only service-role callers are allowed. Edge function verifies Ed25519 signature first.
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ch from public.device_enrollment_challenges
    where id = p_challenge_id for update;
  if not found or ch.consumed_at is not null or ch.expires_at <= now()
     or ch.public_key <> p_public_key then
    raise exception 'invalid_challenge' using errcode = '22023';
  end if;
  fingerprint := encode(extensions.digest(p_public_key, 'sha256'),'hex');
  select d.id into existing_device from public.devices d where d.key_fingerprint = fingerprint;
  if existing_device is not null then
    raise exception 'device_already_registered' using errcode = '23505';
  end if;
  insert into public.accounts default values returning id into new_account;
  insert into public.devices(account_id,public_key,key_fingerprint,platform)
    values(new_account,p_public_key,fingerprint,ch.platform) returning id into new_device;
  update public.device_enrollment_challenges set consumed_at = now()
    where id = p_challenge_id;
  return jsonb_build_object('account_id',new_account,'device_id',new_device);
end;
$$;
revoke all on function public.complete_device_enrollment(uuid,text) from public, anon, authenticated;
grant execute on function public.complete_device_enrollment(uuid,text) to service_role;
commit;
