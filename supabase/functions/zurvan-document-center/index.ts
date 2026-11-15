import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET="zurvan-document-archive";
const MAX=10*1024*1024;
const MIME_EXT:Record<string,string>={
 "application/pdf":"pdf","image/jpeg":"jpg","image/png":"png",
 "application/vnd.openxmlformats-officedocument.wordprocessingml.document":"docx",
 "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"xlsx",
 "text/plain":"txt","application/zip":"zip"
};
const TYPES=new Set(["identity_attachment","contract","support_attachment","invoice","payment_proof","business_document","other"]);
const ORIGINS=new Set(["https://kaliia.ir","https://www.kaliia.ir","http://localhost:8085","http://127.0.0.1:8085"]);
const json=(status:number,body:unknown,origin:string|null)=>new Response(JSON.stringify(body),{status,headers:{
 "content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff",
 ...(origin&&ORIGINS.has(origin)?{"access-control-allow-origin":origin,"vary":"Origin"}:{})
}});
function decodeFile(value:unknown,mime:unknown){
 if(typeof value!=="string"||typeof mime!=="string"||!(mime in MIME_EXT)||value.length>14_000_000)throw Error("invalid_file");
 const binary=atob(value),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
 if(bytes.length<8||bytes.length>MAX)throw Error("invalid_file_size");
 const starts=(a:number[])=>a.every((v,i)=>bytes[i]===v);
 if(mime==="image/png"&&!starts([137,80,78,71,13,10,26,10]))throw Error("file_signature_mismatch");
 if(mime==="image/jpeg"&&!starts([255,216,255]))throw Error("file_signature_mismatch");
 if(mime==="application/pdf"&&!starts([37,80,68,70,45]))throw Error("file_signature_mismatch");
 if(["application/zip","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(mime)&&!starts([80,75,3,4]))throw Error("file_signature_mismatch");
 return bytes;
}
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
 const {data:auth,error:authError}=await db.auth.getUser(token);
 const user=auth?.user;
 if(authError||!user||!user.email_confirmed_at)return json(401,{error:"confirmed_account_required"},origin);
 let body:Record<string,unknown>;
 try{const raw=await req.text();if(raw.length>14_500_000)return json(413,{error:"payload_too_large"},origin);body=JSON.parse(raw);if(!body||Array.isArray(body)||typeof body!=="object")throw Error();}
 catch{return json(400,{error:"invalid_json"},origin);}
 const isAdmin=async()=>{
  const {data,error}=await db.from("zurvan_admin_users").select("role")
   .eq("auth_user_id",user.id).eq("active",true).maybeSingle();
  if(error)throw Error("admin_check_failed");
  return data?.role==="superadmin";
 };
 try{
  const action=body.action;
  if(action==="upload"){
   const scope=body.document_scope==="admin"?"admin":"customer";
   const admin=scope==="admin"?await isAdmin():false;
   if(scope==="admin"&&!admin)return json(403,{error:"admin_required"},origin);
   const type=String(body.document_type||"other");
   if(!TYPES.has(type))return json(400,{error:"invalid_document_type"},origin);
   const title=typeof body.title==="string"?body.title.trim():"";
   const product=typeof body.product_id==="string"?body.product_id.trim().slice(0,80):null;
   if(title.length<1||title.length>160)return json(400,{error:"invalid_title"},origin);
   let bytes:Uint8Array;
   try{bytes=decodeFile(body.file_base64,body.mime_type);}catch(e){return json(400,{error:e instanceof Error?e.message:"invalid_file"},origin);}
   const id=crypto.randomUUID(),ext=MIME_EXT[String(body.mime_type)];
   const path=(scope==="customer"?user.id:"admin/"+user.id)+"/"+id+"."+ext;
   const {error:uploadError}=await db.storage.from(BUCKET).upload(path,bytes,{contentType:String(body.mime_type),upsert:false,cacheControl:"0"});
   if(uploadError)return json(503,{error:"storage_upload_failed"},origin);
   const {data,error}=await db.from("zurvan_documents").insert({
    id,owner_user_id:scope==="customer"?user.id:user.id,document_scope:scope,document_type:type,
    product_id:product,title,storage_bucket:BUCKET,storage_path:path,mime_type:String(body.mime_type),
    file_size:bytes.length,notes:typeof body.notes==="string"?body.notes.trim().slice(0,1000):null,created_by:user.id
   }).select("id,title,document_type,product_id,file_size,created_at").single();
   if(error){await db.storage.from(BUCKET).remove([path]);return json(503,{error:"metadata_save_failed"},origin);}
   return json(201,{document:data},origin);
  }
  if(action==="mine"){
   const {data,error}=await db.from("zurvan_documents")
    .select("id,title,document_type,product_id,mime_type,file_size,created_at,notes")
    .eq("owner_user_id",user.id).eq("document_scope","customer").is("deleted_at",null)
    .order("created_at",{ascending:false}).limit(100);
   if(error)return json(503,{error:"documents_unavailable"},origin);
   return json(200,{documents:data??[]},origin);
  }
  if(action==="admin_list"){
   if(!(await isAdmin()))return json(403,{error:"admin_required"},origin);
   let query=db.from("zurvan_documents").select("id,owner_user_id,title,document_type,product_id,mime_type,file_size,created_at,notes")
    .is("deleted_at",null).order("created_at",{ascending:false}).limit(200);
   if(typeof body.owner_user_id==="string")query=query.eq("owner_user_id",body.owner_user_id);
   if(typeof body.document_type==="string")query=query.eq("document_type",body.document_type);
   const {data,error}=await query;
   if(error)return json(503,{error:"documents_unavailable"},origin);
   return json(200,{documents:data??[]},origin);
  }
  if(action==="signed_url"){
   const id=typeof body.id==="string"?body.id:"";
   const {data:doc,error}=await db.from("zurvan_documents").select("id,owner_user_id,storage_path,storage_bucket")
    .eq("id",id).is("deleted_at",null).maybeSingle();
   if(error||!doc)return json(404,{error:"document_not_found"},origin);
   const admin=await isAdmin();
   if(doc.owner_user_id!==user.id&&!admin)return json(403,{error:"not_allowed"},origin);
   const {data,error:urlError}=await db.storage.from(doc.storage_bucket).createSignedUrl(doc.storage_path,120);
   if(urlError)return json(503,{error:"signed_url_failed"},origin);
   return json(200,{url:data.signedUrl,expires_in:120},origin);
  }
  if(action==="soft_delete"){
   if(!(await isAdmin()))return json(403,{error:"admin_required"},origin);
   const id=typeof body.id==="string"?body.id:"";
   const {data,error}=await db.from("zurvan_documents").update({deleted_at:new Date().toISOString(),deleted_by:user.id})
    .eq("id",id).is("deleted_at",null).select("id").maybeSingle();
   if(error||!data)return json(404,{error:"document_not_found"},origin);
   return json(200,{deleted:true,id:data.id},origin);
  }
  if(action==="payments_list"){
   if(!(await isAdmin()))return json(403,{error:"admin_required"},origin);
   const {data,error}=await db.from("zurvan_manual_payments")
    .select("id,auth_user_id,full_name,contact_email,phone,status,product_id,plan_code,amount_minor,currency,bank_reference,transfer_at,submitted_at,reviewed_at,admin_note,receipt_mime,receipt_size")
    .order("submitted_at",{ascending:false}).limit(200);
   if(error)return json(503,{error:"payments_unavailable"},origin);
   return json(200,{payments:data??[]},origin);
  }
  if(action==="payment_receipt_url"){
   if(!(await isAdmin()))return json(403,{error:"admin_required"},origin);
   const paymentId=typeof body.payment_id==="string"?body.payment_id:"";
   const {data:payment,error}=await db.from("zurvan_manual_payments").select("receipt_path")
    .eq("id",paymentId).maybeSingle();
   if(error||!payment)return json(404,{error:"payment_not_found"},origin);
   const {data,error:urlError}=await db.storage.from("zurvan-payment-receipts").createSignedUrl(payment.receipt_path,120);
   if(urlError)return json(503,{error:"receipt_url_failed"},origin);
   return json(200,{url:data.signedUrl,expires_in:120},origin);
  }
  return json(400,{error:"unknown_action"},origin);
 }catch(e){
  console.error("document-center",e instanceof Error?e.message:"unhandled");
  return json(503,{error:"temporarily_unavailable"},origin);
 }
});