import { createClient } from "npm:@supabase/supabase-js@2";

const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{
  status,headers:{"content-type":"application/json","cache-control":"no-store"}
});
const env=(key:string)=>Deno.env.get(key)?.trim()??"";
const sandbox=()=>env("ZARINPAL_SANDBOX")==="true";
const apiBase=()=>sandbox()?"https://sandbox.zarinpal.com":"https://payment.zarinpal.com";
const startBase=()=>sandbox()?"https://sandbox.zarinpal.com/pg/StartPay/":"https://www.zarinpal.com/pg/StartPay/";

Deno.serve(async req=>{
  if(req.method!=="POST")return json(405,{error:"method_not_allowed"});
  const supabaseUrl=env("SUPABASE_URL"),serviceKey=env("SUPABASE_SERVICE_ROLE_KEY");
  const merchant=env("ZARINPAL_MERCHANT_ID"),callback=env("ZARINPAL_CALLBACK_URL");
  if(!supabaseUrl||!serviceKey||!merchant||!callback)return json(503,{error:"payment_not_configured"});
  const token=req.headers.get("authorization")?.match(/^Bearer (\\S+)$/i)?.[1];
  if(!token)return json(401,{error:"unauthorized"});
  const db=createClient(supabaseUrl,serviceKey,{auth:{persistSession:false}});
  const {data:{user},error:authError}=await db.auth.getUser(token);
  if(authError||!user||!user.email_confirmed_at)return json(401,{error:"email_not_verified"});
  let body:{price_id?:string};
  try{body=await req.json()}catch{return json(400,{error:"invalid_json"});}
  if(!body.price_id)return json(400,{error:"price_id_required"});

  const {data:price,error:priceError}=await db.from("zurvan_prices")
    .select("id,product_id,currency,amount_minor,provider")
    .eq("id",body.price_id).eq("product_id","zurvan").eq("region","IR")
    .eq("provider","zarinpal").eq("enabled",true).maybeSingle();
  if(priceError)return json(503,{error:"pricing_unavailable"});
  if(!price)return json(404,{error:"price_not_available"});
  if(!["IRT","IRR"].includes(price.currency))return json(400,{error:"unsupported_currency"});
  const storedAmount=Number(price.amount_minor);
  if(!Number.isSafeInteger(storedAmount)||storedAmount<=0)return json(500,{error:"invalid_price_configuration"});
  const rialAmount=price.currency==="IRT"?storedAmount*10:storedAmount;
  if(!Number.isSafeInteger(rialAmount)||rialAmount<1000)return json(400,{error:"invalid_gateway_amount"});

  // Ensure an account row exists for a newly signed-up, email-verified user.
  const {error:accountError}=await db.from("zurvan_accounts").upsert({
    id:user.id,status:"provisional"
  },{onConflict:"id",ignoreDuplicates:true});
  if(accountError)return json(503,{error:"account_unavailable"});
  const {data:existing,error:existingError}=await db.from("zurvan_licenses")
    .select("id").eq("account_id",user.id).eq("product_id","zurvan").eq("status","active").maybeSingle();
  if(existingError)return json(503,{error:"license_lookup_failed"});
  if(existing)return json(409,{error:"lifetime_license_already_owned"});

  const {data:order,error:orderError}=await db.from("zurvan_orders").insert({
    account_id:user.id,product_id:"zurvan",price_id:price.id,
    amount_minor:storedAmount,currency:price.currency,status:"pending"
  }).select("id").single();
  if(orderError||!order)return json(503,{error:"order_creation_failed"});
  const {data:payment,error:paymentError}=await db.from("zurvan_payments").insert({
    order_id:order.id,provider:"zarinpal",status:"pending"
  }).select("id").single();
  if(paymentError||!payment)return json(503,{error:"payment_creation_failed"});

  const requestBody={
    merchant_id:merchant,amount:rialAmount,callback_url:callback,
    description:"خرید دائمی نرم‌افزار زروان",
    metadata:{email:user.email??"",order_id:order.id}
  };
  let gateway: any;
  try{
    const response=await fetch(apiBase()+"/pg/v4/payment/request.json",{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(requestBody)
    });
    gateway=await response.json();
    if(!response.ok||gateway?.data?.code!==100||!gateway?.data?.authority)
      throw new Error("gateway_request_rejected");
  }catch{
    await db.from("zurvan_payments").update({status:"failed"}).eq("id",payment.id);
    await db.from("zurvan_orders").update({status:"failed"}).eq("id",order.id);
    return json(502,{error:"gateway_request_failed"});
  }
  const {error:updateError}=await db.from("zurvan_payments")
    .update({authority:gateway.data.authority}).eq("id",payment.id);
  if(updateError)return json(503,{error:"payment_record_update_failed"});
  return json(200,{order_id:order.id,payment_url:startBase()+gateway.data.authority});
});
