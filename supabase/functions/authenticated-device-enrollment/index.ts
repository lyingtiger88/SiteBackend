import {createClient} from "npm:@supabase/supabase-js@2";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME=/^[a-z][a-z0-9_]{3,23}$/;
const B64=/^[A-Za-z0-9_-]{43}$/;
const answer=(status:number,body:unknown)=>new Response(JSON.stringify(body),{
 status,headers:{"content-type":"application/json","cache-control":"no-store"}
});
function decode(str:string):Uint8Array{
 if(!/^[A-Za-z0-9_-]+$/.test(str))throw Error("encoding");
 const base=str.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(str.length/4)*4,"=");
 return Uint8Array.from(atob(base),v=>v.charCodeAt(0));
}
function encode(bytes:Uint8Array):string{
 return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
Deno.serve(async req=>{
 if(req.method!=="POST")return answer(405,{error:"method_not_allowed"});
 const url=Deno.env.get("SUPABASE_URL"),secret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!secret)return answer(503,{error:"service_unavailable"});
 const jwt=req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
 if(!jwt)return answer(401,{error:"unauthorized"});
 const db=createClient(url,secret,{auth:{persistSession:false}});
 const {data:identity,error:identityError}=await db.auth.getUser(jwt);
 const user=identity?.user;
 if(identityError||!user||!user.email_confirmed_at)return answer(401,{error:"email_not_verified"});
 let data:Record<string,unknown>;
 try{
   const raw=await req.text();
   if(raw.length>2048)return answer(413,{error:"payload_too_large"});
   data=JSON.parse(raw);
   if(!data||typeof data!=="object"||Array.isArray(data))throw Error("body");
 }catch{return answer(400,{error:"invalid_json"});}
 const action=data.action;
 if(action==="start"){
   const username=data.username,publicKey=data.public_key,platform=data.platform;
   if(typeof username!=="string"||!USERNAME.test(username)||typeof publicKey!=="string"||
      !B64.test(publicKey)||!["android","ios","windows"].includes(String(platform)))return answer(400,{error:"invalid_request"});
   try{if(decode(publicKey).length!==32)return answer(400,{error:"invalid_key"});}
   catch{return answer(400,{error:"invalid_key"});}
   const {data:existing,error:ae}=await db.from("accounts").select("id,state")
     .eq("auth_user_id",user.id).maybeSingle();
   if(ae)return answer(503,{error:"storage_unavailable"});
   if(existing)return answer(409,{error:"account_already_linked"});
   const since=new Date(Date.now()-60*60_000).toISOString();
   const {count,error:ce}=await db.from("authenticated_device_enrollment_challenges")
     .select("id",{count:"exact",head:true}).eq("auth_user_id",user.id).gte("created_at",since);
   if(ce)return answer(503,{error:"storage_unavailable"});
   if((count??0)>=5)return answer(429,{error:"try_again_later"});
   const nonce=encode(crypto.getRandomValues(new Uint8Array(32)));
   const {data:ch,error:ie}=await db.from("authenticated_device_enrollment_challenges")
     .insert({auth_user_id:user.id,username,public_key:publicKey,platform,nonce,
       expires_at:new Date(Date.now()+5*60_000).toISOString()})
     .select("id,nonce,expires_at").single();
   if(ie)return answer(503,{error:"storage_unavailable"});
   return answer(201,{challenge_id:ch.id,nonce:ch.nonce,expires_at:ch.expires_at,user_id:user.id});
 }
 if(action==="finish"){
   const id=data.challenge_id,signature=data.signature;
   if(typeof id!=="string"||!UUID.test(id)||typeof signature!=="string")return answer(400,{error:"invalid_request"});
   let sig:Uint8Array;
   try{sig=decode(signature);if(sig.length!==64)throw Error("length");}
   catch{return answer(400,{error:"invalid_signature"});}
   const {data:ch,error:ce}=await db.from("authenticated_device_enrollment_challenges")
     .select("id,auth_user_id,username,public_key,nonce,expires_at,consumed_at")
     .eq("id",id).eq("auth_user_id",user.id).maybeSingle();
   if(ce)return answer(503,{error:"storage_unavailable"});
   if(!ch||ch.consumed_at||new Date(ch.expires_at).getTime()<=Date.now())return answer(400,{error:"invalid_challenge"});
   try{
     const publicKey=await crypto.subtle.importKey("raw",decode(ch.public_key),{name:"Ed25519"},false,["verify"]);
     const payload="zurvan-auth-device-enrollment-v1:"+ch.id+":"+ch.nonce+":"+user.id+":"+ch.username;
     const verified=await crypto.subtle.verify({name:"Ed25519"},publicKey,sig,new TextEncoder().encode(payload));
     if(!verified)return answer(403,{error:"signature_rejected"});
   }catch{return answer(403,{error:"signature_rejected"});}
   const {data:record,error:writeError}=await db.rpc("complete_authenticated_device_enrollment",{
     p_challenge_id:id,p_auth_user_id:user.id
   });
   if(writeError){
     if(writeError.code==="23505")return answer(409,{error:"account_or_key_already_registered"});
     if(writeError.code==="22023"||writeError.code==="42501")return answer(403,{error:"registration_rejected"});
     console.error("complete authenticated enrollment",writeError.code);
     return answer(503,{error:"registration_unavailable"});
   }
   return answer(200,record);
 }
 return answer(400,{error:"invalid_action"});
});
