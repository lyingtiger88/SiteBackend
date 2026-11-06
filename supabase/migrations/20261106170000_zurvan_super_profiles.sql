-- Super levels live directly in public.zurvan_accounts for easy Table Editor administration.
-- PostgreSQL ENUM values appear as selectable options in Supabase Table Editor.
-- The Super display title remains free-form text; never overwrite a custom title.
begin;

do $$
begin
  create type public.zurvan_super_type as enum
    ('founder','inner_circle','elite','royal');
exception when duplicate_object then null;
end $$;

alter table public.zurvan_accounts
  add column if not exists super_type text,
  add column if not exists super_title text,
  add column if not exists super_theme text,
  add column if not exists super_granted_at timestamptz;

-- Drop previously suggested text CHECK constraint before casting to ENUM.
alter table public.zurvan_accounts
  drop constraint if exists zurvan_super_type_check;

-- Reject unknown existing values without deleting or rewriting accounts.
do $$
declare invalid_types text;
begin
  select string_agg(distinct super_type::text, ', ')
    into invalid_types
  from public.zurvan_accounts
  where super_type is not null
    and super_type::text not in ('founder','inner_circle','elite','royal');
  if invalid_types is not null then
    raise exception 'Unknown super_type values: %',invalid_types;
  end if;
end $$;

alter table public.zurvan_accounts
  alter column super_type type public.zurvan_super_type
    using super_type::text::public.zurvan_super_type;

comment on column public.zurvan_accounts.super_type is
  'Optional special membership level: founder, inner_circle, elite or royal.';
comment on column public.zurvan_accounts.super_title is
  'Administrator-editable display title shown in the Zurvan license screen.';
comment on column public.zurvan_accounts.super_theme is
  'Client theme identifier for this special membership level.';

-- Keep the original RLS/privilege restrictions. A logged-in app user cannot
-- grant a Super level by editing account metadata.
commit;

-- Example: set an existing user's Super level and a custom title via Table Editor
-- (as postgres) or via audited SQL Editor operations. No account is changed
-- automatically by this migration.
