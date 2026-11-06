import { ApiError } from '../lib/errors.js';
import { db } from '../lib/supabase.js';
import { createOrder, getOrder, transitionOrder, findOrderByRequest } from '../repositories/orders.repository.js';
import { reserveInventory,releaseInventory,type InventoryEnv } from './inventory.service.js';
import { assertStoreCanSell, getStorePlan } from './plan.service.js';
import type { Actor } from '../middleware/auth.js';
import type { z } from 'zod';
import type { orderSchema } from '../validators/orders.schema.js';

type Env=InventoryEnv&{MS6_URL?:string;PAYMENTS_INTERNAL_KEY?:string;MS2_INVENTORY_OUTBOX_VERIFIED?:string;MS1_URL?:string};
type Input=z.infer<typeof orderSchema>;
export async function deliveryAvailability(storeId:string,env:Env){
 const subscription=await getStorePlan(storeId,env);
 if(!subscription.can_accept_orders||!['PRO','ENTERPRISE'].includes(subscription.plan??''))return false;
 if(!env.MS1_URL)throw new ApiError(503,'DELIVERY_UNAVAILABLE','Disponibilidad de reparto no verificable');
 try{
  const response=await fetch(env.MS1_URL.replace(/\/+$/,'')+'/api/stores/'+encodeURIComponent(storeId)+'/delivery',{
   signal:AbortSignal.timeout(5000),redirect:'error',headers:{Accept:'application/json'}
  });
  const result:any=await response.json();
  if(!response.ok||result?.success!==true||result.data?.store_id!==storeId||typeof result.data?.delivery_available!=='boolean')throw new Error();
  return result.data.delivery_available;
 }catch{throw new ApiError(503,'DELIVERY_UNAVAILABLE','Disponibilidad de reparto no verificable');}
}
async function schedule(orderId:string, actor:Actor, deadline:string){
 const {data,error}=await db.rpc('ms4_schedule_pickup',{
  p_order_id:orderId,p_customer_id:actor.id,p_deadline:deadline,p_buyer_role:actor.role
 });
 if(error||data?.success!==true)throw new ApiError(409,'PICKUP_SCHEDULE_FAILED',
  `Pedido registrado pero fecha pendiente (${data?.code??error?.message??'ERROR'}). Reintenta con la misma Idempotency-Key`);
}
export async function placeOrder(body:Input,actor:Actor,key:string,env:Env){
 if(!['B2C','B2B'].includes(actor.role))throw new ApiError(403,'FORBIDDEN','Requiere cuenta compradora');
 if(actor.role==='B2B' && actor.storeId===body.store_id)
  throw new ApiError(403,'SELF_PURCHASE','Un comercio no puede comprarse a sí mismo');
 if(!/^[a-zA-Z0-9_-]{8,128}$/.test(key))throw new ApiError(400,'IDEMPOTENCY_KEY_REQUIRED','Idempotency-Key inválida');
 if(body.delivery_type==='PICKUP'){
  const deadline=Date.parse(body.pickup_deadline??'');
  if(!Number.isFinite(deadline)||deadline<Date.now()+86400000||deadline>Date.now()+7*86400000)
   throw new ApiError(400,'PICKUP_DATE_OUT_OF_RANGE','Selecciona fecha entre 1 y 7 días');
 }else if(!body.delivery_address||body.delivery_address.trim().length<10||body.delivery_address.trim().length>500){
  throw new ApiError(400,'DELIVERY_ADDRESS_REQUIRED','Introduce una dirección de entre 10 y 500 caracteres');
 }
 // Verificación ANTES de bloquear inventario.
 await assertStoreCanSell(body.store_id,env);
 const previous=await findOrderByRequest(actor.id,key);
 if(previous){
  const existing=await getOrder(previous.id);
  const itemKey=(item:{product_id:string;variant_id?:string|null;quantity:number})=>
   `${item.product_id}:${item.variant_id??''}:${item.quantity}`;
  if(existing.store_id!==body.store_id || existing.delivery_type!==body.delivery_type ||
    (body.delivery_type==='DELIVERY'&&(existing.address_snapshot??existing.delivery_address)!==body.delivery_address?.trim()) ||
    !Array.isArray(existing.order_items) ||
    JSON.stringify(existing.order_items.map(itemKey).sort())!==JSON.stringify(body.items.map(itemKey).sort()))
   throw new ApiError(409,'IDEMPOTENCY_CONFLICT','La clave corresponde a otro pedido');
  if(body.delivery_type==='DELIVERY')return existing;
  if(existing.pickup_deadline && Date.parse(existing.pickup_deadline)===Date.parse(body.pickup_deadline!))return existing;
  if(existing.pickup_deadline)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Pedido existente con otra fecha de recogida');
  await schedule(previous.id,actor,body.pickup_deadline!);
  return getOrder(previous.id);
 }
 if(body.delivery_type==='DELIVERY'&&!await deliveryAvailability(body.store_id,env))
  throw new ApiError(409,'DELIVERY_DISABLED','Esta tienda no tiene reparto habilitado y disponible');
 if (env.MS2_INVENTORY_OUTBOX_VERIFIED !== 'true')
  throw new ApiError(503,'INVENTORY_NOT_VERIFIED','Reservas persistentes pendientes de validar en MS2');
 const requestId=`${actor.id}:${key}`;
 const reservation=await reserveInventory({request_id:requestId,store_id:body.store_id,items:body.items},env);
 try {
  const created=await createOrder({
   customer_id:actor.id,store_id:body.store_id,idempotency_key:key,
   delivery_type:body.delivery_type,delivery_address:body.delivery_type==='DELIVERY'?body.delivery_address!.trim():null,notes:body.notes?.trim()||null,
   reservation_id:reservation.reservation_id,reservation_expires_at:reservation.expires_at,
   currency:reservation.currency,items:reservation.items.map(i=>({
     product_id:i.product_id,variant_id:i.variant_id??null,name:i.name,unit_price:i.unit_price,quantity:i.quantity
   })),
  });
  if(body.delivery_type==='PICKUP')await schedule(created.id,actor,body.pickup_deadline!);
  const saved=await getOrder(created.id);
  if(body.delivery_type==='DELIVERY'&&(saved.delivery_type!=='DELIVERY'||
    (saved.address_snapshot??saved.delivery_address)!==body.delivery_address!.trim()))
   throw new ApiError(503,'DELIVERY_STORAGE_UNAVAILABLE','Pedido persistido pero dirección no confirmada; consulta el pedido antes de reintentar');
  return saved;
 }catch(e){
  // Si MS4 persistió, NO liberar stock: el usuario recupera con la misma clave.
  let exists;
  try { exists=await findOrderByRequest(actor.id,key); }
  catch {throw new ApiError(503,'ORDER_STATE_UNKNOWN','Resultado ambiguo; reintenta con la misma clave');}
  if(exists)throw e;
  try {await releaseInventory(reservation.reservation_id,env);}catch(err){console.error('Inventory release pending',err);}
  throw e;
 }
}
export async function changeOrder(id:string,status:string,actor:Actor){
 const order=await getOrder(id);
 const isBuyer=order.customer_id===actor.id;
 const isSeller=actor.role==='B2B'&&actor.storeId===order.store_id;
 if(!isBuyer&&!isSeller)throw new ApiError(404,'NOT_FOUND','Pedido no encontrado');
 if(status==='CANCELLED'){
  if(!isBuyer||order.status!=='PENDING_PAYMENT')throw new ApiError(409,'INVALID_TRANSITION','Cancelación no autorizada');
 }else if(!isSeller||!['PREPARING','READY'].includes(status)){
  throw new ApiError(403,'FORBIDDEN','Acción no permitida');
 }
 return transitionOrder(id,status,actor.id);
}
