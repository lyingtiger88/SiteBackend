begin;
alter table public.zurvan_products add column if not exists sales_enabled boolean not null default false;
insert into public.zurvan_products(id,name,enabled,sales_enabled)
 values ('zurvan','Zurvan',true,true),('maal','Maal',true,true),
 ('shopmanager','ShopManager',true,true),('health-bridge','پل سلامت',true,false)
on conflict (id) do update set name=excluded.name, enabled=true, sales_enabled=excluded.sales_enabled;
create table if not exists public.kaliia_store_plans (
 id uuid primary key default gen_random_uuid(),
 product_id text not null references public.zurvan_products(id),
 months smallint not null check(months in (1,3,6,12)),
 amount_minor bigint,
 currency text not null default 'IRR' check(currency in ('IRR','IRT')),
 enabled boolean not null default false,
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id),
 unique(product_id,months),
 check (amount_minor is null or amount_minor>0),
 check (not enabled or amount_minor is not null)
);
alter table public.kaliia_store_plans enable row level security;
revoke all on public.kaliia_store_plans from public,anon,authenticated;
grant all on public.kaliia_store_plans to service_role;
insert into public.kaliia_store_plans(product_id,months)
 select p.id,m.months from public.zurvan_products p
 cross join (values (1),(3),(6),(12)) m(months)
 where p.sales_enabled on conflict(product_id,months) do nothing;
alter table public.zurvan_manual_payments add column if not exists duration_months smallint;
alter table public.zurvan_manual_payments add constraint kaliia_payment_months check(duration_months is null or duration_months in (1,3,6,12));
create or replace function public.zurvan_manual_review_payment(
 p_payment_id uuid, p_admin_id uuid,p_approve boolean,p_note text default null
)
returns jsonb language plpgsql security invoker set search_path=''
as $$
declare
 req public.zurvan_manual_payments%rowtype;
 current_license public.zurvan_licenses%rowtype;
 expires_at_value timestamptz;
 product_live boolean;
begin
 if not exists(select 1 from public.zurvan_admin_users
  where auth_user_id=p_admin_id and active=true and role='superadmin')
 then raise exception 'not_authorized' using errcode='42501'; end if;
 select * into req from public.zurvan_manual_payments where id=p_payment_id for update;
 if not found then raise exception 'request_missing' using errcode='22023'; end if;
 if req.status<>'pending' then raise exception 'already_reviewed' using errcode='23505'; end if;
 if not exists(select 1 from public.zurvan_accounts where id=req.auth_user_id and status='active')
 then raise exception 'license_account_missing' using errcode='22023'; end if;
 if p_approve then
  if req.product_id is null or req.duration_months is null or
     req.amount_minor is null or req.amount_minor<=0 or req.currency is null
  then raise exception 'incomplete_purchase_snapshot' using errcode='22023'; end if;
  select p.sales_enabled and p.enabled into product_live from public.zurvan_products p where p.id=req.product_id;
  if coalesce(product_live,false)=false then raise exception 'product_not_for_sale' using errcode='22023'; end if;
  select * into current_license from public.zurvan_licenses
    where account_id=req.auth_user_id and product_id=req.product_id for update;
  if found and current_license.type='lifetime' and current_license.status='active'
  then raise exception 'lifetime_license_unchanged' using errcode='22023'; end if;
  -- Active paid subscriptions extend. An existing trial is converted to a paid
  -- subscription while preserving the remainder of its initial trial period.
  expires_at_value:=greatest(now(),coalesce(current_license.expires_at,now()))
     + make_interval(months => req.duration_months);
  insert into public.zurvan_licenses(account_id,product_id,type,status,expires_at,order_id)
   values(req.auth_user_id,req.product_id,'subscription','active',expires_at_value,null)
   on conflict(account_id,product_id) do update set
    type='subscription',status='active',expires_at=excluded.expires_at,
    generation=public.zurvan_licenses.generation+1;
 end if;
 update public.zurvan_manual_payments set
  status=case when p_approve then 'approved' else 'rejected' end,
  reviewed_at=now(),reviewed_by=p_admin_id,
  admin_note=nullif(left(btrim(coalesce(p_note,'')),500),'')
 where id=p_payment_id;
 return jsonb_build_object('id',p_payment_id,'product_id',req.product_id,
  'months',req.duration_months,'amount_minor',req.amount_minor,'currency',req.currency,
  'status',case when p_approve then 'approved' else 'rejected' end,
  'license_expires_at',case when p_approve then expires_at_value else null end);
end;
$$;
revoke all on function public.zurvan_manual_review_payment(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.zurvan_manual_review_payment(uuid,uuid,boolean,text) to service_role;
commit;