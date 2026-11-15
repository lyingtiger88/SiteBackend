begin;
create or replace function public.kaliia_start_trial(p_auth_user_id uuid,p_product_id text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare account_row public.accounts%rowtype; license_row public.zurvan_licenses%rowtype; expiry timestamptz;
begin
 if p_auth_user_id is null or p_product_id not in ('zurvan','maal','shopmanager') then raise exception 'invalid_trial_request' using errcode='22023'; end if;
 select * into account_row from public.accounts where auth_user_id=p_auth_user_id and state='active' for update;
 if not found then raise exception 'account_not_registered' using errcode='42501'; end if;
 if not exists(select 1 from public.zurvan_accounts where id=p_auth_user_id and status='active') then raise exception 'license_account_inactive' using errcode='42501'; end if;
 if not exists(select 1 from public.zurvan_products where id=p_product_id and enabled=true) then raise exception 'product_unavailable' using errcode='55000'; end if;
 select * into license_row from public.zurvan_licenses where account_id=p_auth_user_id and product_id=p_product_id for update;
 if found then return jsonb_build_object('product_id',p_product_id,'status',case when license_row.status<>'active' then license_row.status when license_row.expires_at is not null and license_row.expires_at<=now() then 'expired' else 'active' end,'license_type',license_row.type,'expires_at',license_row.expires_at,'trial_created',false,'can_write',license_row.status='active' and (license_row.expires_at is null or license_row.expires_at>now()),'days_remaining',greatest(0,ceil(extract(epoch from (license_row.expires_at-now()))/86400)::int)); end if;
 expiry:=now()+interval '45 days';
 insert into public.zurvan_licenses(account_id,product_id,type,status,generation,expires_at) values(p_auth_user_id,p_product_id,'trial','active',1,expiry);
 return jsonb_build_object('product_id',p_product_id,'status','active','license_type','trial','expires_at',expiry,'trial_created',true,'can_write',true,'days_remaining',45);
end; $$;
revoke all on function public.kaliia_start_trial(uuid,text) from public,anon,authenticated;
grant execute on function public.kaliia_start_trial(uuid,text) to service_role;
commit;