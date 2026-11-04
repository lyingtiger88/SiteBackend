// Supabase Edge Function: device-enroll-start
// Public enrollment must be protected against automated abuse.
// Cloudflare Turnstile is required here; no challenge is issued if validation fails.
import { createClient } from "npm:@supabase/supabase-js@2";
const allowedOrigins = new Set(["http://localhost:8085", "http://127.0.0.1:8085"]);
const cors = (origin: string | null) => origin && allowedOrigins.has(origin)
  ? { "access-control-allow-origin": origin, "vary": "Origin",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, apikey, authorization" }
  : {};
const headers = (origin: string | null) => ({
  "content-type": "application/json", "cache-control": "no-store", ...cors(origin),
});
const reply = (data: unknown, status = 200, origin: string | null = null) =>
  new Response(JSON.stringify(data), { status, headers: headers(origin) });
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, {
    status: origin && allowedOrigins.has(origin) ? 204 : 403,
    headers: cors(origin),
  });
  // Only add Access-Control-Allow-Origin for approved browser test pages.
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405, origin);
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  const allowedHosts = (Deno.env.get("TURNSTILE_ALLOWED_HOSTNAMES") ?? "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !allowedHosts.length || !url || !serviceKey) return reply({ error: "service_not_configured" }, 503, origin);
  let body: Record<string, unknown>;
  try {
    if (Number(req.headers.get("content-length") ?? 0) > 8192) return reply({ error: "payload_too_large" }, 413, origin);
    const raw = await req.text();
    if (raw.length > 8192) return reply({ error: "payload_too_large" }, 413, origin);
    body = JSON.parse(raw);
  } catch { return reply({ error: "invalid_json" }, 400, origin); }
  const { public_key, platform, captcha_token } = body;
  if (typeof public_key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(public_key) ||
      !["android", "windows", "ios"].includes(String(platform)) ||
      typeof captcha_token !== "string" || captcha_token.length < 1 || captcha_token.length > 4096) {
    return reply({ error: "invalid_request" }, 400, origin);
  }
  try {
    const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: captcha_token }),
    });
    if (!verify.ok) return reply({ error: "captcha_unavailable" }, 503, origin);
    const challengeResult = await verify.json();
    if (challengeResult.success !== true || typeof challengeResult.hostname !== "string" || !allowedHosts.includes(challengeResult.hostname.toLowerCase())) return reply({ error: "captcha_failed" }, 403, origin);
    // A production deployment should also validate hostname/action from the verified CAPTCHA response
    // and enforce gateway / edge level per-IP throttling.
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    const client = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data, error } = await client.from("device_enrollment_challenges")
      .insert({ public_key, platform, nonce, expires_at: expires })
      .select("id, nonce, expires_at").single();
    if (error) return reply({ error: "storage_unavailable" }, 503, origin);
    return reply({ challenge_id: data.id, nonce: data.nonce, expires_at: data.expires_at }, 201, origin);
  } catch { return reply({ error: "temporarily_unavailable" }, 503, origin); }
});
