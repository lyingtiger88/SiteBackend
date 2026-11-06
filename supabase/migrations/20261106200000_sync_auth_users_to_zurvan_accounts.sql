-- Keep the user directory in sync with Supabase Auth automatically.
-- An Auth signup creates ONLY a provisional Zurvan profile. It does not issue
-- any license, consume a hardware quota, or bypass device enrollment.
begin;

create or replace function public.zurvan_sync_auth_user_profile()
returns trigger
language plpgsql security definer
set search_path=''
as $$
begin
  insert into public.zurvan_accounts
    (id,username,recovery_email,recovery_verified_at,status,created_at)
  values
    (new.id,null,new.email,new.email_confirmed_at,'provisional',new.created_at)
  on conflict (id) do nothing;
  return new;
end
$$;

revoke all on function public.zurvan_sync_auth_user_profile()
  from public,anon,authenticated;

drop trigger if exists zurvan_on_auth_user_created on auth.users;
create trigger zurvan_on_auth_user_created
after insert on auth.users
for each row execute function public.zurvan_sync_auth_user_profile();

-- Reconcile previously registered Auth accounts, without overwriting
-- existing account state, username, Super status, device links or licenses.
insert into public.zurvan_accounts
  (id,username,recovery_email,recovery_verified_at,status,created_at)
select
  u.id,null,u.email,u.email_confirmed_at,'provisional',u.created_at
from auth.users u
where not exists (
  select 1 from public.zurvan_accounts a where a.id=u.id
)
on conflict(id) do nothing;

commit;

-- Verification: every Auth user should have a Zurvan profile, but only
-- device-enrolled users should be active.
select
  count(*) as total_auth_users,
  count(*) filter(where z.id is not null) as linked_profiles,
  count(*) filter(where z.id is null) as missing_profiles,
  count(*) filter(where z.status='provisional') as pending_device_enrollment,
  count(*) filter(where z.status='active') as active_profiles
from auth.users u
left join public.zurvan_accounts z on z.id=u.id;
