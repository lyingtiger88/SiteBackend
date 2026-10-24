// Supabase Edge Function: device-enroll-start
// Public enrollment must be protected against automated abuse.
// Cloudflare Turnstile is required here; no challenge is issued if validation fails.
import { createClient } from "npm:@supabase/supabase-js@2";
const headers = { "content-type": "application/json", "cache-control": "no-store" };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
const enc = new TextEncoder();
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !url || !serviceKey) return reply({ error: "service_not_configured" }, 503);
  let body: Record<string, unknown>;
  try {
    if (Number(req.headers.get("content-length") ?? 0) > 8192) return reply({ error: "payload_too_large" }, 413);
    body = await req.json();
  } catch { return reply({ error: "invalid_json" }, 400); }
  const { public_key, platform, captcha_token } = body;
  if (typeof public_key !== "string" || public_key.length < 32 || public_key.length > 2048 ||
      !["android", "windows", "ios"].includes(String(platform)) ||
      typeof captcha_token !== "string" || captcha_token.length < 1 || captcha_token.length > 4096) {
    return reply({ error: "invalid_request" }, 400);
  }
  try {
    const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: captcha_token }),
    });
    if (!verify.ok) return reply({ error: "captcha_unavailable" }, 503);
    const challengeResult = await verify.json();
    if (challengeResult.success !== true) return reply({ error: "captcha_failed" }, 403);
    // A production deployment should also validate hostname/action from the verified CAPTCHA response
    // and enforce gateway / edge level per-IP throttling.
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    const client = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data, error } = await client.from("device_enrollment_challenges")
      .insert({ public_key, platform, nonce, expires_at: expires })
      .select("id, nonce, expires_at").single();
    if (error) return reply({ error: "storage_unavailable" }, 503);
    return reply({ challenge_id: data.id, nonce: data.nonce, expires_at: data.expires_at }, 201);
  } catch { return reply({ error: "temporarily_unavailable" }, 503); }
});
