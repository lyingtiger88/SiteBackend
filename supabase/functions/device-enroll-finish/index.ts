// Device enrollment finish: validates Ed25519 proof and commits registration atomically.
// Deploy with verify_jwt=false; start endpoint requires CAPTCHA, plus deploy edge rate-limiting.
import { createClient } from "npm:@supabase/supabase-js@2";
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
function decode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw Error("bad_base64url");
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
Deno.serve(async req => {
  if (req.method !== "POST") return json({error:"method_not_allowed"},405);
  if (Number(req.headers.get("content-length") ?? 0) > 4096) return json({error:"too_large"},413);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({error:"invalid_json"},400); }
  const {challenge_id, public_key, signature} = body;
  if (typeof challenge_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(challenge_id) ||
      typeof public_key !== "string" || typeof signature !== "string")
    return json({error:"invalid_request"},400);
  let pub: Uint8Array, sig: Uint8Array;
  try { pub = decode(public_key); sig = decode(signature); }
  catch { return json({error:"invalid_encoding"},400); }
  if (pub.length !== 32 || sig.length !== 64) return json({error:"invalid_key_or_signature"},400);
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({error:"not_configured"},503);
  const db = createClient(url, key, {auth:{persistSession:false}});
  const {data:ch,error:readErr} = await db.from("device_enrollment_challenges")
    .select("id,public_key,nonce,expires_at,consumed_at").eq("id",challenge_id).maybeSingle();
  if (readErr) return json({error:"storage_unavailable"},503);
  if (!ch || ch.public_key !== public_key || ch.consumed_at ||
      new Date(ch.expires_at).getTime() <= Date.now()) return json({error:"invalid_challenge"},400);
  try {
    const verifyKey = await crypto.subtle.importKey("raw", pub, {name:"Ed25519"}, false, ["verify"]);
    const signedText = "zurvan-device-enrollment-v2:" + ch.id + ":" + ch.nonce;
    const verified = await crypto.subtle.verify(
      {name:"Ed25519"}, verifyKey, sig, new TextEncoder().encode(signedText));
    if (!verified) return json({error:"signature_rejected"},403);
  } catch { return json({error:"signature_rejected"},403); }
  const {data,error} = await db.rpc("complete_device_enrollment",{
    p_challenge_id:challenge_id,p_public_key:public_key
  });
  if (error) {
    if (error.message.includes("invalid_challenge") || error.message.includes("device_already_registered"))
      return json({error:"challenge_used_or_device_exists"},409);
    return json({error:"enrollment_failed"},503);
  }
  // This is NOT an authentication credential; session issuance follows in a separate authenticated step.
  return json({account_id:data.account_id,device_id:data.device_id,state:"provisional"},201);
});
