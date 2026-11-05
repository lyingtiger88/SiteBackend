import { createClient } from "npm:@supabase/supabase-js@2";

const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{
  status,headers:{"content-type":"application/json","cache-control":"no-store"}
});

Deno.serve(async req=>{
  if(req.method!=="POST")return json(405,{error:"method_not_allowed"});
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)return json(503,{error:"not_configured"});
  const token=req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if(!token)return json(401,{error:"unauthorized"});
  const db=createClient(url,key,{auth:{persistSession:false}});
  const {data:authData,error:authError}=await db.auth.getUser(token);
  const user=authData?.user;
  if(authError||!user||!user.email_confirmed_at)return json(401,{error:"unauthorized"});

  // The enrollment account is keyed by auth_user_id. The legacy license account
  // is matched through the established username; never assume UUIDs are equal.
  const {data:account,error:accountError}=await db.from("accounts")
    .select("id,username,state").eq("auth_user_id",user.id).maybeSingle();
  if(accountError)return json(503,{error:"database_unavailable"});
  if(!account||account.state!=="active")return json(403,{error:"account_inactive"});
  if(!account.username)return json(409,{error:"account_mapping_missing"});

  const {data:licenseAccount,error:mappingError}=await db.from("zurvan_accounts")
    .select("id,status").eq("username",account.username).maybeSingle();
  if(mappingError)return json(503,{error:"database_unavailable"});
  if(!licenseAccount||licenseAccount.status!=="active")
    return json(200,{account_state:"active",license_account_state:licenseAccount?.status??"not_found",licenses:[]});

  const {data:licenses,error:licenseError}=await db.from("zurvan_licenses")
    .select("id,product_id,type,status,generation,created_at")
    .eq("account_id",licenseAccount.id).order("created_at",{ascending:false}).limit(50);
  if(licenseError)return json(503,{error:"database_unavailable"});

  const licenseIds=(licenses??[]).map(x=>x.id);
  let activations:unknown[]=[];
  if(licenseIds.length){
    const {data,error}=await db.from("zurvan_activations")
      .select("id,license_id,device_id,activated_at,revoked_at,zurvan_devices(platform,key_fingerprint,label)")
      .in("license_id",licenseIds).is("revoked_at",null);
    if(error)return json(503,{error:"database_unavailable"});
    activations=data??[];
  }
  return json(200,{account_state:"active",license_account_state:"active",licenses,activations,
    checked_at:new Date().toISOString()});
});
