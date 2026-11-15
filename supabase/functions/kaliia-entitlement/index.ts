import { createClient } from "npm:@supabase/supabase-js@2";
const ORIGINS=new Set(["https://kaliia.ir","https://www.kaliia.ir","http://localhost:8085","http://127.0.0.1:8085"]);
const PRODUCTS=new Set(["zurvan","maal","shopmanager","zarr"]);
const json=(status:number,body:unknown,origin:string|null)=>new Response(JSON.stringify(body),{status,headers:{
 "content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff",
 ...(origin&&ORIGINS.has(origin)?{"access-control-allow-origin":origin,"vary":"Origin"}:{})
}});
Deno.serve(async req=>{
 const origin=req.headers.get("origin");
 if(req.method==="OPTIONS")return new Response(null,{status:origin&&ORIGINS.has(origin)?204:403,headers:{
  ...(origin&&ORIGINS.has(origin)?{"access-control-allow-origin":origin,"vary":"Origin"}:{}),
  "access-control-allow-methods":"POST, OPTIONS","access-control-allow-headers":"authorization, content-type, apikey"
 }});
 if(origin&&!ORIGINS.has(origin))return json(403,{error:"origin_not_allowed"},origin);
 if(req.method!=="POST")return json(405,{error:"method_not_allowed"},origin);
 const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!key)return json(503,{error:"service_unavailable"},origin);
 const token=req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
 if(!token)return json(401,{error:"sign_in_required"},origin);
 const db=createClient(url,key,{auth:{persistSession:false}});
 const {data:auth,error:authError}=await db.auth.getUser(token),user=auth?.user;
 if(authError||!user||!user.email_confirmed_at||!user.email)return json(401,{error:"confirmed_account_required"},origin);
 let body:Record<string,unknown>;
 try{body=await req.json();if(!body||Array.isArray(body)||typeof body!=="object")throw Error()}catch{return json(400,{error:"invalid_json"},origin)}
 const product=String(body.product_id??"");
 if(!PRODUCTS.has(product))return json(400,{error:"invalid_product"},origin);
 try{
  if(body.action==="start_trial"){
   const {data,error}=await db.rpc("kaliia_start_trial",{
    p_auth_user_id:user.id,p_product_id:product,p_recovery_email:user.email
   });
   if(error)throw error;
   return json(200,{entitlement:data,checked_at:new Date().toISOString()},origin);
  }
  if(body.action==="status"){
   const {data,error}=await db.from("zurvan_licenses")
    .select("id,product_id,type,status,generation,created_at,expires_at")
    .eq("account_id",user.id).eq("product_id",product).maybeSingle();
   if(error)throw error;
   if(!data)return json(200,{entitlement:{product_id:product,status:"trial_available",can_write:false,trial_available:true,days_remaining:0},checked_at:new Date().toISOString()},origin);
   const expired=data.status==="active"&&data.expires_at!==null&&new Date(data.expires_at).getTime()<=Date.now();
   const status=expired?"expired":data.status;
   const remaining=data.expires_at?Math.max(0,Math.ceil((new Date(data.expires_at).getTime()-Date.now())/86400000)):null;
   return json(200,{entitlement:{...data,status,can_write:status==="active",trial_available:false,days_remaining:remaining},checked_at:new Date().toISOString()},origin);
  }
  return json(400,{error:"unknown_action"},origin);
 }catch(error){
  const message=error instanceof Error?error.message:"request_failed";
  if(message.includes("account_not_registered"))return json(403,{error:"account_not_registered"},origin);
  if(message.includes("license_account_inactive"))return json(403,{error:"license_account_inactive"},origin);
  if(message.includes("product_unavailable"))return json(404,{error:"product_unavailable"},origin);
  return json(503,{error:"entitlement_service_unavailable"},origin);
 }
});