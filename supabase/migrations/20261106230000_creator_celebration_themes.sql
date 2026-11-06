-- Private, Creator-managed Persian-date celebration theme schedules.
-- A schedule repeats every Persian year on the configured month/day.
begin;

create table if not exists public.zurvan_celebration_schedules (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.zurvan_accounts(id) on delete cascade,
  occasion_type text not null check (occasion_type in (
    'birthday', 'meeting_anniversary', 'wedding_anniversary'
  )),
  persian_month smallint not null check (persian_month between 1 and 12),
  persian_day smallint not null check (
    (persian_month between 1 and 6 and persian_day between 1 and 31) or
    (persian_month between 7 and 11 and persian_day between 1 and 30) or
    (persian_month = 12 and persian_day between 1 and 30)
  ),
  theme_id public.zurvan_super_theme not null,
  enabled boolean not null default true,
  display_title text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, occasion_type)
);

comment on table public.zurvan_celebration_schedules is
  'Private recurring Persian-calendar celebration theme schedules, editable only by Creator-tier accounts.';
comment on column public.zurvan_celebration_schedules.persian_month is
  'Persian calendar month (1-12); schedule repeats annually.';
comment on column public.zurvan_celebration_schedules.persian_day is
  'Persian calendar day; Esfand accepts up to day 30 and runtime validates leap-year availability.';
comment on column public.zurvan_celebration_schedules.theme_id is
  'Theme id from Zurvan built-in theme catalog.';

create index if not exists ix_zurvan_celebration_account_enabled
  on public.zurvan_celebration_schedules(account_id, enabled);

create or replace function public.zurvan_is_creator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.zurvan_accounts a
    where a.id = auth.uid()
      and lower(coalesce(a.super_type::text, '')) = 'creator'
      and a.status = 'active'
  );
$$;

revoke all on function public.zurvan_is_creator() from public, anon;
grant execute on function public.zurvan_is_creator() to authenticated;

alter table public.zurvan_celebration_schedules enable row level security;

drop policy if exists "Users can read own celebration schedules"
  on public.zurvan_celebration_schedules;
create policy "Users can read own celebration schedules"
  on public.zurvan_celebration_schedules
  for select to authenticated
  using (account_id = auth.uid() or public.zurvan_is_creator());

drop policy if exists "Creator manages celebration schedules"
  on public.zurvan_celebration_schedules;
create policy "Creator manages celebration schedules"
  on public.zurvan_celebration_schedules
  for all to authenticated
  using (public.zurvan_is_creator())
  with check (public.zurvan_is_creator() and created_by = auth.uid());

grant select, insert, update, delete
  on public.zurvan_celebration_schedules to authenticated;

create or replace function public.zurvan_touch_celebration_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists zurvan_celebration_touch_updated_at
  on public.zurvan_celebration_schedules;
create trigger zurvan_celebration_touch_updated_at
before update on public.zurvan_celebration_schedules
for each row execute function public.zurvan_touch_celebration_updated_at();

commit;
