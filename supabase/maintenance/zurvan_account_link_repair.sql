-- Non-destructive reconciliation for already-active verified user accounts.
-- Only INSERT missing zurvan_accounts rows. NEVER overwrites existing license owners.
-- Aborts if any username is already associated with a different Auth UUID.
-- Requires the baseline zurvan_accounts schema; run only after reviewing the preflight.
begin;
do $$
declare
 conflicts integer;
begin
 select count(*) into conflicts
 from public.accounts a
 join auth.users u on u.id=a.auth_user_id and u.email_confirmed_at is not null
 join public.zurvan_accounts z on lower(z.username)=lower(a.username)
 where a.state='active' and a.username is not null and z.id <> a.auth_user_id;
 if conflicts > 0 then
   raise exception 'identity_conflict: % conflicting usernames; review manually before repair',conflicts;
 end if;

 insert into public.zurvan_accounts(id,username,recovery_email,recovery_verified_at,status)
 select u.id,a.username,u.email,u.email_confirmed_at,'active'
 from public.accounts a
 join auth.users u on u.id=a.auth_user_id and u.email_confirmed_at is not null
 where a.state='active'
   and a.username is not null
   and not exists(select 1 from public.zurvan_accounts z where z.id=u.id)
 on conflict(id) do nothing;
end
$$;
commit;

-- Read-only verification, no personal data included.
select
 count(*) filter(where a.auth_user_id is not null and a.state='active') as active_profiles,
 count(*) filter(where a.auth_user_id is not null and a.state='active' and z.id is null) as still_missing_license_identity
from public.accounts a
left join public.zurvan_accounts z on z.id=a.auth_user_id;
