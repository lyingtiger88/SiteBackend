// Zurvan Desk API hosted on Supabase Edge Functions.
// The Desk identity/session system is intentionally separate from Supabase Auth
// and the Zurvan License Server account/device tables.
//
// Clients encrypt filenames and file payloads before sending them. This function
// stores opaque ciphertext only; it never receives a Vault Key or recovery phrase.
import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "zurvan-desk-encrypted";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const PBKDF2_ITERATIONS = 210_000;
const SESSION_DAYS = 30;
const ENCRYPTED_MIME = "application/vnd.zurvan.encrypted-file+json";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}
function fail(status: number, error: string): Response {
  return reply(status, { error });
}
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("");
}
async function derivePasswordHash(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const saltBytes = new Uint8Array(salt.length);
  saltBytes.set(salt);
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: PBKDF2_ITERATIONS },
    material,
    256,
  );
  return new Uint8Array(bits);
}
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
function normalizeIdentifier(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function bearer(request: Request): string | null {
  return request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}
function clientIp(request: Request): string {
  // cf-connecting-ip is set by the edge proxy; fallback is only for local tests.
  return request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
}
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_JSON_BYTES) return null;
  const raw = await request.text();
  if (raw.length > MAX_JSON_BYTES) return null;
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
function fileResponse(file: Record<string, unknown>) {
  return {
    id: file.id,
    encryptedName: file.encrypted_name,
    size: file.size,
    modifiedAtUtc: file.modified_at,
    contentType: file.content_type,
  };
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceKey) {
  console.error("Zurvan Desk API is missing Supabase server configuration.");
}
const db = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

async function authenticate(request: Request) {
  const token = bearer(request);
  if (!token || !db) return null;
  const tokenHash = await sha256Hex(token);
  const { data: session, error } = await db.from("zurvan_desk_sessions")
    .select("account_id,expires_at")
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !session) return null;
  const { data: account, error: accountError } = await db.from("zurvan_desk_accounts")
    .select("id,identifier,display_name,vault_id")
    .eq("id", session.account_id)
    .maybeSingle();
  if (accountError || !account) return null;
  return { tokenHash, account };
}

async function consumeAuthRateLimit(request: Request): Promise<boolean> {
  if (!db) return false;
  const ipHash = await sha256Hex("zurvan-desk-auth:" + clientIp(request));
  const { data, error } = await db.rpc("zurvan_desk_consume_auth_limit", {
    p_key_hash: ipHash,
    p_limit: 12,
    p_window_seconds: 600,
  });
  if (error) {
    console.error("Desk auth rate limit unavailable:", error.code);
    return false; // Fail closed when the rate-limit store is unavailable.
  }
  return data === true;
}

Deno.serve(async (request: Request) => {
  if (!db) return fail(503, "service_not_configured");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const url = new URL(request.url);
  const marker = "/functions/v1/zurvan-desk-api";
  const markerIndex = url.pathname.indexOf(marker);
  const path = markerIndex >= 0 ? url.pathname.slice(markerIndex + marker.length) : url.pathname;
  const method = request.method.toUpperCase();

  try {
    if (method === "GET" && path === "/health") {
      const { error: schemaError } = await db.from("zurvan_desk_accounts")
        .select("id")
        .limit(1);
      if (schemaError) {
        console.error("Desk schema readiness check failed:", schemaError.code);
        return fail(503, "desk_database_migration_required");
      }
      const { data: bucket, error: bucketError } = await db.storage.getBucket(BUCKET);
      if (bucketError || !bucket || bucket.public) {
        console.error("Desk private bucket readiness check failed:", bucketError?.message ?? "bucket_not_private");
        return fail(503, "desk_private_storage_bucket_not_ready");
      }
      return reply(200, { service: "zurvan-desk-api", status: "ok", apiVersion: "v1" });
    }

    if (method === "POST" && (path === "/api/v1/auth/register" || path === "/api/v1/auth/login")) {
      if (!await consumeAuthRateLimit(request)) return fail(429, "تعداد درخواست‌ها بیش از حد مجاز است. چند دقیقه بعد دوباره تلاش کنید.");
      let input: Record<string, unknown> | null;
      try { input = await readJson(request); } catch { return fail(400, "درخواست نامعتبر است."); }
      if (!input) return fail(413, "درخواست نامعتبر یا بیش از حد بزرگ است.");
      const identifier = normalizeIdentifier(input.identifier);
      const password = typeof input.password === "string" ? input.password : "";
      const isRegister = path.endsWith("/register");
      if (identifier.length < 3 || identifier.length > 254) return fail(400, "شناسه حساب معتبر نیست.");
      if (password.length < 8 || password.length > 1024) return fail(400, "رمز عبور باید حداقل ۸ نویسه باشد.");
      if (isRegister) {
        const salt = randomBytes(16);
        const hash = await derivePasswordHash(password, salt);
        const vaultId = "vault_" + crypto.randomUUID().replaceAll("-", "");
        const displayName = typeof input.displayName === "string" && input.displayName.trim()
          ? input.displayName.trim().slice(0, 100) : null;
        const { data: account, error } = await db.from("zurvan_desk_accounts").insert({
          identifier,
          display_name: displayName,
          password_salt: toBase64(salt),
          password_hash: toBase64(hash),
          vault_id: vaultId,
        }).select("id,identifier,display_name,vault_id").single();
        salt.fill(0); hash.fill(0);
        if (error) {
          if (error.code === "23505") return fail(409, "این حساب قبلاً ساخته شده است.");
          console.error("Desk register failed:", error.code);
          return fail(503, "ساخت حساب در حال حاضر انجام نشد.");
        }
        const token = base64Url(randomBytes(32));
        const tokenHash = await sha256Hex(token);
        const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
        const { error: sessionError } = await db.from("zurvan_desk_sessions")
          .insert({ token_hash: tokenHash, account_id: account.id, expires_at: expiresAt });
        if (sessionError) {
          await db.from("zurvan_desk_accounts").delete().eq("id", account.id);
          console.error("Desk session creation failed:", sessionError.code);
          return fail(503, "ساخت نشست حساب انجام نشد.");
        }
        return reply(201, { token, vaultId: account.vault_id, displayName: account.display_name, identifier: account.identifier });
      }

      const { data: account, error } = await db.from("zurvan_desk_accounts")
        .select("id,identifier,display_name,vault_id,password_salt,password_hash")
        .eq("identifier", identifier).maybeSingle();
      if (error) {
        console.error("Desk login lookup failed:", error.code);
        return fail(503, "ورود در حال حاضر امکان‌پذیر نیست.");
      }
      if (!account) return fail(401, "نام کاربری یا رمز عبور نادرست است.");
      let salt: Uint8Array, expected: Uint8Array;
      try {
        salt = fromBase64(account.password_salt);
        expected = fromBase64(account.password_hash);
      } catch { return fail(401, "نام کاربری یا رمز عبور نادرست است."); }
      const actual = await derivePasswordHash(password, salt);
      const valid = constantTimeEqual(actual, expected);
      salt.fill(0); expected.fill(0); actual.fill(0);
      if (!valid) return fail(401, "نام کاربری یا رمز عبور نادرست است.");
      const token = base64Url(randomBytes(32));
      const tokenHash = await sha256Hex(token);
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
      const { error: sessionError } = await db.from("zurvan_desk_sessions")
        .insert({ token_hash: tokenHash, account_id: account.id, expires_at: expiresAt });
      if (sessionError) {
        console.error("Desk session creation failed:", sessionError.code);
        return fail(503, "ساخت نشست حساب انجام نشد.");
      }
      return reply(200, { token, vaultId: account.vault_id, displayName: account.display_name, identifier: account.identifier });
    }

    if (method === "POST" && path === "/api/v1/auth/logout") {
      const auth = await authenticate(request);
      if (!auth) return fail(401, "unauthorized");
      const { error } = await db.from("zurvan_desk_sessions").delete().eq("token_hash", auth.tokenHash);
      if (error) return fail(503, "خروج از حساب انجام نشد.");
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    if (method === "GET" && path === "/api/v1/account") {
      const auth = await authenticate(request);
      if (!auth) return fail(401, "unauthorized");
      return reply(200, {
        id: auth.account.id,
        identifier: auth.account.identifier,
        displayName: auth.account.display_name,
        vaultId: auth.account.vault_id,
      });
    }

    if (path === "/api/v1/recovery" && method === "PUT") {
      const auth = await authenticate(request);
      if (!auth) return fail(401, "unauthorized");
      let input: Record<string, unknown> | null;
      try { input = await readJson(request); } catch { return fail(400, "درخواست نامعتبر است."); }
      const payload = typeof input?.payload === "string" ? input.payload : "";
      if (!payload || payload.length > 64_000) return fail(400, "Recovery envelope is invalid.");
      const { error } = await db.from("zurvan_desk_accounts")
        .update({ recovery_envelope: payload }).eq("id", auth.account.id);
      if (error) return fail(503, "ذخیره اطلاعات بازیابی انجام نشد.");
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    if (path === "/api/v1/recovery" && method === "GET") {
      const auth = await authenticate(request);
      if (!auth) return fail(401, "unauthorized");
      const { data, error } = await db.from("zurvan_desk_accounts")
        .select("recovery_envelope").eq("id", auth.account.id).single();
      if (error) return fail(503, "دریافت اطلاعات بازیابی انجام نشد.");
      if (!data.recovery_envelope) return fail(404, "اطلاعات بازیابی برای این حساب ثبت نشده است.");
      return reply(200, { payload: data.recovery_envelope });
    }

    if (method === "GET" && path === "/api/v1/files") {
      const auth = await authenticate(request);
      if (!auth) return fail(401, "unauthorized");
      const { data, error } = await db.from("zurvan_desk_files")
        .select("id,encrypted_name,size,modified_at,content_type")
        .eq("account_id", auth.account.id)
        .order("modified_at", { ascending: false });
      if (error) return fail(503, "دریافت فهرست فایل‌ها انجام نشد.");
      return reply(200, (data ?? []).map(fileResponse));
    }

    if (method === "POST" && path === "/api/v1/files") {
      const auth = await authenticate(request);
      if (!auth) return fail(401, "unauthorized");
      const encryptedName = request.headers.get("x-zurvan-encrypted-name") ?? "";
      if (!encryptedName || encryptedName.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encryptedName)) {
        return fail(400, "Encrypted file name metadata is required.");
      }
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > MAX_FILE_BYTES) return fail(413, "حداکثر حجم هر فایل در پلن فعلی ۵۰ مگابایت است.");
      const payload = new Uint8Array(await request.arrayBuffer());
      if (payload.length <= 0 || payload.length > MAX_FILE_BYTES) return fail(413, "حداکثر حجم هر فایل در پلن فعلی ۵۰ مگابایت است.");
      const fileId = "file_" + crypto.randomUUID().replaceAll("-", "");
      const storagePath = auth.account.id + "/" + fileId + ".zdf";
      const { error: storageError } = await db.storage.from(BUCKET).upload(storagePath, payload, {
        contentType: ENCRYPTED_MIME,
        upsert: false,
      });
      payload.fill(0);
      if (storageError) {
        console.error("Desk encrypted upload failed:", storageError.message);
        return fail(503, "آپلود فایل انجام نشد.");
      }
      const { data: file, error } = await db.from("zurvan_desk_files").insert({
        id: fileId,
        account_id: auth.account.id,
        encrypted_name: encryptedName,
        size: payload.length,
        content_type: ENCRYPTED_MIME,
        storage_path: storagePath,
      }).select("id,encrypted_name,size,modified_at,content_type").single();
      if (error) {
        await db.storage.from(BUCKET).remove([storagePath]);
        console.error("Desk file metadata insert failed:", error.code);
        return fail(503, "ثبت مشخصات فایل انجام نشد.");
      }
      return reply(200, fileResponse(file));
    }

    const fileMatch = path.match(/^\/api\/v1\/files\/(file_[0-9a-f]{32})(?:\/metadata)?$/);
    if (fileMatch) {
      const auth = await authenticate(request);
      if (!auth) return fail(401, "unauthorized");
      const fileId = fileMatch[1];
      const { data: file, error } = await db.from("zurvan_desk_files")
        .select("id,account_id,encrypted_name,size,modified_at,content_type,storage_path")
        .eq("id", fileId).eq("account_id", auth.account.id).maybeSingle();
      if (error) return fail(503, "دریافت مشخصات فایل انجام نشد.");
      if (!file) return fail(404, "فایل پیدا نشد.");

      if (method === "GET" && path.endsWith("/metadata")) return reply(200, fileResponse(file));
      if (method === "GET") {
        const { data: blob, error: downloadError } = await db.storage.from(BUCKET).download(file.storage_path);
        if (downloadError || !blob) return fail(404, "محتوای فایل پیدا نشد.");
        return new Response(blob, {
          status: 200,
          headers: {
            "content-type": ENCRYPTED_MIME,
            "content-length": String(file.size),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (method === "PUT" && path.endsWith("/metadata")) {
        let input: Record<string, unknown> | null;
        try { input = await readJson(request); } catch { return fail(400, "درخواست نامعتبر است."); }
        const encrypted = typeof input?.encryptedName === "string" ? input.encryptedName : "";
        if (!encrypted || encrypted.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) return fail(400, "EncryptedName is required.");
        const { data: updated, error: updateError } = await db.from("zurvan_desk_files")
          .update({ encrypted_name: encrypted, modified_at: new Date().toISOString() })
          .eq("id", fileId).eq("account_id", auth.account.id)
          .select("id,encrypted_name,size,modified_at,content_type").single();
        if (updateError) return fail(503, "تغییر نام فایل انجام نشد.");
        return reply(200, fileResponse(updated));
      }
      if (method === "DELETE" && !path.endsWith("/metadata")) {
        const { error: storageError } = await db.storage.from(BUCKET).remove([file.storage_path]);
        if (storageError) {
          console.error("Desk blob deletion failed:", storageError.message);
          return fail(503, "حذف محتوای فایل انجام نشد؛ اطلاعات فایل حفظ شد تا دوباره تلاش کنید.");
        }
        const { error: deleteError } = await db.from("zurvan_desk_files")
          .delete().eq("id", fileId).eq("account_id", auth.account.id);
        if (deleteError) return fail(503, "محتوای فایل حذف شد اما پاکسازی مشخصات فایل کامل نشد.");
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
    }

    return fail(404, "مسیر درخواست پیدا نشد.");
  } catch (error) {
    console.error("Zurvan Desk API unexpected error:", error instanceof Error ? error.message : "unknown");
    return fail(500, "خطای داخلی سرویس زروان دسک.");
  }
});
