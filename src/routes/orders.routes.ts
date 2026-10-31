import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { auth, requireRole, type AppEnv } from '../middleware/auth.js'
import { orderSchema,statusSchema } from '../validators/orders.schema.js'
import { placeOrder,changeOrder } from '../services/order.service.js'
import { getOrder,listOrders } from '../repositories/orders.repository.js'
import { ensureAccess } from '../middleware/tenant.js'
import { ApiError } from '../lib/errors.js'
const routes=new Hono<AppEnv>()
routes.use('*',auth)
routes.post('/',requireRole('B2C'),zValidator('json',orderSchema),async c=>{
 const order=await placeOrder(c.req.valid('json'),c.get('actor'),c.req.header('Idempotency-Key')||'')
 return c.json({success:true,data:order},201)
})
routes.get('/',async c=>{const actor=c.get('actor'); if(actor.role==='DRIVER') throw new ApiError(403,'FORBIDDEN','No autorizado');return c.json({success:true,data:await listOrders(actor.role==='B2C'?{customer_id:actor.id}:{store_id:actor.storeId})})})
routes.get('/:id',async c=>{const order=await getOrder(c.req.param('id'));ensureAccess(c.get('actor'),order);return c.json({success:true,data:order})})
routes.patch('/:id/status',zValidator('json',statusSchema),async c=>c.json({success:true,data:await changeOrder(c.req.param('id'),c.req.valid('json').status,c.get('actor'))}))
export default routes
