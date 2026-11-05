import { createClient } from "npm:@supabase/supabase-js@2";

const html=(title:string,message:string,status=200)=>new Response(
  `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:sans-serif;max-width:560px;margin:12vh auto;padding:24px;text-align:center"><h2>${title}</h2><p>${message}</p><p>می‌توانید به نرم‌افزار زروان بازگردید.</p></body></html>`,
  {status,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}}
);
const env=(key:string)=>Deno.env.get(key)?.trim()??"";
const sandbox=()=>env("ZARINPAL_SANDBOX")==="true";
const apiBase=()=>sandbox()?"https://sandbox.zarinpal.com":"https://payment.zarinpal.com";

Deno.serve(async req=>{
  if(req.method!=="GET")return html("درخواست نامعتبر","روش درخواست پشتیبانی نمی‌شود.",405);
  const url=new URL(req.url);
  const authority=url.searchParams.get("Authority")??"";
  const status=url.searchParams.get("Status")??"";
  if(!authority)return html("پرداخت ناموفق","شناسه تراکنش دریافت نشد.",400);
  if(status!=="OK")return html("پرداخت لغو شد","پرداخت توسط درگاه تأیید نشد.");
  const supabaseUrl=env("SUPABASE_URL"),serviceKey=env("SUPABASE_SERVICE_ROLE_KEY"),merchant=env("ZARINPAL_MERCHANT_ID");
  if(!supabaseUrl||!serviceKey||!merchant)return html("خطای سرور","تنظیمات درگاه کامل نیست.",503);
  const db=createClient(supabaseUrl,serviceKey,{auth:{persistSession:false}});
  const {data:payment,error}=await db.from("zurvan_payments")
    .select("id,order_id,authority,status,zurvan_orders(id,amount_minor,currency,product_id)")
    .eq("provider","zarinpal").eq("authority",authority).maybeSingle();
  if(error||!payment)return html("تراکنش پیدا نشد","این درخواست پرداخت در سامانه ثبت نشده است.",404);
  const order=(payment as any).zurvan_orders;
  if(!order)return html("خطای سفارش","اطلاعات سفارش در دسترس نیست.",409);
  if(payment.status==="verified")return html("پرداخت تأیید شده","خرید شما قبلاً ثبت شده است.");
  if(payment.status!=="pending")return html("پرداخت نامعتبر","وضعیت این سفارش قابل تأیید نیست.",409);
  const stored=Number(order.amount_minor);
  const rialAmount=order.currency==="IRT"?stored*10:stored;
  if(!Number.isSafeInteger(rialAmount))return html("خطای مبلغ","مبلغ سفارش نامعتبر است.",500);

  let verified:any;
  try{
    const response=await fetch(apiBase()+"/pg/v4/payment/verify.json",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({merchant_id:merchant,amount:rialAmount,authority})
    });
    verified=await response.json();
    if(!response.ok||![100,101].includes(verified?.data?.code)||!verified?.data?.ref_id)
      return html("پرداخت تأیید نشد","زرین‌پال تراکنش را تأیید نکرد. در صورت کسر وجه، با پشتیبانی تماس بگیرید.",402);
  }catch{return html("خطای ارتباط","ارتباط با درگاه برای تأیید نهایی برقرار نشد. بعداً وضعیت را بررسی کنید.",502);}

  const refId=String(verified.data.ref_id);
  const {data:result,error:finalizeError}=await db.rpc("zurvan_finalize_zarinpal_payment",{
    p_authority:authority,p_ref_id:refId,p_verified_amount:stored,p_verified_currency:order.currency
  });
  if(finalizeError)return html("پرداخت دریافت شد؛ ثبت نهایی در انتظار است",
    "پرداخت از درگاه تأیید شد اما ثبت مجوز کامل نشد. لطفاً دوباره پرداخت نکنید و با پشتیبانی تماس بگیرید.",503);
  return html("پرداخت موفق","پرداخت تأیید و خرید دائمی زروان در حساب شما ثبت شد.");
});
