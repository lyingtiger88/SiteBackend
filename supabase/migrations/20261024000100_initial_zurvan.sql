-- Zurvan License Server v2 / baseline schema for Supabase PostgreSQL
-- Run once in SQL Editor only after reviewing this migration.
-- API implementation is NOT deployed by this migration.
begin;
create extension if not exists pgcrypto;

-- Accounts are backed by Supabase Auth. Passwords stay in auth.users.
create table if not exists public.zurvan_accounts (
  id uuid primary key references auth.users(id) on delete restrict,
  username text unique,
  recovery_email text,
  recovery_verified_at timestamptz,
  status text not null default 'provisional'
    check (status in ('provisional','active','suspended')),
  created_at timestamptz not null default now(),
  constraint valid_username check (
    username is null or
    (length(username) between 3 and 40 and username ~ '^[A-Za-z0-9_.-]+$')
  )
);
create unique index if not exists zurvan_accounts_username_lower
  on public.zurvan_accounts(lower(username)) where username is not null;

create table if not exists public.zurvan_devices (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references public.zurvan_accounts(id) on delete restrict,
 key_fingerprint text not null unique,
 public_key text not null,
 platform text not null check(platform in ('android','windows','ios')),
 label text,
 created_at timestamptz not null default now(),
 unique (id,account_id)
);

create table if not exists public.zurvan_products (
 id text primary key,
 name text not null,
 enabled boolean not null default true
);
insert into public.zurvan_products(id,name)
 values('zurvan','Zurvan')
 on conflict(id) do nothing;

-- Money stored as integer in explicit provider-compatible billing units.
-- IRT is a display denomination, conversion to IRR depends on gateway contract.
create table if not exists public.zurvan_prices (
 id uuid primary key default gen_random_uuid(),
 product_id text not null references public.zurvan_products(id),
 region text not null check(region in ('IR','GLOBAL')),
 currency text not null check(currency in ('IRT','IRR','USD','EUR')),
 amount_minor bigint not null check(amount_minor>0),
 provider text not null,
 enabled boolean not null default false,
 created_at timestamptz not null default now()
);
create table if not exists public.zurvan_orders (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references public.zurvan_accounts(id),
 product_id text not null references public.zurvan_products(id),
 price_id uuid not null references public.zurvan_prices(id),
 amount_minor bigint not null check(amount_minor>0),
 currency text not null,
 status text not null default 'pending'
   check(status in ('pending','paid','failed','refunded')),
 created_at timestamptz not null default now(),
 paid_at timestamptz
);
create table if not exists public.zurvan_payments (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references public.zurvan_orders(id),
 provider text not null,
 provider_transaction_id text,
 provider_event_id text,
 verified_amount_minor bigint,
 verified_currency text,
 status text not null default 'pending'
   check(status in ('pending','verified','failed','refunded')),
 verified_at timestamptz,
 created_at timestamptz not null default now(),
 unique(provider, provider_transaction_id),
 unique(provider, provider_event_id)
);
create table if not exists public.zurvan_licenses (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references public.zurvan_accounts(id),
 product_id text not null references public.zurvan_products(id),
 order_id uuid unique references public.zurvan_orders(id),
 code_hash text unique,
 type text not null default 'lifetime' check(type='lifetime'),
 status text not null default 'active'
   check(status in ('active','suspended','revoked')),
 generation bigint not null default 1 check(generation>0),
 created_at timestamptz not null default now(),
 unique(account_id,product_id)
);
create table if not exists public.zurvan_activations (
 id uuid primary key default gen_random_uuid(),
 license_id uuid not null references public.zurvan_licenses(id),
 device_id uuid not null references public.zurvan_devices(id),
 activated_at timestamptz not null default now(),
 revoked_at timestamptz,
 constraint activation_dates check (revoked_at is null or revoked_at>=activated_at)
);
create unique index if not exists zurvan_one_active_device_per_license
 on public.zurvan_activations(license_id) where revoked_at is null;

create table if not exists public.zurvan_device_transfers (
 id uuid primary key default gen_random_uuid(),
 license_id uuid not null references public.zurvan_licenses(id),
 old_device_id uuid references public.zurvan_devices(id),
 new_device_id uuid not null references public.zurvan_devices(id),
 reason text not null check(reason in ('broken','sold','lost','upgrade')),
 status text not null check(status in ('requested','completed','rejected')),
 created_at timestamptz not null default now(),
 completed_at timestamptz
);
create table if not exists public.zurvan_license_checks (
 id bigint generated always as identity primary key,
 license_id uuid not null references public.zurvan_licenses(id),
 device_id uuid not null references public.zurvan_devices(id),
 result text not null,
 created_at timestamptz not null default now()
);
create index if not exists zurvan_license_checks_recent
 on public.zurvan_license_checks(license_id,created_at desc);
create table if not exists public.zurvan_audit_logs (
 id bigint generated always as identity primary key,
 actor_id uuid references public.zurvan_accounts(id),
 event_name text not null,
 subject_id text,
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);

-- Deny direct client access. Future Edge Functions use trusted backend access.
-- These tables have no permissive RLS policies: even authenticated clients cannot select.
alter table public.zurvan_accounts enable row level security;
alter table public.zurvan_devices enable row level security;
alter table public.zurvan_products enable row level security;
alter table public.zurvan_prices enable row level security;
alter table public.zurvan_orders enable row level security;
alter table public.zurvan_payments enable row level security;
alter table public.zurvan_licenses enable row level security;
alter table public.zurvan_activations enable row level security;
alter table public.zurvan_device_transfers enable row level security;
alter table public.zurvan_license_checks enable row level security;
alter table public.zurvan_audit_logs enable row level security;

revoke all on public.zurvan_accounts,public.zurvan_devices,public.zurvan_products,
 public.zurvan_prices,public.zurvan_orders,public.zurvan_payments,
 public.zurvan_licenses,public.zurvan_activations,
 public.zurvan_device_transfers,public.zurvan_license_checks,
 public.zurvan_audit_logs from anon, authenticated;
revoke all on sequence public.zurvan_license_checks_id_seq,public.zurvan_audit_logs_id_seq
 from anon,authenticated;
commit;

-- Next: implement audited Edge Functions. Do not expose service_role key to apps.
-- Critical: payment issuance + device transfers must be atomic server transactions.
