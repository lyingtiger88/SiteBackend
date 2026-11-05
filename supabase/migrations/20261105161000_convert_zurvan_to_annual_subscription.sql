-- Convert the proposed Zurvan purchase model to a prepaid annual subscription.
-- One successful payment grants 12 months; renewal extends from max(now(), current expiry).
begin;
alter table public.zurvan_licenses
  add column if not exists expires_at timestamptz;
alter table public.zurvan_licenses
  drop constraint if exists zurvan_licenses_type_check;
alter table public.zurvan_licenses
  add constraint zurvan_licenses_type_check check(type='annual');
alter table public.zurvan_licenses
  add constraint zurvan_annual_expiry_check check(expires_at is not null);
commit;
