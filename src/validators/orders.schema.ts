import { z } from 'zod'
export const uuid = z.uuid()
export const orderSchema = z.object({
  store_id: uuid, delivery_type: z.enum(['PICKUP','DELIVERY']),
  delivery_address: z.string().trim().min(8).max(500).optional(),
  notes: z.string().max(1000).optional(),
  items: z.array(z.object({ product_id: uuid, variant_id: uuid.optional(), quantity: z.number().int().positive().max(100) })).min(1).max(30)
}).superRefine((x, ctx) => {if (x.delivery_type==='DELIVERY' && !x.delivery_address) ctx.addIssue({code:'custom',message:'Dirección obligatoria para envío',path:['delivery_address']})})
export const statusSchema = z.object({ status: z.enum(['CONFIRMED','PREPARING','READY','CANCELLED']) })
