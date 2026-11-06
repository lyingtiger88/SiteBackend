-- Referral + loyalty program. All attribution and rewards are server-only.
-- A referral qualifies only after the invited account's first verified paid order.
begin;

create table if not exists public.zurvan_referral_settings (
  id boolean primary key default true check(id),
  successful_invites_for_free_year integer not null default 5 check(successful_invites_for_free_year>0),
  points_per_successful_invite integer not null default 100 check(points_per_successful_invite>=0),
  points_for_free_year integer not null default 1000 check(points_for_free_year>0),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.zurvan_referral_settings(id) values(true) on conflict(id) do nothing;

create table if not exists public.zurvan_referral_codes (
  account_id uuid primary key references public.zurvan_accounts(id) on delete restrict,
  code text not null unique,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table if not exists public.zurvan_referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_account_id uuid not null references public.zurvan_accounts(id) on delete restrict,
  invited_account_id uuid not null unique references public.zurvan_accounts(id) on delete restrict,
  referral_code text not null references public.zurvan_referral_codes(code),
  status text not null default 'pending'
    check(status in ('pending','qualified','rewarded','rejected')),
  qualifying_order_id uuid unique references public.zurvan_orders(id),
  qualified_at timestamptz,
  rewarded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint no_self_referral check(referrer_account_id<>invited_account_id)
);
create index if not exists zurvan_referrals_referrer_status
  on public.zurvan_referrals(referrer_account_id,status);

create table if not exists public.zurvan_loyalty_accounts (
  account_id uuid primary key references public.zurvan_accounts(id) on delete restrict,
  points_balance bigint not null default 0 check(points_balance>=0),
  successful_invites integer not null default 0 check(successful_invites>=0),
  updated_at timestamptz not null default now()
);

create table if not exists public.zurvan_loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.zurvan_accounts(id) on delete restrict,
  points_delta bigint not null,
  event_type text not null check(event_type in ('referral_reward','annual_subscription_redemption','admin_adjustment')),
  referral_id uuid unique references public.zurvan_referrals(id),
  note text,
  created_at timestamptz not null default now()
);

alter table public.zurvan_referral_settings enable row level security;
alter table public.zurvan_referral_codes enable row level security;
alter table public.zurvan_referrals enable row level security;
alter table public.zurvan_loyalty_accounts enable row level security;
alter table public.zurvan_loyalty_ledger enable row level security;
alter table public.zurvan_referral_settings force row level security;
alter table public.zurvan_referral_codes force row level security;
alter table public.zurvan_referrals force row level security;
alter table public.zurvan_loyalty_accounts force row level security;
alter table public.zurvan_loyalty_ledger force row level security;
revoke all on public.zurvan_referral_settings,public.zurvan_referral_codes,
 public.zurvan_referrals,public.zurvan_loyalty_accounts,public.zurvan_loyalty_ledger
 from public,anon,authenticated;

-- Create/get a user's referral code. Called only by trusted server code.
create or replace function public.get_or_create_zurvan_referral_code(p_account_id uuid)
returns text language plpgsql security definer set search_path=''
as $$
declare result text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden' using errcode='42501'; end if;
 if not exists(select 1 from public.zurvan_accounts where id=p_account_id and status='active') then
   raise exception 'account_not_active';
 end if;
 select code into result from public.zurvan_referral_codes where account_id=p_account_id and disabled_at is null;
 if result is null then
   result:=upper(substr(encode(extensions.gen_random_bytes(12),'hex'),1,12));
   insert into public.zurvan_referral_codes(account_id,code) values(p_account_id,result)
   on conflict(account_id) do update set code=excluded.code,disabled_at=null
   returning code into result;
 end if;
 return result;
end $$;

-- Attribute an invitee once, during account completion. Existing users cannot self-attribute.
create or replace function public.claim_zurvan_referral(p_invited_account_id uuid,p_code text)
returns uuid language plpgsql security definer set search_path=''
as $$
declare referrer uuid; result uuid;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden' using errcode='42501'; end if;
 select account_id into referrer from public.zurvan_referral_codes
 where code=upper(trim(p_code)) and disabled_at is null;
 if referrer is null or referrer=p_invited_account_id then raise exception 'invalid_referral_code'; end if;
 if exists(select 1 from public.zurvan_orders where account_id=p_invited_account_id and status='paid') then
   raise exception 'referral_claim_too_late';
 end if;
 insert into public.zurvan_referrals(referrer_account_id,invited_account_id,referral_code)
 values(referrer,p_invited_account_id,upper(trim(p_code)))
 returning id into result;
 return result;
exception when unique_violation then
 raise exception 'referral_already_claimed';
end $$;

-- Called ONLY after the payment webhook has verified provider transaction, amount,
-- currency and changed the order to paid. Idempotent by qualifying_order_id/referral_id.
create or replace function public.qualify_zurvan_referral(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
 o public.zurvan_orders%rowtype;
 payment_ok boolean;
 ref public.zurvan_referrals%rowtype;
 settings public.zurvan_referral_settings%rowtype;
 new_count integer;
 new_balance bigint;
 reward_license uuid;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden' using errcode='42501'; end if;
 select * into o from public.zurvan_orders where id=p_order_id for update;
 if not found or o.status<>'paid' then raise exception 'order_not_paid'; end if;
 select exists(select 1 from public.zurvan_payments
   where order_id=o.id and status='verified'
     and verified_amount_minor=o.amount_minor
     and upper(verified_currency)=upper(o.currency)) into payment_ok;
 if not payment_ok then raise exception 'payment_not_verified'; end if;
 -- Only the first paid order of the invited account qualifies.
 if (select count(*) from public.zurvan_orders where account_id=o.account_id and status='paid')<>1 then
   return jsonb_build_object('qualified',false,'reason','not_first_paid_order');
 end if;
 select * into ref from public.zurvan_referrals
 where invited_account_id=o.account_id and status='pending' for update;
 if not found then return jsonb_build_object('qualified',false,'reason','no_pending_referral'); end if;
 select * into settings from public.zurvan_referral_settings where id=true and enabled=true;
 if not found then return jsonb_build_object('qualified',false,'reason','program_disabled'); end if;

 update public.zurvan_referrals set status='qualified',qualifying_order_id=o.id,qualified_at=now()
 where id=ref.id;
 insert into public.zurvan_loyalty_accounts(account_id) values(ref.referrer_account_id)
 on conflict(account_id) do nothing;
 update public.zurvan_loyalty_accounts
 set points_balance=points_balance+settings.points_per_successful_invite,
     successful_invites=successful_invites+1,updated_at=now()
 where account_id=ref.referrer_account_id
 returning points_balance,successful_invites into new_balance,new_count;
 insert into public.zurvan_loyalty_ledger(account_id,points_delta,event_type,referral_id,note)
 values(ref.referrer_account_id,settings.points_per_successful_invite,'referral_reward',ref.id,
        'Verified first paid order by invited account');

 update public.zurvan_referrals set status='rewarded',rewarded_at=now() where id=ref.id;

 if new_count>=settings.successful_invites_for_free_year then
   -- Award one year per threshold crossed; preserve lifetime and Super entitlements.
   update public.zurvan_loyalty_accounts
   set successful_invites=successful_invites-settings.successful_invites_for_free_year,
       points_balance=points_balance-settings.points_for_free_year,updated_at=now()
   where account_id=ref.referrer_account_id
     and points_balance>=settings.points_for_free_year;
   if found then
     insert into public.zurvan_licenses(account_id,product_id,type,status,generation,created_at,expires_at)
     values(ref.referrer_account_id,'zurvan','subscription','active',1,now(),now()+interval '1 year')
     on conflict(account_id,product_id) do update
       set type='subscription',status='active',
           generation=public.zurvan_licenses.generation+1,
           expires_at=greatest(coalesce(public.zurvan_licenses.expires_at,now()),now())+interval '1 year';
     select id into reward_license from public.zurvan_licenses
       where account_id=ref.referrer_account_id and product_id='zurvan';
     insert into public.zurvan_loyalty_ledger(account_id,points_delta,event_type,note)
     values(ref.referrer_account_id,-settings.points_for_free_year,'annual_subscription_redemption',
            'Annual subscription earned through successful referrals');
   end if;
 end if;

 return jsonb_build_object('qualified',true,'referral_id',ref.id,
   'referrer_account_id',ref.referrer_account_id,'points_balance',new_balance,
   'successful_invites_toward_free_year',new_count,
   'free_year_threshold',settings.successful_invites_for_free_year,
   'awarded_license_id',reward_license);
end $$;

revoke all on function public.get_or_create_zurvan_referral_code(uuid),
 public.claim_zurvan_referral(uuid,text),public.qualify_zurvan_referral(uuid)
 from public,anon,authenticated;
grant execute on function public.get_or_create_zurvan_referral_code(uuid),
 public.claim_zurvan_referral(uuid,text),public.qualify_zurvan_referral(uuid)
 to service_role;

commit;
