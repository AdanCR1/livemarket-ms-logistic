import {Hono} from 'hono';
import {getOrder} from '../repositories/orders.repository.js';
import type {AppEnv} from '../middleware/auth.js';
import { ApiError } from '../lib/errors.js';
const r=new Hono<AppEnv>();
r.use('*',async(c,next)=>{
 const key=c.req.header('X-Internal-Key');
 if(!c.env.PAYMENTS_INTERNAL_KEY||!key||key!==c.env.PAYMENTS_INTERNAL_KEY)
  return c.json({success:false,error:'No autorizado'},401);
 await next();
});
r.get('/:id/payment-quote',async c=>{
 const id=c.req.param('id');
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))return c.json({success:false,error:'ID inválido'},400);
 try {
  const o=await getOrder(id);
  const payable=Boolean(o.status==='PENDING_PAYMENT'&&o.payment_status==='PENDING'&&
   Date.parse(o.reservation_expires_at)>Date.now()&&
   (o.delivery_type!=='PICKUP'||(o.pickup_deadline&&Date.parse(o.pickup_deadline)>Date.now())));
  return c.json({success:true,data:{id:o.id,customer_id:o.customer_id,store_id:o.store_id,
   amount:String(o.total),currency:o.currency,status:o.status,payment_status:o.payment_status,
   reservation_expires_at:o.reservation_expires_at,pickup_deadline:o.pickup_deadline,payable}});
 }catch(error){
  if(error instanceof ApiError&&error.status===404)return c.json({success:false,error:'Pedido no encontrado'},404);
  console.warn({component:'MS4_QUOTE',code:'QUOTE_DATABASE_UNAVAILABLE'});
  return c.json({success:false,error:'Cotización temporalmente no disponible'},503);
 }
});
export default r;
