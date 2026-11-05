-- Hotfix: review device transfer against the two ACTUAL Zurvan schemas.
-- Safe to apply after 20261105090000_admin_device_transfer_review.sql.
-- Does not create shadow licenses or activations.
begin;
create or replace function public.admin_review_device_transfer(
 p_request_id uuid, p_operator uuid, p_decision text, p_reason text
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
 req public.device_transfer_requests%rowtype;
 acct public.accounts%rowtype;
 old_device public.devices%rowtype;
 new_device uuid;
 znew_device uuid;
 lic record;
 old_activation uuid;
 matched_count integer:=0;
 n_licenses integer:=0;
begin
 if auth.role() is distinct from 'service_role' then
   raise exception 'forbidden' using errcode='42501';
 end if;
 if p_decision not in ('approve','reject') or
   length(trim(coalesce(p_reason,'')))<8 or length(p_reason)>1000 then
   raise exception 'invalid_review' using errcode='22023';
 end if;
 if not exists (select 1 from public.zurvan_admin_users
    where auth_user_id=p_operator and active=true) then
    raise exception 'admin_not_authorized' using errcode='42501';
 end if;
 select * into req from public.device_transfer_requests where id=p_request_id for update;
 if not found or req.state <> 'pending' or req.proof_verified_at is null
   or req.review_expires_at is null or req.review_expires_at <= now() then
   raise exception 'request_not_reviewable' using errcode='22023';
 end if;
 select * into acct from public.accounts where id=req.account_id for update;
 if not found or acct.state <> 'active' or acct.auth_user_id is distinct from req.auth_user_id then
   raise exception 'account_not_eligible' using errcode='42501';
 end if;
 if p_decision='reject' then
   update public.device_transfer_requests set state='rejected',decided_at=now(),
      reviewed_at=now(),approved_by=p_operator::text where id=req.id;
   insert into public.zurvan_admin_audit(request_id,operator_auth_user_id,action,reason)
      values(req.id,p_operator,'rejected',p_reason);
   return jsonb_build_object('request_id',req.id,'state','rejected');
 end if;

 -- Lock the current registration row. This is the enrollment system's active device.
 select * into old_device from public.devices
   where account_id=acct.id and revoked_at is null for update;
 if not found then
   raise exception 'no_current_device' using errcode='22023';
 end if;
 if exists(select 1 from public.devices where key_fingerprint=req.new_key_fingerprint)
    or exists(select 1 from public.zurvan_devices where key_fingerprint=req.new_key_fingerprint) then
   raise exception 'replacement_key_already_registered' using errcode='23505';
 end if;

 -- License ownership in the baseline schema is linked to auth.users through
 -- zurvan_accounts.id, NOT accounts.id. Never assume the UUIDs are equal.
 select count(*) into n_licenses from public.zurvan_licenses
   where account_id=req.auth_user_id and status='active';
 if n_licenses>0 then
   if not exists(select 1 from public.zurvan_accounts
      where id=req.auth_user_id and status='active') then
     raise exception 'license_account_not_active' using errcode='22023';
   end if;
   -- Fail closed unless EVERY active license is currently bound to the exact
   -- old physical key in the license system. Prevent silent cross-device rebinding.
   for lic in select id from public.zurvan_licenses
      where account_id=req.auth_user_id and status='active' order by id for update
   loop
     select count(*) into matched_count
       from public.zurvan_activations act
       join public.zurvan_devices zd on zd.id=act.device_id
       where act.license_id=lic.id and act.revoked_at is null
         and zd.account_id=req.auth_user_id
         and zd.key_fingerprint=old_device.key_fingerprint;
     if matched_count<>1 then
       raise exception 'license_device_binding_mismatch' using errcode='22023';
     end if;
   end loop;
 end if;

 -- All changes are in this single PostgreSQL transaction: any exception
 -- rolls back device revocation, license changes, and audit together.
 update public.devices set revoked_at=now() where id=old_device.id;
 insert into public.devices(account_id,public_key,key_fingerprint,platform,device_label)
 values(acct.id,req.new_public_key,req.new_key_fingerprint,req.platform,'Transferred device')
 returning id into new_device;

 if n_licenses>0 then
   insert into public.zurvan_devices(account_id,key_fingerprint,public_key,platform,label)
   values(req.auth_user_id,req.new_key_fingerprint,req.new_public_key,req.platform,'Transferred device')
   returning id into znew_device;

   for lic in select id from public.zurvan_licenses
      where account_id=req.auth_user_id and status='active' order by id for update
   loop
     select act.id into old_activation
       from public.zurvan_activations act
       join public.zurvan_devices zd on zd.id=act.device_id
       where act.license_id=lic.id and act.revoked_at is null
         and zd.account_id=req.auth_user_id
         and zd.key_fingerprint=old_device.key_fingerprint
       for update of act;
     if old_activation is null then
       raise exception 'license_device_binding_mismatch' using errcode='22023';
     end if;
     update public.zurvan_activations set revoked_at=now() where id=old_activation;
     insert into public.zurvan_activations(license_id,device_id)
       values(lic.id,znew_device);
     update public.zurvan_licenses set generation=generation+1 where id=lic.id;
     insert into public.zurvan_device_transfers
       (license_id,old_device_id,new_device_id,reason,status,completed_at)
     select lic.id,act.device_id,znew_device,req.reason,'completed',now()
       from public.zurvan_activations act where act.id=old_activation;
   end loop;
 end if;

 update public.device_transfer_requests
  set state='approved',decided_at=now(),reviewed_at=now(),approved_by=p_operator::text
  where id=req.id;
 insert into public.zurvan_admin_audit(request_id,operator_auth_user_id,action,reason)
   values(req.id,p_operator,'approved',p_reason);
 return jsonb_build_object('request_id',req.id,'state','approved',
   'previous_device_id',old_device.id,'new_device_id',new_device,
   'transferred_license_count',n_licenses,'licensed_device_id',znew_device);
end $$;
revoke all on function public.admin_review_device_transfer(uuid,uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.admin_review_device_transfer(uuid,uuid,text,text)
 to service_role;
commit;
