import { createClient } from "npm:@supabase/supabase-js@2";

const ORIGINS = new Set([
  "https://kaliia.ir", "https://www.kaliia.ir",
  "http://localhost:8085", "http://127.0.0.1:8085"
]);
const BUCKET = "zurvan-payment-receipts";
const MAX_FILE = 5 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (status: number, value: unknown, origin: string | null) =>
  new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json", "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(origin && ORIGINS.has(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {})
  }});
const fail = (code: string, origin: string | null, status=400) => reply(status, {error:code}, origin);

function receiptBytes(encoded: unknown): {bytes: Uint8Array, mime: string, ext: string} {
  if (typeof encoded !== "string" || encoded.length > 7_100_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw Error("invalid_receipt");
  const binary = atob(encoded);
  if (binary.length < 64 || binary.length > MAX_FILE) throw Error("invalid_receipt_size");
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const png = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x);
  const jpg = bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff;
  const pdf = bytes[0]===37 && bytes[1]===80 && bytes[2]===68 && bytes[3]===70 && bytes[4]===45;
  if (png) return {bytes,mime:"image/png",ext:"png"};
  if (jpg) return {bytes,mime:"image/jpeg",ext:"jpg"};
  if (pdf) return {bytes,mime:"application/pdf",ext:"pdf"};
  throw Error("unsupported_receipt_type");
}

Deno.serve(async req => {
  const origin = req.headers.get("origin");
  if (req.method==="OPTIONS") return new Response(null, {
    status: origin && ORIGINS.has(origin) ? 204 : 403,
    headers: {
      ...(origin && ORIGINS.has(origin) ? {"access-control-allow-origin":origin,"vary":"Origin"} : {}),
      "access-control-allow-methods":"POST, OPTIONS",
      "access-control-allow-headers":"authorization, content-type, apikey"
    }
  });
  if (origin && !ORIGINS.has(origin)) return fail("origin_not_allowed",origin,403);
  if (req.method!=="POST") return fail("method_not_allowed",origin,405);
  const url=Deno.env.get("SUPABASE_URL"), key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return fail("service_unavailable",origin,503);
  const token=req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return fail("sign_in_required",origin,401);
  const db=createClient(url,key,{auth:{persistSession:false}});
  const {data:identity,error:authError}=await db.auth.getUser(token);
  const user=identity?.user;
  if (authError || !user || !user.email || !user.email_confirmed_at)
    return fail("confirmed_account_required",origin,401);
  let body: Record<string,unknown>;
  try {
    const raw=await req.text();
    if(raw.length>7_200_000)return fail("payload_too_large",origin,413);
    body=JSON.parse(raw);
    if(!body || Array.isArray(body) || typeof body!=="object") throw Error("body");
  } catch {return fail("invalid_json",origin);}
  const action=body.action;
  if (typeof action!=="string") return fail("action_required",origin);
  const isAdmin=async()=>{
    const {data,error}=await db.from("zurvan_admin_users")
      .select("role").eq("auth_user_id",user.id).eq("active",true).maybeSingle();
    if(error)throw Error("admin_lookup_failed");
    return data?.role==="superadmin";
  };

  try {
    if(action==="init"){
      // Email verification is required. Preserve existing device-enrollment accounts.
      const {data:legacy,error:legacyError}=await db.from("accounts")
        .select("id,state").eq("auth_user_id",user.id).maybeSingle();
      if(legacyError) return fail("account_unavailable",origin,503);
      if(!legacy){
        const {error}=await db.from("accounts").insert({
          auth_user_id:user.id, state:"active", recovery_email:user.email,
          recovery_verified_at:new Date().toISOString()
        });
        if(error && error.code!=="23505") return fail("account_registration_failed",origin,503);
      } else if(legacy.state!=="active") return fail("registration_required",origin,403);
      const {data:licenseAccount,error:accountError}=await db.from("zurvan_accounts")
        .select("id,status").eq("id",user.id).maybeSingle();
      if(accountError)return fail("license_lookup_failed",origin,503);
      if(!licenseAccount){
        const {error}=await db.from("zurvan_accounts").insert({
          id:user.id, status:"active", recovery_email:user.email,
          recovery_verified_at:new Date().toISOString()
        });
        if(error && error.code!=="23505")return fail("license_account_setup_failed",origin,503);
      }else if(licenseAccount.status!=="active")return fail("account_inactive",origin,403);
      const {data:trial,error:trialError}=await db.rpc("zurvan_start_trial",{
        p_auth_user_id:user.id,p_key_fingerprint:null
      });
      if(trialError)return fail("trial_setup_unavailable",origin,503);
      return reply(200,{initialized:true,trial},origin);
    }
    if(action==="catalog"){
      const {data:products,error:productError}=await db.from("zurvan_products")
        .select("id,name,sales_enabled,enabled").eq("enabled",true).order("id");
      if(productError)return fail("catalog_unavailable",origin,503);
      const {data:plans,error:planError}=await db.from("kaliia_store_plans")
        .select("product_id,months,amount_minor,currency,enabled")
        .eq("enabled",true).order("months");
      if(planError)return fail("catalog_unavailable",origin,503);
      return reply(200,{products:(products??[]).map(p=>({
        ...p,plans:p.sales_enabled?(plans??[]).filter(x=>x.product_id===p.id):[]
      }))},origin);
    }
    if(action==="config"){
      const {data,error}=await db.from("zurvan_manual_payment_config")
        .select("merchant_card,merchant_name").eq("singleton",true).single();
      if(error)return fail("configuration_unavailable",origin,503);
      return reply(200,{
        merchant_card:data.merchant_card,
        merchant_name:data.merchant_name,
        ready:!!(data.merchant_card && data.merchant_name)
      },origin);
    }
    if(action==="mine"){
      const {data,error}=await db.from("zurvan_manual_payments")
        .select("id,status,product_id,plan_code,duration_months,amount_minor,currency,bank_reference,submitted_at,reviewed_at,admin_note")
        .eq("auth_user_id",user.id).order("submitted_at",{ascending:false}).limit(10);
      if(error)return fail("requests_unavailable",origin,503);
      return reply(200,{requests:data??[]},origin);
    }
    if(action==="submit"){
      const productId=typeof body.product_id==="string"?body.product_id.trim():"";
      const months=Number(body.months);
      if(!/^[a-z][a-z0-9-]{1,50}$/.test(productId)||
        ![1,3,6,12].includes(months))return fail("invalid_product_plan",origin);
      const {data:saleProduct,error:saleError}=await db.from("zurvan_products")
        .select("id").eq("id",productId).eq("enabled",true)
        .eq("sales_enabled",true).maybeSingle();
      if(saleError||!saleProduct)return fail("product_not_for_sale",origin);
      const {data:price,error:priceError}=await db.from("kaliia_store_plans")
        .select("amount_minor,currency,enabled").eq("product_id",productId)
        .eq("months",months).eq("enabled",true).maybeSingle();
      if(priceError||!price||!price.amount_minor||price.amount_minor<=0)
        return fail("plan_not_configured",origin,409);
      const reference=typeof body.bank_reference==="string"?body.bank_reference.trim():"";
      if(reference.length>80)return fail("invalid_bank_reference",origin);
      const full_name=typeof body.full_name==="string" ? body.full_name.trim() : "";
      const phone=typeof body.phone==="string" ? body.phone.trim().replace(/[\s()-]/g,"") : "";
      if(full_name.length<3 || full_name.length>120 || !/^\+?[0-9]{9,15}$/.test(phone))
        return fail("invalid_contact_information",origin);
      const {data:configured,error:configError}=await db.from("zurvan_manual_payment_config")
        .select("merchant_card,merchant_name").eq("singleton",true).single();
      if(configError || !configured?.merchant_card || !configured?.merchant_name)
        return fail("payment_not_configured",origin,503);
      const {data:account,error:accountError}=await db.from("zurvan_accounts")
        .select("id,status").eq("id",user.id).maybeSingle();
      if(accountError || account?.status!=="active")return fail("account_not_ready",origin,403);
      const {data:pending,error:pendingError}=await db.from("zurvan_manual_payments")
        .select("id").eq("auth_user_id",user.id).eq("status","pending").limit(1);
      if(pendingError)return fail("request_unavailable",origin,503);
      if(pending?.length)return fail("pending_request_exists",origin,409);
      let file: ReturnType<typeof receiptBytes>;
      try {file=receiptBytes(body.receipt_base64);} catch(e){
        return fail(e instanceof Error ? e.message:"invalid_receipt",origin);
      }
      const {data:bucket,error:bucketError}=await db.storage.getBucket(BUCKET);
      if(bucketError && !bucket){
        const {error:createError}=await db.storage.createBucket(BUCKET,{
          public:false,fileSizeLimit:MAX_FILE,
          allowedMimeTypes:["image/jpeg","image/png","application/pdf"]
        });
        if(createError && !/already exists|duplicate/i.test(createError.message))
          return fail("receipt_storage_unavailable",origin,503);
      }
      const id=crypto.randomUUID(), path=user.id+"/"+id+"."+file.ext;
      const {error:uploadError}=await db.storage.from(BUCKET).upload(path,file.bytes,{
        contentType:file.mime,upsert:false,cacheControl:"0"
      });
      if(uploadError)return fail("receipt_upload_failed",origin,503);
      const {error:insertError}=await db.from("zurvan_manual_payments").insert({
        id,auth_user_id:user.id,full_name,contact_email:user.email,
        phone,receipt_path:path,receipt_mime:file.mime,receipt_size:file.bytes.length,
        product_id:productId,plan_code:String(months)+"m",duration_months:months,
        amount_minor:price.amount_minor,currency:price.currency,
        bank_reference:reference||null
      });
      if(insertError){
        await db.storage.from(BUCKET).remove([path]);
        if(insertError.code==="23505")return fail("pending_request_exists",origin,409);
        return fail("request_save_failed",origin,503);
      }
      return reply(201,{id,status:"pending",product_id:productId,months,amount_minor:price.amount_minor,currency:price.currency,message:"submitted_for_review"},origin);
    }

    if(!(await isAdmin()))return fail("admin_required",origin,403);

    if(action==="admin_list"){
      const {data,error}=await db.from("zurvan_manual_payments")
        .select("id,auth_user_id,full_name,contact_email,phone,status,product_id,plan_code,duration_months,amount_minor,currency,bank_reference,submitted_at,reviewed_at,admin_note,receipt_mime,receipt_size")
        .order("submitted_at",{ascending:false}).limit(100);
      if(error)return fail("list_unavailable",origin,503);
      return reply(200,{requests:data??[]},origin);
    }
    if(action==="admin_receipt"){
      if(typeof body.id!=="string" || !uuid.test(body.id))return fail("invalid_request",origin);
      const {data,error}=await db.from("zurvan_manual_payments")
        .select("receipt_path").eq("id",body.id).single();
      if(error || !data)return fail("request_missing",origin,404);
      const {data:urlData,error:urlError}=await db.storage.from(BUCKET)
        .createSignedUrl(data.receipt_path,120);
      if(urlError)return fail("receipt_unavailable",origin,503);
      return reply(200,{url:urlData.signedUrl,expires_in:120},origin);
    }
    if(action==="admin_review"){
      if(typeof body.id!=="string" || !uuid.test(body.id) ||
         !["approve","reject"].includes(String(body.decision)))return fail("invalid_review",origin);
      const note=typeof body.note==="string" ? body.note.trim().slice(0,500) : "";
      const {data,error}=await db.rpc("zurvan_manual_review_payment",{
        p_payment_id:body.id,p_admin_id:user.id,
        p_approve:body.decision==="approve",p_note:note
      });
      if(error){
        if(error.message.includes("already_reviewed"))return fail("already_reviewed",origin,409);
        return fail("review_failed",origin,503);
      }
      return reply(200,data,origin);
    }
    if(action==="admin_plans"){
      const {data,error}=await db.from("kaliia_store_plans")
        .select("product_id,months,amount_minor,currency,enabled,updated_at")
        .order("product_id").order("months");
      if(error)return fail("plans_unavailable",origin,503);
      return reply(200,{plans:data??[]},origin);
    }
    if(action==="admin_set_plan"){
      const productId=typeof body.product_id==="string"?body.product_id.trim():"";
      const months=Number(body.months),amount=Number(body.amount_minor);
      const enabled=body.enabled===true;
      const currency=String(body.currency??"IRR");
      if(!/^[a-z][a-z0-9-]{1,50}$/.test(productId)||
         ![1,3,6,12].includes(months)||!Number.isSafeInteger(amount)||
         amount<=0||!["IRR","IRT"].includes(currency))
        return fail("invalid_plan",origin);
      const {data:product,error:productError}=await db.from("zurvan_products")
        .select("id").eq("id",productId).eq("enabled",true)
        .eq("sales_enabled",true).maybeSingle();
      if(productError||!product)return fail("product_not_for_sale",origin,403);
      const {error}=await db.from("kaliia_store_plans").upsert({
        product_id:productId,months,amount_minor:amount,currency,enabled,
        updated_at:new Date().toISOString(),updated_by:user.id
      },{onConflict:"product_id,months"});
      if(error)return fail("plan_save_failed",origin,503);
      return reply(200,{saved:true,product_id:productId,months,enabled},origin);
    }
    if(action==="admin_config"){
      const card=typeof body.merchant_card==="string" ?
        body.merchant_card.replace(/[\s-]/g,"") : "";
      const name=typeof body.merchant_name==="string" ? body.merchant_name.trim():"";
      if(!/^[0-9]{16}$/.test(card) || name.length<3 || name.length>120)
        return fail("invalid_bank_details",origin);
      const {error}=await db.from("zurvan_manual_payment_config").upsert({
        singleton:true,merchant_card:card,merchant_name:name,
        updated_by:user.id,updated_at:new Date().toISOString()
      });
      if(error)return fail("configuration_save_failed",origin,503);
      return reply(200,{saved:true},origin);
    }
    return fail("unknown_action",origin);
  }catch(error){
    console.error("manual payment handler",error instanceof Error ? error.message:"unhandled");
    return fail("temporarily_unavailable",origin,503);
  }
});