import { ApiError } from '../lib/errors.js';
import { db } from '../lib/supabase.js';
import { createOrder, getOrder, transitionOrder, findOrderByRequest } from '../repositories/orders.repository.js';
import { reserveInventory,releaseInventory,type InventoryEnv } from './inventory.service.js';
import { assertStoreCanSell } from './plan.service.js';
import type { Actor } from '../middleware/auth.js';
import type { z } from 'zod';
import type { orderSchema } from '../validators/orders.schema.js';

type Env=InventoryEnv&{MS6_URL?:string;PAYMENTS_INTERNAL_KEY?:string;MS2_INVENTORY_OUTBOX_VERIFIED?:string};
type Input=z.infer<typeof orderSchema>;
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
 // Mientras no se habilite logística, no aceptar DELIVERY ni por API.
 if(body.delivery_type!=='PICKUP'||!body.pickup_deadline)
  throw new ApiError(409,'DELIVERY_DISABLED','Solo recogida en tienda habilitada');
 const deadline=Date.parse(body.pickup_deadline);
 if(!Number.isFinite(deadline)||deadline<Date.now()+86400000||deadline>Date.now()+7*86400000)
  throw new ApiError(400,'PICKUP_DATE_OUT_OF_RANGE','Selecciona fecha entre 1 y 7 días');
 // Verificación ANTES de bloquear inventario.
 await assertStoreCanSell(body.store_id,env);
 const previous=await findOrderByRequest(actor.id,key);
 if(previous){
  const existing=await getOrder(previous.id);
  if(existing.pickup_deadline===body.pickup_deadline)return existing;
  if(existing.pickup_deadline)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Pedido existente con otra fecha de recogida');
  await schedule(previous.id,actor,body.pickup_deadline);
  return getOrder(previous.id);
 }
 if (env.MS2_INVENTORY_OUTBOX_VERIFIED !== 'true')
  throw new ApiError(503,'INVENTORY_NOT_VERIFIED','Reservas persistentes pendientes de validar en MS2');
 const requestId=`${actor.id}:${key}`;
 const reservation=await reserveInventory({request_id:requestId,store_id:body.store_id,items:body.items},env);
 try {
  const created=await createOrder({
   customer_id:actor.id,store_id:body.store_id,idempotency_key:key,
   delivery_type:'PICKUP',delivery_address:null,notes:body.notes?.trim()||null,
   reservation_id:reservation.reservation_id,reservation_expires_at:reservation.expires_at,
   currency:reservation.currency,items:reservation.items.map(i=>({
     product_id:i.product_id,variant_id:i.variant_id??null,name:i.name,unit_price:i.unit_price,quantity:i.quantity
   })),
  });
  await schedule(created.id,actor,body.pickup_deadline);
  return await getOrder(created.id);
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
