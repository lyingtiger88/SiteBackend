-- Zurvan License Server v2 - PostgreSQL initial schema
-- Use backend-only roles for all writes; do not expose these tables to anonymous clients.
create extension if not exists pgcrypto;

create table accounts (
 id uuid primary key default gen_random_uuid(),
 username text unique,
 password_hash text,
 recovery_email text,
 recovery_verified_at timestamptz,
 state text not null default 'provisional' check(state in ('provisional','active','suspended')),
 created_at timestamptz not null default now(),
 check ((username is null and password_hash is null) or (username is not null and password_hash is not null))
);
create table devices (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references accounts(id),
 public_key text not null,
 key_fingerprint text not null unique,
 platform text not null,
 device_label text,
 created_at timestamptz not null default now(),
 unique(id,account_id)
);
create table products (
 id text primary key,
 title text not null,
 active boolean not null default true
);
insert into products(id,title) values('zurvan','Zurvan');
create table prices (
 id uuid primary key default gen_random_uuid(),
 product_id text not null references products(id),
 region text not null check(region in ('IR','GLOBAL')),
 currency text not null check(currency in ('IRT','USD','EUR')),
 amount_minor bigint not null check(amount_minor > 0),
 gateway text not null,
 active boolean not null default false,
 created_at timestamptz not null default now()
);
create table orders (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references accounts(id),
 product_id text not null references products(id),
 price_id uuid not null references prices(id),
 currency text not null,
 amount_minor bigint not null check(amount_minor > 0),
 status text not null default 'pending' check(status in ('pending','paid','failed','refunded')),
 created_at timestamptz not null default now(),
 paid_at timestamptz
);
create table payments (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references orders(id),
 provider text not null,
 provider_transaction_id text,
 provider_event_id text,
 status text not null check(status in ('pending','verified','failed','refunded')),
 verified_amount_minor bigint,
 verified_currency text,
 verified_at timestamptz,
 created_at timestamptz not null default now(),
 unique(provider,provider_transaction_id),
 unique(provider,provider_event_id)
);
create table licenses (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references accounts(id),
 product_id text not null references products(id),
 order_id uuid unique references orders(id),
 code_hash text unique,
 kind text not null default 'lifetime' check(kind='lifetime'),
 status text not null default 'active' check(status in ('active','revoked','suspended')),
 generation bigint not null default 1 check(generation > 0),
 created_at timestamptz not null default now(),
 unique(account_id,product_id)
);
create table activations (
 id uuid primary key default gen_random_uuid(),
 license_id uuid not null references licenses(id),
 device_id uuid not null references devices(id),
 activated_at timestamptz not null default now(),
 revoked_at timestamptz,
 unique(license_id,device_id,activated_at)
);
-- Database-enforced single online active device per license.
create unique index activations_one_current_per_license on activations(license_id) where revoked_at is null;

create table device_transfers (
 id uuid primary key default gen_random_uuid(),
 license_id uuid not null references licenses(id),
 old_device_id uuid references devices(id),
 new_device_id uuid not null references devices(id),
 reason text not null check(reason in ('broken','sold','lost','upgrade')),
 state text not null check(state in ('requested','completed','rejected')),
 completed_at timestamptz,
 created_at timestamptz not null default now()
);
create table license_checks (
 id bigserial primary key,
 license_id uuid not null references licenses(id),
 device_id uuid not null references devices(id),
 status text not null,
 checked_at timestamptz not null default now()
);
create index license_checks_license_recent on license_checks(license_id,checked_at desc);
create table audit_logs (
 id bigserial primary key,
 actor_account_id uuid references accounts(id),
 action text not null,
 subject_type text not null,
 subject_id text,
 metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
-- Critical transactional operations must run server-side:
--   Verify provider confirmation and order amount/currency before issuing a license.
--   Lock licenses row (SELECT ... FOR UPDATE) before transfer.
--   Revoke old activation, increment generation, insert new activation, record audit in ONE transaction.
--   Device public-key possession must be proven via signed nonce.
-- Password hashes: Argon2id from trusted auth server; never compute/store plaintext.
-- PostgreSQL/Supabase: configure RLS, backend role separation, rotation and backups before production.
