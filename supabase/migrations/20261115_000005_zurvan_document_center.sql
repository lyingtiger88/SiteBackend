begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('zurvan-payment-receipts','zurvan-payment-receipts',false,5242880,array['image/jpeg','image/png','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=5242880,allowed_mime_types=excluded.allowed_mime_types;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('zurvan-document-archive','zurvan-document-archive',false,10485760,array['application/pdf','image/jpeg','image/png','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain','application/zip'])
on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('zurvan-product-media','zurvan-product-media',true,15728640,array['image/jpeg','image/png','image/webp','image/avif'])
on conflict(id) do update set public=true,file_size_limit=15728640,allowed_mime_types=excluded.allowed_mime_types;
create table if not exists public.zurvan_documents (
 id uuid primary key default gen_random_uuid(), owner_user_id uuid not null references auth.users(id) on delete restrict,
 document_scope text not null check(document_scope in ('customer','admin')),
 document_type text not null check(document_type in ('identity_attachment','contract','support_attachment','invoice','payment_proof','business_document','other')),
 product_id text, title text not null check(char_length(btrim(title)) between 1 and 160),
 storage_bucket text not null default 'zurvan-document-archive' check(storage_bucket='zurvan-document-archive'),
 storage_path text not null unique,
 mime_type text not null check(mime_type in ('application/pdf','image/jpeg','image/png','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain','application/zip')),
 file_size integer not null check(file_size between 1 and 10485760), notes text,
 created_at timestamptz not null default now(), created_by uuid not null references auth.users(id),
 deleted_at timestamptz, deleted_by uuid references auth.users(id)
);
create index if not exists zurvan_documents_owner_date_idx on public.zurvan_documents(owner_user_id,created_at desc) where deleted_at is null;
create index if not exists zurvan_documents_scope_date_idx on public.zurvan_documents(document_scope,created_at desc) where deleted_at is null;
alter table public.zurvan_documents enable row level security;
revoke all on public.zurvan_documents from public,anon,authenticated;
grant all on public.zurvan_documents to service_role;
alter table public.zurvan_manual_payments add column if not exists product_id text, add column if not exists plan_code text, add column if not exists amount_minor bigint, add column if not exists currency text not null default 'IRR', add column if not exists bank_reference text, add column if not exists transfer_at timestamptz;
alter table public.zurvan_manual_payments add constraint zurvan_manual_payments_amount_nonnegative check(amount_minor is null or amount_minor>0);
alter table public.zurvan_manual_payments add constraint zurvan_manual_payments_currency_allowed check(currency in ('IRR','IRT','USD','EUR'));
drop policy if exists "zurvan product media public read" on storage.objects;
create policy "zurvan product media public read" on storage.objects for select to anon,authenticated using(bucket_id='zurvan-product-media');
commit;