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

  // The profile row and license-account row are deliberately separate.
  // accounts.auth_user_id links the profile; zurvan_accounts.id is the Auth UUID
  // referenced by zurvan_licenses.account_id. Never join these by username.
  const {data:account,error:accountError}=await db.from("accounts")
    .select("id,username,state").eq("auth_user_id",user.id).maybeSingle();
  if(accountError)return json(503,{error:"database_unavailable"});
  // Supabase Auth signup does not create a device-bound Zurvan account.
  // A missing link is an onboarding state, never evidence that the user is blocked.
  if(!account)return json(200,{
    account_state:"registration_required",
    license_account_state:"not_linked",
    licenses:[],
    registration_required:true,
    checked_at:new Date().toISOString()
  });
  if(account.state==="provisional")return json(200,{
    account_state:"provisional",
    license_account_state:"not_linked",
    licenses:[],
    registration_required:true,
    checked_at:new Date().toISOString()
  });
  if(account.state!=="active")return json(403,{error:"account_inactive"});
  if(!account.username)return json(409,{error:"account_mapping_missing"});

  const {data:licenseAccount,error:mappingError}=await db.from("zurvan_accounts")
    .select("id,status").eq("id",user.id).maybeSingle();
  if(mappingError)return json(503,{error:"database_unavailable"});
  if(!licenseAccount||licenseAccount.status!=="active")
    return json(200,{account_state:"active",license_account_state:licenseAccount?.status??"not_found",licenses:[]});

  const {data:licenses,error:licenseError}=await db.from("zurvan_licenses")
    .select("id,product_id,type,status,generation,created_at,expires_at")
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
  const now=Date.now();
  const effectiveLicenses=(licenses??[]).map(license=>{
    const expired=license.expires_at!==null &&
      license.expires_at!==undefined &&
      new Date(license.expires_at).getTime()<=now;
    return {...license,status:expired?"expired":license.status};
  });
  return json(200,{account_state:"active",license_account_state:"active",licenses:effectiveLicenses,activations,
    checked_at:new Date().toISOString()});
});
