-- Admin-reviewed device transfer and atomic license activation migration.
begin;

-- Separate short proof window from the human review window.
alter table public.device_transfer_requests
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_expires_at timestamptz;

update public.device_transfer_requests
set review_expires_at = coalesce(review_expires_at, created_at + interval '7 days')
where proof_verified_at is not null;

-- Explicit allow-list. Populate only after verifying the operator identity out of band.
create table if not exists public.zurvan_admin_users (
  auth_user_id uuid primary key references auth.users(id) on delete restrict,
  role text not null check (role in ('support','superadmin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.zurvan_admin_users enable row level security;
alter table public.zurvan_admin_users force row level security;
revoke all on public.zurvan_admin_users from public, anon, authenticated;

create table if not exists public.zurvan_admin_audit (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.device_transfer_requests(id),
  operator_auth_user_id uuid not null references auth.users(id),
  action text not null check(action in ('approved','rejected')),
  reason text not null,
  created_at timestamptz not null default now()
);
alter table public.zurvan_admin_audit enable row level security;
alter table public.zurvan_admin_audit force row level security;
revoke all on public.zurvan_admin_audit from public, anon, authenticated;

-- Approval is callable only by the trusted Edge Function service role after it
-- independently checks the operator against zurvan_admin_users.
create or replace function public.admin_review_device_transfer(
  p_request_id uuid,
  p_operator uuid,
  p_decision text,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
  req record;
  acct record;
  old_device uuid;
  new_device uuid;
  lic record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode='42501';
  end if;
  if p_decision not in ('approve','reject') or length(trim(coalesce(p_reason,''))) < 8 then
    raise exception 'invalid_review' using errcode='22023';
  end if;
  if not exists(select 1 from public.zurvan_admin_users
    where auth_user_id=p_operator and active=true) then
    raise exception 'admin_not_authorized' using errcode='42501';
  end if;

  select * into req from public.device_transfer_requests
    where id=p_request_id for update;
  if not found or req.state <> 'pending' or req.proof_verified_at is null
     or req.review_expires_at is null or req.review_expires_at <= now() then
    raise exception 'request_not_reviewable' using errcode='22023';
  end if;
  select * into acct from public.accounts where id=req.account_id for update;
  if not found or acct.state <> 'active' or acct.auth_user_id <> req.auth_user_id then
    raise exception 'account_not_eligible' using errcode='42501';
  end if;

  if p_decision='reject' then
    update public.device_transfer_requests set state='rejected',decided_at=now(),
      reviewed_at=now(),approved_by=p_operator::text where id=req.id;
    insert into public.zurvan_admin_audit(request_id,operator_auth_user_id,action,reason)
      values(req.id,p_operator,'rejected',p_reason);
    return jsonb_build_object('request_id',req.id,'state','rejected');
  end if;

  select id into old_device from public.devices
    where account_id=req.account_id and revoked_at is null for update;
  if old_device is null then raise exception 'no_current_device' using errcode='22023'; end if;
  if exists(select 1 from public.devices where key_fingerprint=req.new_key_fingerprint) then
    raise exception 'replacement_key_already_registered' using errcode='23505';
  end if;

  update public.devices set revoked_at=now() where id=old_device;
  insert into public.devices(account_id,public_key,key_fingerprint,platform,device_label)
    values(req.account_id,req.new_public_key,req.new_key_fingerprint,req.platform,'Transferred device')
    returning id into new_device;

  -- Move all active licenses atomically with device binding. Preserve license IDs.
  for lic in select id,generation from public.licenses
      where account_id=req.account_id and status='active' for update
  loop
    update public.activations set revoked_at=now()
      where license_id=lic.id and device_id=old_device and revoked_at is null;
    update public.licenses set generation=generation+1 where id=lic.id;
    insert into public.activations(license_id,device_id) values(lic.id,new_device);
  end loop;

  update public.device_transfer_requests set state='approved',decided_at=now(),
    reviewed_at=now(),approved_by=p_operator::text where id=req.id;
  insert into public.zurvan_admin_audit(request_id,operator_auth_user_id,action,reason)
    values(req.id,p_operator,'approved',p_reason);

  return jsonb_build_object('request_id',req.id,'state','approved',
    'previous_device_id',old_device,'new_device_id',new_device);
end $$;

revoke all on function public.admin_review_device_transfer(uuid,uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.admin_review_device_transfer(uuid,uuid,text,text)
 to service_role;

-- The legacy SQL editor-only approval function must not remain a second pathway.
revoke all on function public.admin_approve_device_transfer(uuid,text)
 from public,anon,authenticated,service_role;
commit;
