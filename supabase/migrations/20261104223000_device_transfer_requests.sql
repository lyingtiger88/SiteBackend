-- Zurvan: controlled account device transfer, initial approval-gated release.
-- Does NOT create paid licenses, and does NOT allow an end-user to approve transfer.
begin;

alter table public.devices add column if not exists revoked_at timestamptz;
create unique index if not exists devices_one_current_per_account
  on public.devices(account_id) where revoked_at is null;

create table if not exists public.device_transfer_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  auth_user_id uuid not null references auth.users(id),
  new_public_key text not null,
  new_key_fingerprint text not null,
  platform text not null check (platform in ('android','ios','windows')),
  reason text not null check (reason in ('broken','sold','lost','upgrade')),
  nonce text not null,
  state text not null default 'pending'
    check (state in ('pending','approved','rejected','expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  approved_by text,
  unique (nonce)
);
create unique index if not exists transfer_one_pending_per_account
  on public.device_transfer_requests(account_id) where state = 'pending';
create index if not exists transfer_requests_expiry
  on public.device_transfer_requests(expires_at);

alter table public.device_transfer_requests enable row level security;
alter table public.device_transfer_requests force row level security;
revoke all on public.device_transfer_requests from anon, authenticated;

-- Finalize ONLY from a separately authenticated support/admin review process.
-- The Edge Function cannot call this function; execute manually as postgres in SQL Editor
-- after independently validating account ownership and replacement request.
create or replace function public.admin_approve_device_transfer(p_request_id uuid, p_operator text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  req record;
  acct record;
  previous_device uuid;
  new_device uuid;
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'operator_not_authorized' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_operator,''))) < 3 then
    raise exception 'operator_required' using errcode = '22023';
  end if;

  select * into req from public.device_transfer_requests
    where id = p_request_id for update;
  if not found or req.state <> 'pending' or req.expires_at <= now() then
    raise exception 'invalid_transfer_request' using errcode = '22023';
  end if;
  select * into acct from public.accounts where id=req.account_id for update;
  if not found or acct.state <> 'active' or acct.auth_user_id <> req.auth_user_id then
    raise exception 'account_not_eligible' using errcode = '42501';
  end if;
  select id into previous_device from public.devices
    where account_id = req.account_id and revoked_at is null for update;
  if previous_device is null then
    raise exception 'no_current_device' using errcode = '22023';
  end if;

  update public.devices set revoked_at=now() where id=previous_device;
  insert into public.devices(account_id,public_key,key_fingerprint,platform)
    values(req.account_id,req.new_public_key,req.new_key_fingerprint,req.platform)
    returning id into new_device;

  -- A real license transfer is intentionally NOT performed here.
  -- When licenses/activations are deployed, add their atomic revocation and
  -- generation increment before enabling purchase-related transfers.
  update public.device_transfer_requests
    set state='approved', decided_at=now(), approved_by=p_operator
    where id=req.id;
  return jsonb_build_object(
    'request_id',req.id,'account_id',req.account_id,
    'previous_device_id',previous_device,'new_device_id',new_device,
    'state','approved'
  );
end
$$;
revoke all on function public.admin_approve_device_transfer(uuid,text)
  from public, anon, authenticated, service_role;
commit;
