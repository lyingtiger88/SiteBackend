-- Convert the proposed Zurvan purchase model to a prepaid annual subscription.
-- Existing rows, if any, are converted to one-year grants from their creation date.
begin;
alter table public.zurvan_licenses
  add column if not exists expires_at timestamptz;
update public.zurvan_licenses
  set type='annual', expires_at=coalesce(expires_at,created_at + interval '1 year')
  where type <> 'annual' or expires_at is null;
alter table public.zurvan_licenses
  drop constraint if exists zurvan_licenses_type_check;
alter table public.zurvan_licenses
  add constraint zurvan_licenses_type_check check(type='annual');
alter table public.zurvan_licenses
  add constraint zurvan_annual_expiry_check check(expires_at is not null);
commit;
