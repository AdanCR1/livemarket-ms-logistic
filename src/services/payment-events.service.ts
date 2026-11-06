import { db } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';
import { inventoryStatus,commitInventory,type InventoryEnv } from './inventory.service.js';
type Event={event_id:string;order_id:string;payment_id:string;status:'PAID'|'FAILED';amount:string;currency:string};
type Env=InventoryEnv&{MS6_URL?:string;PAYMENTS_INTERNAL_KEY?:string};
export async function handlePaymentEvent(body:Event,env:Env){
 if(body.status!=='PAID')throw new ApiError(409,'PAYMENT_EVENT_REJECTED','Solo confirmaciones verificadas');
 if(!env.MS6_URL||!env.PAYMENTS_INTERNAL_KEY)throw new ApiError(503,'PAYMENT_PROOF_UNAVAILABLE','MS6 no configurado');
 let response:Response;
 try {response=await fetch(env.MS6_URL.replace(/\/+$/,'')+'/api/internal/payments/'+encodeURIComponent(body.payment_id)+'/proof',{
  headers:{'X-Internal-Key':env.PAYMENTS_INTERNAL_KEY},redirect:'manual',signal:AbortSignal.timeout(8000)
 });}catch{throw new ApiError(503,'PAYMENT_PROOF_UNAVAILABLE','MS6 temporalmente no disponible');}
 const result:any=await response.json().catch(()=>null),p=result?.data;
 if(!response.ok||result?.success!==true||!p||p.status!=='PAID'||!p.paid_at||!Number.isFinite(Date.parse(p.paid_at)))
  throw new ApiError(503,'PAYMENT_PROOF_UNAVAILABLE','No se pudo verificar el pago persistido');
 if(p.payment_id!==body.payment_id||p.order_id!==body.order_id||p.currency!==body.currency||Number(p.amount)!==Number(body.amount))
  throw new ApiError(409,'PAYMENT_PROOF_CONFLICT','Pago incompatible');
 // Never use the caller's paid_at. Only the authenticated persisted proof is authoritative.
 const event={...body,paid_at:p.paid_at,store_id:p.store_id};
 const apply=async(stage:string,reservation_state?:string)=>{
  const {data,error}=await db.rpc('ms4_apply_payment_event',{p_event:{...event,stage,reservation_state}});
  if(error)throw new ApiError(503,'PAYMENT_STORAGE_UNAVAILABLE','No se pudo registrar el pago');
  if(!data||data.success!==true)throw new ApiError(409,data?.code==='RESOLUTION_REQUIRED'?'RESOLUTION_REQUIRED':'PAYMENT_EVENT_REJECTED','Pago pendiente de resolución');
  console.info({component:'MS4_PAYMENT_EVENT',eventId:body.event_id,paymentId:body.payment_id,stage,complete:data.complete===true});
  return data;
 };
 const prepared=await apply('PREPARE');
 if(prepared.complete)return prepared;
 const reservation=await inventoryStatus(prepared.reservation_id,env);
 if(reservation.store_id!==p.store_id)throw new ApiError(409,'RESERVATION_CONFLICT','Reserva incompatible');
 if(reservation.state==='RELEASED')return apply('RESOLUTION','RELEASED');
 if(reservation.state==='RESERVED')await commitInventory(prepared.reservation_id,env);
 return apply('FINALIZE','COMMITTED');
}
