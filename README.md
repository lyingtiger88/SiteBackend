# SiteBackend — Zurvan Storefront & Services

Source repository for the multi-product Zurvan storefront, account portal, manual-payment workflow, document archive and licensing services.

## Storefront rules
- Products offered for sale: Zurvan, Maal and ShopManager.
- پل سلامت is an informational showcase only and must never show purchase plans or checkout.
- Each commercial product has its own product page, screenshots, plans and independent entitlement.
- One customer account can purchase multiple products.
- Manual bank transfer: customer submits a receipt; only an authorized administrator may verify the bank transaction and approve/reject the request.
- Never store card CVV, PIN, OTP or full customer card credentials.

## Document and storage architecture
Supabase project: \`zurvan-license-server\` (region eu-west-1).

Buckets:
- \`zurvan-payment-receipts\`: private, JPG/PNG/PDF, maximum 5 MiB. Customer receipts.
- \`zurvan-document-archive\`: private, PDF/images/DOCX/XLSX/TXT/ZIP, maximum 10 MiB. Customer and internal documents.
- \`zurvan-product-media\`: public read-only media, images only, maximum 15 MiB. Product screenshots and marketing images.
- \`zurvan-desk-encrypted\`: existing encrypted desktop files; keep its separate policy and format.

Metadata:
- \`public.zurvan_documents\`: document owner, scope, type, product, title, storage path, MIME, size, notes and soft-delete audit.
- \`public.zurvan_manual_payments\`: payment request, receipt pointer, customer details, status/reviewer and optional transaction metadata.
- Raw files are not stored in database rows. Private files are only served using short-lived signed URLs.

Security model:
- Document metadata has RLS enabled and no direct anon/authenticated table grants; the Edge Function uses service role only after validating the user's JWT.
- Only active \`superadmin\` records in \`zurvan_admin_users\` can list all documents, view payment receipts, or approve/reject payments.
- Customers can list and request signed URLs only for their own documents.
- Soft-delete preserves the stored file for audit/recovery; it hides the document from active lists.
- Do not expose the service-role key in the browser or commit it to Git.

## Useful routes
- \`web/manual-payment/index.html\`: customer-facing manual transfer form.
- \`web/admin/documents.html\`: document center for customers and administrators.
- \`supabase/functions/zurvan-manual-payment/index.ts\`: payment submission and admin review API.
- \`supabase/functions/zurvan-document-center/index.ts\`: private document archive API.
- \`supabase/migrations/20261115_000005_zurvan_document_center.sql\`: buckets, document metadata and transaction metadata migration.

## Edge Function API
All requests are POST JSON with a valid Supabase Auth bearer token.
- \`upload\`: authenticated customer upload; admin-only when \`document_scope=admin\`.
- \`mine\`: list own documents.
- \`admin_list\`: administrator document archive, optional owner/type filters.
- \`signed_url\`: owner or administrator receives a 120-second signed URL.
- \`soft_delete\`: administrator soft-deletes metadata without destroying the file.
- \`payments_list\`: administrator payment register.
- \`payment_receipt_url\`: administrator gets a 120-second private receipt URL.

The admin page also calls the existing manual-payment function's \`admin_review\` action after explicit confirmation to activate or reject the relevant subscription.

## Deployment status
The database migration and \`zurvan-document-center\` Edge Function are deployed to the existing Supabase project. The admin/customer document UI is committed at \`web/admin/documents.html\` but is not yet published to the public hosting. Add the actual hosting origin to the Edge Function allowlist before publishing if it differs from kaliia.ir.

## Operational checklist before public launch
1. Publish the website and the admin document page over HTTPS.
2. Confirm email verification is enabled in Supabase Auth.
3. Confirm the actual administrator is active in \`zurvan_admin_users\` with role \`superadmin\`.
4. Perform end-to-end tests with a non-admin customer and the admin account: upload, owner-only listing, admin listing, signed download, soft-delete, receipt review and approval/rejection.
5. Configure backups and retention for the database and Storage objects. Test restoration.
6. Set real bank details and product prices in the appropriate admin configuration before accepting live payments.
7. Do not call the system production-ready until the end-to-end tests above pass.

GitHub is source control, not the live website host.