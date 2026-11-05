import { createClient } from "npm:@supabase/supabase-js@2";
const origins=new Set(["http://localhost:8085","http://127.0.0.1:8085"]);
const headers=(o:string|null)=>o&&origins.has(o)?{"access-control-allow-origin":o,"access-control-allow-headers":"authorization, apikey, content-type","access-control-allow-methods":"POST, OPTIONS",vary:"Origin"}:{};
const reply=(o:string|null,s:number,b:unknown)=>new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json","cache-control":"no-store",...headers(o)}});
Deno.serve(async req=>{
 const origin=req.headers.get("origin");
 if(req.method==="OPTIONS")return new Response(null,{status:origin&&origins.has(origin)?204:403,headers:headers(origin)});
 if(req.method!=="POST")return reply(origin,405,{error:"method_not_allowed"});
 const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!key)return reply(origin,503,{error:"not_configured"});
 const token=req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
 if(!token)return reply(origin,401,{error:"unauthorized"});
 const db=createClient(url,key,{auth:{persistSession:false}});
 const {data:ud,error:ue}=await db.auth.getUser(token),user=ud?.user;
 if(ue||!user||!user.email_confirmed_at)return reply(origin,401,{error:"unauthorized"});
 const {data:admin,error:ae}=await db.from("zurvan_admin_users").select("role").eq("auth_user_id",user.id).eq("active",true).maybeSingle();
 if(ae)return reply(origin,503,{error:"database_unavailable"});
 if(!admin)return reply(origin,403,{error:"admin_required"});
 let body:Record<string,unknown>;
 try{const raw=await req.text();if(raw.length>4096)throw Error();body=JSON.parse(raw);if(!body||typeof body!=="object"||Array.isArray(body))throw Error();}catch{return reply(origin,400,{error:"invalid_request"});}
 if(body.action==="list"){
  const {data,error}=await db.from("device_transfer_requests")
   .select("id,account_id,auth_user_id,platform,reason,state,created_at,proof_verified_at,review_expires_at,new_key_fingerprint")
   .eq("state","pending").not("proof_verified_at","is",null).gt("review_expires_at",new Date().toISOString()).order("created_at",{ascending:true}).limit(100);
  if(error)return reply(origin,503,{error:"database_unavailable"});
  return reply(origin,200,{requests:data});
 }
 if(body.action==="review"){
  if(typeof body.request_id!=="string"||!/^[0-9a-f-]{36}$/i.test(body.request_id)||!["approve","reject"].includes(String(body.decision))||typeof body.reason!=="string"||body.reason.trim().length<8||body.reason.length>1000)
   return reply(origin,400,{error:"invalid_review"});
  const {data,error}=await db.rpc("admin_review_device_transfer",{p_request_id:body.request_id,p_operator:user.id,p_decision:body.decision,p_reason:body.reason.trim()});
  if(error){console.error("admin_transfer_review",error.code);return reply(origin,error.code==="42501"?403:409,{error:"review_failed",code:error.code});}
  return reply(origin,200,data);
 }
 return reply(origin,400,{error:"invalid_action"});
});
