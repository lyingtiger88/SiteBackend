-- Transparent, privacy-minimizing Super eligibility assessment.
-- Uses account tenure, verified paid subscription orders and recent license-check activity.
-- This is a recommendation score only: it NEVER grants Super automatically.
begin;

create table if not exists public.zurvan_super_reviews (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.zurvan_accounts(id) on delete restrict,
  score integer not null check(score between 0 and 100),
  criteria jsonb not null default '{}'::jsonb,
  decision text not null default 'pending'
    check(decision in ('pending','approved','rejected','deferred')),
  reviewer text,
  review_note text,
  assessed_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists zurvan_super_reviews_account_recent
  on public.zurvan_super_reviews(account_id,assessed_at desc);

alter table public.zurvan_super_reviews enable row level security;
alter table public.zurvan_super_reviews force row level security;
revoke all on public.zurvan_super_reviews from public,anon,authenticated;

create or replace function public.assess_zurvan_super_eligibility(p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  account_created timestamptz;
  account_status text;
  tenure_days integer;
  paid_orders integer;
  verified_payments integer;
  checks_90d integer;
  refunded_orders integer;
  score integer := 0;
  criteria jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode='42501';
  end if;

  select created_at,status into account_created,account_status
  from public.zurvan_accounts where id=p_account_id;
  if not found then raise exception 'account_not_found' using errcode='P0002'; end if;

  tenure_days := greatest(0,floor(extract(epoch from (now()-account_created))/86400)::integer);

  select count(*)::integer into paid_orders
  from public.zurvan_orders
  where account_id=p_account_id and status='paid' and product_id='zurvan';

  select count(distinct p.id)::integer into verified_payments
  from public.zurvan_payments p
  join public.zurvan_orders o on o.id=p.order_id
  where o.account_id=p_account_id and o.status='paid'
    and p.status='verified' and o.product_id='zurvan';

  select count(*)::integer into refunded_orders
  from public.zurvan_orders
  where account_id=p_account_id and status='refunded';

  select count(*)::integer into checks_90d
  from public.zurvan_license_checks
  where license_id in (
    select id from public.zurvan_licenses where account_id=p_account_id
  ) and created_at >= now()-interval '90 days';

  -- Tenure: max 20 points.
  score := score + case when tenure_days>=365 then 20
                        when tenure_days>=180 then 12
                        when tenure_days>=90 then 6 else 0 end;
  -- Verified purchases: max 40 points.
  score := score + case when verified_payments>=3 then 40
                        when verified_payments=2 then 28
                        when verified_payments=1 then 16 else 0 end;
  -- Genuine recent product use: max 20 points.
  score := score + case when checks_90d>=30 then 20
                        when checks_90d>=10 then 12
                        when checks_90d>=3 then 5 else 0 end;
  -- Active account standing: max 20 points.
  if account_status='active' then score := score+20; end if;

  criteria := jsonb_build_object(
    'account_tenure_days',tenure_days,
    'verified_paid_orders',verified_payments,
    'paid_orders',paid_orders,
    'license_checks_last_90_days',checks_90d,
    'refunded_orders',refunded_orders,
    'account_status',account_status,
    'score_breakdown',jsonb_build_object(
      'tenure',case when tenure_days>=365 then 20 when tenure_days>=180 then 12 when tenure_days>=90 then 6 else 0 end,
      'verified_purchases',case when verified_payments>=3 then 40 when verified_payments=2 then 28 when verified_payments=1 then 16 else 0 end,
      'recent_use',case when checks_90d>=30 then 20 when checks_90d>=10 then 12 when checks_90d>=3 then 5 else 0 end,
      'active_standing',case when account_status='active' then 20 else 0 end
    ),
    'recommendation',case
      when account_status<>'active' then 'not_eligible'
      when refunded_orders>0 then 'manual_review_required'
      when score>=60 then 'recommend_review'
      else 'not_yet_qualified'
    end,
    'automatic_grant',false
  );

  insert into public.zurvan_super_reviews(account_id,score,criteria)
  values(p_account_id,score,criteria);

  return jsonb_build_object('account_id',p_account_id,'score',score,'criteria',criteria);
end
$$;

revoke all on function public.assess_zurvan_super_eligibility(uuid)
  from public,anon,authenticated;
grant execute on function public.assess_zurvan_super_eligibility(uuid)
  to service_role;

commit;
