# Document Center — Operations

## User workflow
1. Sign in with a verified account at \`web/admin/documents.html\`.
2. Open **بارگذاری سند**.
3. Enter a title, choose a document category and optional product, choose the file, then upload.
4. The file is stored in the private \`zurvan-document-archive\` bucket. The metadata is recorded in \`zurvan_documents\`.
5. Under **اسناد من**, use **مشاهده / دانلود**. The server issues a signed URL that expires after 120 seconds.

Accepted files: PDF, JPG, PNG, DOCX, XLSX, TXT, ZIP. Maximum size: 10 MiB.

## Administrator workflow
1. Sign in using an account already listed as active \`superadmin\` in \`zurvan_admin_users\`.
2. **آرشیو مدیریت** lists documents across customers; filter by document type or user UUID.
3. **رسیدهای پرداخت** lists payment submissions. Open the private receipt and compare the details with the bank's actual transaction record.
4. Only after verifying the transaction, use **تأیید و فعال‌سازی** or **رد درخواست**. Approval invokes the existing atomic manual-payment review function.
5. Soft-delete removes a document from active listings but does not physically erase its file.

## Storage layout
- Receipts: \`zurvan-payment-receipts/<user-id>/<request-id>.<ext>\`
- Customer documents: \`zurvan-document-archive/<user-id>/<document-id>.<ext>\`
- Internal documents: \`zurvan-document-archive/admin/<admin-id>/<document-id>.<ext>\`
- Product images: \`zurvan-product-media/products/<product>/<platform>/<filename>\`

Never place receipts, contracts or personal data in the public product-media bucket.

## Backup and retention
Database backups do not automatically guarantee restoration of Storage objects. Configure and periodically test both database and object backup/export. Define a retention period for rejected receipts and customer documents before enabling automatic deletion. Current soft-delete is reversible by a privileged operator at the database level; no automatic purge is configured.

## Important limits
The upload API accepts base64 JSON payloads up to 10 MiB. For larger documents, implement a signed/resumable upload flow instead of raising the request body limit.
