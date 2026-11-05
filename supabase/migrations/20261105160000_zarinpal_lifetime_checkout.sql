-- Zarinpal v4 integration for lifetime Zurvan purchases.
-- Price rows are managed server-side. For currency IRT, amount_minor is TOMAN;
-- the Edge Function converts to RIAL by multiplying by 10 before calling Zarinpal.
begin;

alter table public.zurvan_payments
  add column if not exists authority text;

create unique index if not exists zurvan_payments_provider_authority
  on public.zurvan_payments(provider,authority) where authority is not null;

-- Atomically mark the verified payment/order paid and issue the annual subscription.
-- Only the service role may execute this function after a successful provider verify call.
create or replace function public.zurvan_finalize_zarinpal_payment(
  p_authority text,
  p_ref_id text,
  p_verified_amount bigint,
  p_verified_currency text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.zurvan_payments%rowtype;
  o public.zurvan_orders%rowtype;
  l public.zurvan_licenses%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode='42501';
  end if;

  select * into p from public.zurvan_payments
    where provider='zarinpal' and authority=p_authority
    for update;
  if not found then raise exception 'payment_not_found' using errcode='P0002'; end if;

  select * into o from public.zurvan_orders where id=p.order_id for update;
  if not found then raise exception 'order_not_found' using errcode='P0002'; end if;

  if p.status='verified' and o.status='paid' then
    select * into l from public.zurvan_licenses where account_id=o.account_id and product_id=o.product_id;
    return jsonb_build_object('status','already_paid','order_id',o.id,'license_id',l.id,'expires_at',l.expires_at);
  end if;
  if p.status <> 'pending' or o.status <> 'pending' then
    raise exception 'payment_not_pending' using errcode='55000';
  end if;
  if p_verified_amount <> o.amount_minor or p_verified_currency <> o.currency then
    raise exception 'verified_amount_mismatch' using errcode='22000';
  end if;
  update public.zurvan_payments set status='verified',
    provider_transaction_id=p_ref_id, verified_amount_minor=p_verified_amount,
    verified_currency=p_verified_currency, verified_at=now()
    where id=p.id;
  update public.zurvan_orders set status='paid',paid_at=now() where id=o.id;

  -- One-year prepaid subscription. Renewal extends from the later of now or current expiry.
  insert into public.zurvan_licenses(account_id,product_id,order_id,type,status,expires_at)
    values(o.account_id,o.product_id,o.id,'annual','active',now()+interval '1 year')
    on conflict(account_id,product_id) do update
      set order_id=excluded.order_id,
          type='annual',
          status='active',
          expires_at=greatest(coalesce(public.zurvan_licenses.expires_at,now()),now())+interval '1 year'
    returning * into l;

  insert into public.zurvan_audit_logs(actor_id,event_name,subject_id,details)
    values(o.account_id,'payment.zarinpal.verified',o.id::text,
      jsonb_build_object('payment_id',p.id,'ref_id',p_ref_id,'license_id',l.id));

  return jsonb_build_object('status','paid','order_id',o.id,'license_id',l.id,'expires_at',l.expires_at);
end;
$$;

revoke all on function public.zurvan_finalize_zarinpal_payment(text,text,bigint,text)
  from public,anon,authenticated;
grant execute on function public.zurvan_finalize_zarinpal_payment(text,text,bigint,text)
  to service_role;

commit;
