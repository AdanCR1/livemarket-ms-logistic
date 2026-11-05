import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { auth, type AppEnv } from '../middleware/auth.js';
import { orderSchema,statusSchema } from '../validators/orders.schema.js';
import { placeOrder,changeOrder } from '../services/order.service.js';
import { getOrder,listOrders } from '../repositories/orders.repository.js';
import { ApiError } from '../lib/errors.js';
const r=new Hono<AppEnv>();r.use('*',auth);
r.post('/',zValidator('json',orderSchema),async c=>{
 const result=await placeOrder(c.req.valid('json'),c.get('actor'),c.req.header('Idempotency-Key')||'',c.env);
 return c.json({success:true,data:result},201);
});
r.get('/',async c=>{
 const actor=c.get('actor');
 if(actor.role==='DRIVER')throw new ApiError(403,'FORBIDDEN','No autorizado');
 if(actor.role==='B2C')return c.json({success:true,data:await listOrders({customer_id:actor.id})});
 const [selling,buying]=await Promise.all([
  actor.storeId?listOrders({store_id:actor.storeId}):Promise.resolve([]),listOrders({customer_id:actor.id})
 ]);
 const combined=[...selling,...buying];
 const unique=[...new Map(combined.map((v:any)=>[v.id,v])).values()];
 unique.sort((a:any,b:any)=>Date.parse(b.created_at)-Date.parse(a.created_at));
 return c.json({success:true,data:unique});
});
r.get('/:id',async c=>{
 const v=await getOrder(c.req.param('id'));const a=c.get('actor');
 if(v.customer_id!==a.id && !(a.role==='B2B'&&a.storeId===v.store_id))
  throw new ApiError(404,'NOT_FOUND','Pedido no encontrado');
 return c.json({success:true,data:v});
});
r.patch('/:id/status',zValidator('json',statusSchema),async c=>c.json({success:true,data:await changeOrder(c.req.param('id'),c.req.valid('json').status,c.get('actor'))}));
export default r;
