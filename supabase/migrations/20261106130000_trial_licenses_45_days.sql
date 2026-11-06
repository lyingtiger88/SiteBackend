-- Trial licenses are valid for exactly 45 days from server issuance time.
-- Existing lifetime licenses remain unchanged and non-expiring.
begin;

alter table public.zurvan_licenses
  add column if not exists expires_at timestamptz;

alter table public.zurvan_licenses
  drop constraint if exists zurvan_licenses_type_check;
alter table public.zurvan_licenses
  add constraint zurvan_licenses_type_check
  check (type in ('trial','subscription','lifetime'));

alter table public.zurvan_licenses
  add constraint zurvan_licenses_expiry_by_type
  check (
    (type='lifetime' and expires_at is null)
    or
    (type in ('trial','subscription') and expires_at is not null)
  );

-- Only a trusted server function may issue a trial. The operator must be an
-- active Zurvan admin, the account must be active, and only one product
-- license can exist per account (matching the existing unique constraint).
create or replace function public.admin_issue_trial_license(
  p_account_id uuid,
  p_operator_auth_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  license_id uuid;
  trial_expires_at timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode='42501';
  end if;

  if not exists (
    select 1 from public.zurvan_admin_users
    where auth_user_id=p_operator_auth_user_id and active=true
  ) then
    raise exception 'admin_not_authorized' using errcode='42501';
  end if;

  if not exists (
    select 1 from public.zurvan_accounts
    where id=p_account_id and status='active'
  ) then
    raise exception 'license_account_not_active' using errcode='22023';
  end if;

  if exists (
    select 1 from public.zurvan_licenses
    where account_id=p_account_id and product_id='zurvan'
  ) then
    raise exception 'license_already_exists' using errcode='23505';
  end if;

  trial_expires_at := now() + interval '45 days';

  insert into public.zurvan_licenses
    (account_id,product_id,type,status,generation,expires_at)
  values
    (p_account_id,'zurvan','trial','active',1,trial_expires_at)
  returning id into license_id;

  return jsonb_build_object(
    'license_id',license_id,
    'account_id',p_account_id,
    'product_id','zurvan',
    'type','trial',
    'status','active',
    'issued_at',now(),
    'expires_at',trial_expires_at,
    'duration_days',45
  );
end
$$;

revoke all on function public.admin_issue_trial_license(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.admin_issue_trial_license(uuid,uuid)
  to service_role;

-- Automatically grant the 45-day trial when authenticated device enrollment
-- creates or activates the license identity. Existing paid/lifetime licenses
-- are never overwritten, and the account/product uniqueness prevents duplicates.
create or replace function public.issue_trial_on_account_activation()
returns trigger
language plpgsql
security definer
set search_path=''
as $
begin
  if new.status='active' and (tg_op='INSERT' or old.status is distinct from 'active') then
    if not exists (
      select 1 from public.zurvan_licenses
      where account_id=new.id and product_id='zurvan'
    ) then
      insert into public.zurvan_licenses
        (account_id,product_id,type,status,generation,expires_at)
      values
        (new.id,'zurvan','trial','active',1,now()+interval '45 days')
      on conflict (account_id,product_id) do nothing;
    end if;
  end if;
  return new;
end
$;

drop trigger if exists zurvan_auto_trial_on_activation on public.zurvan_accounts;
create trigger zurvan_auto_trial_on_activation
after insert or update of status on public.zurvan_accounts
for each row execute function public.issue_trial_on_account_activation();

revoke all on function public.issue_trial_on_account_activation()
  from public,anon,authenticated;

commit;
