// Zurvan v2 - authenticated device-status and pending transfer requests.
// IMPORTANT: no automatic approval; verified human support review required.
// Deployment is development-only until rate-limiting and step-up checks are implemented.
import { createClient } from "npm:@supabase/supabase-js@2";
const origins = new Set(["http://localhost:8085","http://127.0.0.1:8085"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cors = (origin: string|null) =>
  origin && origins.has(origin)
  ? {"access-control-allow-origin":origin,"access-control-allow-headers":"authorization, apikey, content-type","access-control-allow-methods":"POST, OPTIONS",vary:"Origin"}
  : {};
const answer = (origin: string|null, status:number, obj:unknown) =>
  new Response(JSON.stringify(obj),{status,headers:{"content-type":"application/json","cache-control":"no-store",...cors(origin)}});
function decode(value: string): Uint8Array {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw Error("encoding");
  const padded=value.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"=");
  return Uint8Array.from(atob(padded),x=>x.charCodeAt(0));
}
function base64url(value: Uint8Array):string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
Deno.serve(async request => {
  const origin=request.headers.get("origin");
  if(request.method==="OPTIONS")return new Response(null,{status:origin&&origins.has(origin)?204:403,headers:cors(origin)});
  if(request.method!=="POST")return answer(origin,405,{error:"method_not_allowed"});
  const url=Deno.env.get("SUPABASE_URL"), secret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!secret)return answer(origin,503,{error:"not_configured"});
  const token=request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if(!token)return answer(origin,401,{error:"unauthorized"});
  const db=createClient(url,secret,{auth:{persistSession:false}});
  const {data:userData,error:userError}=await db.auth.getUser(token);
  const user=userData?.user;
  if(userError||!user||!user.email_confirmed_at)return answer(origin,401,{error:"unauthorized"});
  let input:Record<string,unknown>;
  try {
    const raw=await request.text();
    if(raw.length>4096)return answer(origin,413,{error:"request_too_large"});
    input=JSON.parse(raw);
    if(!input||typeof input!=="object"||Array.isArray(input))throw Error("invalid");
  }catch{return answer(origin,400,{error:"invalid_request"});}
  const {data:account,error:accountError}=await db.from("accounts")
    .select("id,username,state").eq("auth_user_id",user.id).eq("state","active").maybeSingle();
  if(accountError)return answer(origin,503,{error:"database_unavailable"});
  if(!account)return answer(origin,404,{error:"account_not_found"});

  if(input.action==="status") {
    const {data:device,error}=await db.from("devices")
      .select("id,platform,device_label,created_at")
      .eq("account_id",account.id).is("revoked_at",null).maybeSingle();
    if(error)return answer(origin,503,{error:"database_unavailable"});
    // Expired pending requests must not block the UI or a replacement request.
    const nowIso=new Date().toISOString();
    const {error:expireError}=await db.from("device_transfer_requests")
      .update({state:"expired",decided_at:nowIso})
      .eq("account_id",account.id).eq("state","pending").lte("expires_at",nowIso);
    if(expireError)return answer(origin,503,{error:"database_unavailable"});
    const {data:pending,error:pe}=await db.from("device_transfer_requests")
      .select("id,state,reason,created_at,expires_at,proof_verified_at")
      .eq("account_id",account.id).eq("state","pending").gt("expires_at",nowIso).maybeSingle();
    if(pe)return answer(origin,503,{error:"database_unavailable"});
    return answer(origin,200,{account:{username:account.username,state:account.state},device,transfer_request:pending});
  }

  // Two-stage request: issue nonce then verify new-device private-key possession.
  // This never authorizes the transfer by itself.
  if(input.action==="request_start"){
    const reason=input.reason, platform=input.platform, publicKey=input.public_key;
    if(!["broken","sold","lost","upgrade"].includes(String(reason))||
       !["android","ios","windows"].includes(String(platform))||
       typeof publicKey!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(publicKey))
      return answer(origin,400,{error:"invalid_request"});
    let decoded:Uint8Array;
    try{decoded=decode(publicKey);}catch{return answer(origin,400,{error:"invalid_key"});}
    if(decoded.length!==32)return answer(origin,400,{error:"invalid_key"});
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(publicKey))))
      .map(x=>x.toString(16).padStart(2,"0")).join("");
    const nonce=base64url(crypto.getRandomValues(new Uint8Array(32)));
    // Expire stale requests before enforcing one-pending-request uniqueness.
    await db.from("device_transfer_requests").update({state:"expired",decided_at:new Date().toISOString()})
      .eq("account_id",account.id).eq("state","pending").lt("expires_at",new Date().toISOString());
    const {data,error}=await db.from("device_transfer_requests").insert({
      account_id:account.id,auth_user_id:user.id,new_public_key:publicKey,
      new_key_fingerprint:fingerprint,platform,reason,nonce,
      expires_at:new Date(Date.now()+10*60_000).toISOString()
    }).select("id,nonce,expires_at").single();
    if(error){
      if(error.code==="23505")return answer(origin,409,{error:"pending_request_exists"});
      console.error("device_transfer_request_start",error.code);
      return answer(origin,503,{error:"database_unavailable"});
    }
    return answer(origin,201,{request_id:data.id,nonce:data.nonce,expires_at:data.expires_at});
  }
  if(input.action==="request_finish"){
    const requestId=input.request_id, signature=input.signature;
    if(typeof requestId!=="string"||!uuid.test(requestId)||typeof signature!=="string")
      return answer(origin,400,{error:"invalid_request"});
    const {data:transfer,error}=await db.from("device_transfer_requests")
      .select("id,nonce,new_public_key,state,account_id,auth_user_id,expires_at")
      .eq("id",requestId).eq("account_id",account.id).eq("auth_user_id",user.id).maybeSingle();
    if(error)return answer(origin,503,{error:"database_unavailable"});
    if(!transfer||transfer.state!=="pending"||new Date(transfer.expires_at).getTime()<Date.now())
      return answer(origin,400,{error:"invalid_request_state"});
    try {
      const raw=decode(transfer.new_public_key), sig=decode(signature);
      if(raw.length!==32||sig.length!==64)throw Error("invalid_signature");
      const key=await crypto.subtle.importKey("raw",raw,{name:"Ed25519"},false,["verify"]);
      const payload="zurvan-transfer-v2:"+transfer.id+":"+transfer.nonce+":"+user.id;
      if(!await crypto.subtle.verify({name:"Ed25519"},key,sig,new TextEncoder().encode(payload)))
        return answer(origin,403,{error:"signature_rejected"});
    }catch{return answer(origin,403,{error:"signature_rejected"});}
    const {data:marked,error:markError}=await db.from("device_transfer_requests")
      .update({proof_verified_at:new Date().toISOString()}).eq("id",transfer.id)
      .eq("account_id",account.id).eq("auth_user_id",user.id)
      .eq("state","pending").is("proof_verified_at",null).gt("expires_at",new Date().toISOString())
      .select("id").maybeSingle();
    if(markError)return answer(origin,503,{error:"database_unavailable"});
    if(!marked)return answer(origin,409,{error:"request_already_verified_or_expired"});
    // A signed request is still NOT approved. The support operator must inspect it
    // and perform independent step-up verification before SQL approval.
    return answer(origin,202,{request_id:transfer.id,state:"pending",requires_support_review:true});
  }
  return answer(origin,400,{error:"invalid_action"});
});
