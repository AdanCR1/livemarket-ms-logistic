import { ApiError } from '../lib/errors.js';
export async function assertStoreCanSell(storeId:string, env:{MS6_URL?:string; PAYMENTS_INTERNAL_KEY?:string}) {
 if(!env.MS6_URL||!env.PAYMENTS_INTERNAL_KEY)
  throw new ApiError(503,'PLAN_NOT_CONFIGURED','Servicio de planes no configurado');
 let r:Response;
 try {r=await fetch(`${env.MS6_URL.replace(/\/+$/,'')}/api/internal/store-plan/${encodeURIComponent(storeId)}`,{
  headers:{'X-Internal-Key':env.PAYMENTS_INTERNAL_KEY},signal:AbortSignal.timeout(6000)
 });}catch{throw new ApiError(503,'PLAN_UNAVAILABLE','No se pudo consultar la suscripción');}
 if(!r.ok){console.warn('[MS4 plan.service] MS6 devolvió HTTP',r.status);throw new ApiError(503,'PLAN_UNAVAILABLE','MS6 no confirmó la suscripción');}
 const v:any=await r.json().catch(()=>null);
 if(v?.success!==true||typeof v?.data?.can_accept_orders!=='boolean')
  throw new ApiError(503,'PLAN_INVALID_RESPONSE','Respuesta inválida de MS6');
 if(!v.data.can_accept_orders)throw new ApiError(403,'PLAN_REQUIRED','Tienda sin acceso a compras PRO');
}
