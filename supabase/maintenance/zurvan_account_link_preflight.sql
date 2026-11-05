-- Read-only preflight for the identity split: no user emails, keys or tokens output.
-- Run this before any repair in the Supabase SQL Editor.
select
  count(*) filter (where a.auth_user_id is not null and a.state='active') as active_profiles,
  count(*) filter (where a.auth_user_id is not null and a.state='active' and z.id is null) as profiles_missing_license_identity,
  count(*) filter (where a.auth_user_id is not null and a.state='active' and z.id is not null and z.status='active') as active_linked_license_identities,
  count(*) filter (where a.auth_user_id is not null and a.state='active' and z.id is null and taken.id is not null) as username_conflicts_needing_manual_review
from public.accounts a
left join public.zurvan_accounts z on z.id=a.auth_user_id
left join public.zurvan_accounts taken
  on lower(taken.username)=lower(a.username)
  and taken.id is distinct from a.auth_user_id;
