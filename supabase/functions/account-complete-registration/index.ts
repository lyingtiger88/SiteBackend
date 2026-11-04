// Zurvan v2: bind a verified Supabase Auth session to an existing device-bound account.
// Auth registration (email/password + email verification) happens through Supabase Auth.
// Actions: "start" issues a short-lived nonce; "finish" verifies the original device signature.
// DEVELOPMENT ONLY until rate limits, abuse controls, recovery and monitoring are completed.
import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set(["http://localhost:8085", "http://127.0.0.1:8085"]);
function cors(origin: string | null) {
  return origin && allowedOrigins.has(origin)
    ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, apikey", vary: "Origin" }
    : {};
}
function response(data: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(origin) },
  });
}
function decodeB64url(value: string): Uint8Array {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw Error("invalid_b64");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async request => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: origin && allowedOrigins.has(origin) ? 204 : 403, headers: cors(origin) });
  }
  if (request.method !== "POST") return response({error:"method_not_allowed"},405,origin);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return response({error:"service_unavailable"},503,origin);
  const bearer = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!bearer) return response({error:"unauthorized"},401,origin);
  const db = createClient(url, serviceKey, {auth:{persistSession:false}});
  const {data: userData, error: authError} = await db.auth.getUser(bearer);
  const user = userData?.user;
  if (authError || !user) return response({error:"unauthorized"},401,origin);
  if (!user.email_confirmed_at) return response({error:"verify_email_first"},403,origin);

  let input: Record<string,unknown>;
  try {
    const raw = await request.text();
    if(raw.length > 4096) return response({error:"too_large"},413,origin);
    input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("invalid");
  } catch { return response({error:"invalid_json"},400,origin); }

  const action = input.action, accountId = input.account_id;
  if (typeof accountId !== "string" || !uuidPattern.test(accountId))
    return response({error:"invalid_request"},400,origin);

  if (action === "start") {
    // A random account id alone never grants ownership. Ownership is proven in finish.
    const {data:account,error:accError} = await db.from("accounts")
      .select("id,state,auth_user_id").eq("id",accountId).maybeSingle();
    if (accError) return response({error:"storage_unavailable"},503,origin);
    if (!account || account.state !== "provisional" || account.auth_user_id)
      return response({error:"account_not_available"},404,origin);
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const {data,error} = await db.from("account_registration_challenges")
      .insert({account_id:accountId,auth_user_id:user.id,nonce,
        expires_at:new Date(Date.now()+5*60_000).toISOString()})
      .select("id,nonce,expires_at").single();
    if (error) {
      console.error("registration challenge storage error",error.code,error.message);
      return response({error:"storage_unavailable"},503,origin);
    }
    return response({challenge_id:data.id,nonce:data.nonce,expires_at:data.expires_at},201,origin);
  }
  if (action !== "finish") return response({error:"invalid_action"},400,origin);
  const {challenge_id:challengeId,signature,username} = input;
  if(typeof challengeId !== "string" || !uuidPattern.test(challengeId) ||
     typeof signature !== "string" || typeof username !== "string" ||
     !/^[a-z][a-z0-9_]{3,23}$/.test(username))
    return response({error:"invalid_request"},400,origin);
  const {data:challenge,error:challengeError} = await db.from("account_registration_challenges")
    .select("id,account_id,auth_user_id,nonce,expires_at,consumed_at")
    .eq("id",challengeId).maybeSingle();
  if(challengeError) return response({error:"storage_unavailable"},503,origin);
  if(!challenge || challenge.account_id !== accountId || challenge.auth_user_id !== user.id ||
     challenge.consumed_at || new Date(challenge.expires_at).getTime()<=Date.now())
    return response({error:"invalid_challenge"},400,origin);

  const {data:devices,error:devicesError} = await db.from("devices")
    .select("public_key").eq("account_id",accountId).limit(2);
  if(devicesError || !devices || devices.length !== 1)
    return response({error:"device_unavailable"},409,origin);
  try {
    const rawKey = decodeB64url(devices[0].public_key);
    const sig = decodeB64url(signature);
    if(rawKey.length!==32 || sig.length!==64) throw Error("bad_length");
    const key = await crypto.subtle.importKey("raw",rawKey,{name:"Ed25519"},false,["verify"]);
    const bytes = new TextEncoder().encode("zurvan-account-registration-v2:"+challengeId+":"+challenge.nonce+":"+user.id+":"+username);
    const ok = await crypto.subtle.verify({name:"Ed25519"},key,sig,bytes);
    if(!ok) return response({error:"signature_rejected"},403,origin);
  } catch { return response({error:"signature_rejected"},403,origin); }

  const {data,error} = await db.rpc("complete_account_registration",{
    p_challenge_id:challengeId,p_auth_user_id:user.id,p_username:username
  });
  if(error) {
    console.error("complete_account_registration error",error.code,error.message);
    if(error.code === "23505") return response({error:"username_or_identity_taken"},409,origin);
    if(error.code === "22023" || error.code === "42501") return response({error:"registration_rejected"},403,origin);
    return response({error:"registration_failed"},503,origin);
  }
  return response(data,200,origin);
});
