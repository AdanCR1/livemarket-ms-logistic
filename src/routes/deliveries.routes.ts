import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { auth, type AppEnv } from '../middleware/auth.js'
import { deliveryCreateSchema, pairingSchema, locationSchema, disputeSchema, deliveryStatusSchema } from '../validators/deliveries.schema.js'
import { createDelivery,pairDelivery,setLocation,setDeliveryStatus,confirmDelivery,disputeDelivery } from '../services/delivery.service.js'
import { getDelivery } from '../repositories/deliveries.repository.js'
import { ApiError } from '../lib/errors.js'
const r=new Hono<AppEnv>();r.use('*',auth)
r.post('/',zValidator('json',deliveryCreateSchema),async c=>c.json({success:true,data:await createDelivery(c.req.valid('json').order_id,c.get('actor'),c.req.valid('json'))},201))
r.get('/:id',async c=>{const d=await getDelivery(c.req.param('id'));const a=c.get('actor');if(!((a.role==='B2C'&&a.id===d.customer_id)||(a.role==='B2B'&&a.storeId===d.store_id)||(a.role==='DRIVER'&&a.id===d.driver_id)))throw new ApiError(404,'NOT_FOUND','Envío no encontrado');const {pairing_code_hash,...safe}=d;return c.json({success:true,data:safe})})
r.post('/:id/pair',zValidator('json',pairingSchema),async c=>c.json({success:true,data:await pairDelivery(c.req.param('id'),c.req.valid('json').code,c.get('actor'))}))
r.patch('/:id/location',zValidator('json',locationSchema),async c=>{const {latitude,longitude}=c.req.valid('json');return c.json({success:true,data:await setLocation(c.req.param('id'),c.get('actor'),latitude,longitude)})})
r.patch('/:id/status',zValidator('json',deliveryStatusSchema),async c=>c.json({success:true,data:await setDeliveryStatus(c.req.param('id'),c.get('actor'),c.req.valid('json').status)}))
r.post('/:id/confirm',async c=>c.json({success:true,data:await confirmDelivery(c.req.param('id'),c.get('actor'))}))
r.post('/:id/disputes',zValidator('json',disputeSchema),async c=>c.json({success:true,data:await disputeDelivery(c.req.param('id'),c.get('actor'),c.req.valid('json').reason)},201))
export default r
