-- Make super_theme a PostgreSQL ENUM so Supabase Table Editor offers
-- a dropdown containing the real built-in Zurvan themes from the app repo.
-- Catalog reconciled from ZurvanThemes.kt and AppearanceCatalog.cs.
begin;

do $$
begin
  create type public.zurvan_super_theme as enum (
    'windows-light',
    'liquid-glass',
    'azure-glass',
    'graphite-night',
    'warm-sand',
    'zara-pastel',
    'season-vibe',
    'elena-mode'
  );
exception when duplicate_object then null;
end $$;

alter table public.zurvan_accounts
  add column if not exists super_theme text;

do $$
declare invalid_themes text;
begin
  select string_agg(distinct super_theme, ', ')
    into invalid_themes
  from public.zurvan_accounts
  where super_theme is not null
    and super_theme not in (
      'windows-light','liquid-glass','azure-glass','graphite-night',
      'warm-sand','zara-pastel','season-vibe','elena-mode'
    );
  if invalid_themes is not null then
    raise exception 'Unknown existing super_theme values: %', invalid_themes;
  end if;
end $$;

alter table public.zurvan_accounts
  alter column super_theme type public.zurvan_super_theme
  using super_theme::public.zurvan_super_theme;

comment on column public.zurvan_accounts.super_theme is
  'Exclusive theme selected from Zurvan built-in theme catalog. NULL means use the default theme for the Super tier.';

commit;
