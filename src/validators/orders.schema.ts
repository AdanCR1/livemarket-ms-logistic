import { z } from 'zod';
const uuid=z.string().uuid();
export const orderSchema=z.object({
 store_id:uuid,delivery_type:z.enum(['PICKUP','DELIVERY']),delivery_address:z.string().max(500).optional(),
 pickup_deadline:z.string().datetime({offset:true}).optional(),notes:z.string().max(500).optional(),
 items:z.array(z.object({product_id:uuid,variant_id:uuid.optional(),quantity:z.number().int().min(1).max(100)})).min(1).max(30),
}).superRefine((v,ctx)=>{
 if(v.delivery_type==='PICKUP'&&!v.pickup_deadline)ctx.addIssue({code:'custom',path:['pickup_deadline'],message:'Fecha de recogida requerida'});
 if(v.delivery_type==='DELIVERY'&&!v.delivery_address?.trim())ctx.addIssue({code:'custom',path:['delivery_address'],message:'Dirección requerida'});
});
export const statusSchema=z.object({status:z.enum(['CANCELLED','PREPARING','READY','CONFIRMED'])});
