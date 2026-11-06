-- Zurvan Desk cloud accounts and encrypted file metadata.
-- The Desk identity is intentionally separate from public.accounts / Supabase Auth licensing identities.
begin;

create table if not exists public.zurvan_desk_accounts (
  id uuid primary key default gen_random_uuid(),
  identifier text not null,
  display_name text,
  password_salt text not null,
  password_hash text not null,
  vault_id text not null unique,
  recovery_envelope text,
  created_at timestamptz not null default now(),
  constraint zurvan_desk_identifier_unique unique (identifier),
  constraint zurvan_desk_identifier_length check (char_length(identifier) between 3 and 254),
  constraint zurvan_desk_password_salt_length check (char_length(password_salt) between 20 and 64),
  constraint zurvan_desk_password_hash_length check (char_length(password_hash) between 40 and 128)
);

create table if not exists public.zurvan_desk_sessions (
  token_hash text primary key,
  account_id uuid not null references public.zurvan_desk_accounts(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists zurvan_desk_sessions_account_idx
  on public.zurvan_desk_sessions(account_id);
create index if not exists zurvan_desk_sessions_expiry_idx
  on public.zurvan_desk_sessions(expires_at);

create table if not exists public.zurvan_desk_files (
  id text primary key,
  account_id uuid not null references public.zurvan_desk_accounts(id) on delete cascade,
  encrypted_name text not null,
  size bigint not null check (size > 0 and size <= 52428800),
  content_type text not null default 'application/vnd.zurvan.encrypted-file+json',
  storage_path text not null unique,
  modified_at timestamptz not null default now()
);
create index if not exists zurvan_desk_files_account_modified_idx
  on public.zurvan_desk_files(account_id, modified_at desc);

-- Auth throttling is enforced atomically in Postgres so concurrent requests cannot bypass it.
create table if not exists public.zurvan_desk_auth_limits (
  key_hash text primary key,
  window_started_at timestamptz not null,
  attempts integer not null check (attempts >= 0)
);

create or replace function public.zurvan_desk_consume_auth_limit(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
begin
  insert into public.zurvan_desk_auth_limits(key_hash, window_started_at, attempts)
  values (p_key_hash, now(), 1)
  on conflict (key_hash) do update
    set attempts = case
          when public.zurvan_desk_auth_limits.window_started_at
               < now() - make_interval(secs => p_window_seconds)
          then 1
          else public.zurvan_desk_auth_limits.attempts + 1
        end,
        window_started_at = case
          when public.zurvan_desk_auth_limits.window_started_at
               < now() - make_interval(secs => p_window_seconds)
          then now()
          else public.zurvan_desk_auth_limits.window_started_at
        end
  returning attempts into v_attempts;

  return v_attempts <= p_limit;
end;
$$;

alter table public.zurvan_desk_accounts enable row level security;
alter table public.zurvan_desk_accounts force row level security;
alter table public.zurvan_desk_sessions enable row level security;
alter table public.zurvan_desk_sessions force row level security;
alter table public.zurvan_desk_files enable row level security;
alter table public.zurvan_desk_files force row level security;
alter table public.zurvan_desk_auth_limits enable row level security;
alter table public.zurvan_desk_auth_limits force row level security;

revoke all on table public.zurvan_desk_accounts from anon, authenticated;
revoke all on table public.zurvan_desk_sessions from anon, authenticated;
revoke all on table public.zurvan_desk_files from anon, authenticated;
revoke all on table public.zurvan_desk_auth_limits from anon, authenticated;
revoke all on function public.zurvan_desk_consume_auth_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.zurvan_desk_consume_auth_limit(text, integer, integer) to service_role;

-- Private bucket: no client-side storage policies. Only the Desk API (service role)
-- can access objects after validating the independent Desk session.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'zurvan-desk-encrypted',
  'zurvan-desk-encrypted',
  false,
  52428800,
  array['application/vnd.zurvan.encrypted-file+json']
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

commit;
