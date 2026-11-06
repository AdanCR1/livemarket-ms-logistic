import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { ApiError } from '../lib/errors.js'
import { handlePaymentEvent } from '../services/payment-events.service.js'
import { db } from '../lib/supabase.js'
import { commitInventory,releaseInventory } from '../services/inventory.service.js'
import type { AppEnv } from '../middleware/auth.js'
const r=new Hono<AppEnv>()
function equals(a: string, b: string) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);

    return x.length === y.length && timingSafeEqual(x, y);
}

r.use('/payments/*', async (c, next) => {
    const expected = c.env.PAYMENTS_INTERNAL_KEY;
    const received = c.req.header('X-Internal-Key') || '';

    if (!expected || !equals(received, expected)) {
        throw new ApiError(
            401,
            'UNAUTHORIZED',
            'Clave de pagos incorrecta'
        );
    }

    await next();
});

const authorizeJob = createMiddleware<AppEnv>(async (c, next) => {
    const expected = c.env.MS4_INTERNAL_KEY;
    const received = c.req.header('X-Internal-Key') || '';

    if (!expected || !equals(received, expected)) {
        throw new ApiError(
            401,
            'UNAUTHORIZED',
            'Clave interna incorrecta'
        );
    }

    await next();
});
r.use('/reconcile', authorizeJob);
r.use('/expire', authorizeJob);
const eventSchema=z.object({event_id:z.uuid(),order_id:z.uuid(),payment_id:z.uuid(),status:z.enum(['PAID','FAILED']),
 amount:z.preprocess(value=>typeof value==='number'&&Number.isFinite(value)?String(value):value,
  z.string().regex(/^\d+(\.\d{1,2})?$/)),currency:z.literal('BOB')})
r.post('/payments/events',zValidator('json',eventSchema),async c=>c.json({success:true,data:await handlePaymentEvent(c.req.valid('json'))}))
// Called by controlled job/cron, idempotent MS2 methods; handles at-least-once delivery.
r.post('/reconcile',async c=>{
 if(c.env.MS2_INVENTORY_OUTBOX_VERIFIED!=='true')
  return c.json({success:false,error:'Reconciliación pendiente de validar reservas en MS2'},503)
 const {data,error}=await db.from('inventory_outbox').select('*').eq('state','PENDING').lte('next_attempt_at',new Date().toISOString()).order('created_at').limit(30)
 if(error)throw new Error(error.message)
 const results=[]
 for(const job of data||[]){
  try {
   if(job.action==='COMMIT')await commitInventory(job.reservation_id,c.env)
   else if(job.action==='RELEASE')await releaseInventory(job.reservation_id,c.env)
   else throw new Error('INVALID_INVENTORY_ACTION')
   const {error:ackError}=await db.from('inventory_outbox').update({state:'DONE',updated_at:new Date().toISOString()}).eq('id',job.id).eq('state','PENDING')
   if(ackError)throw ackError
   results.push({id:job.id,status:'DONE'})
  }catch{
   const {error:retryError}=await db.from('inventory_outbox').update({
    attempts:job.attempts+1,
    next_attempt_at:new Date(Date.now()+Math.min(3600000,1000*2**Math.min(job.attempts+1,10))).toISOString()
   }).eq('id',job.id).eq('state','PENDING')
   const status=retryError?'UNKNOWN':'RETRY'
   console.warn({component:'MS4_INVENTORY_OUTBOX',jobId:job.id,code:status})
   results.push({id:job.id,status})
  }
 }
 const complete=results.every(result=>result.status==='DONE')
 return c.json({success:complete,data:results},complete?200:503)
})
// Expires pending orders, and queues inventory release atomically in PostgreSQL.
r.post('/expire',async c=>{const {data,error}=await db.rpc('ms4_expire_orders');if(error)throw new Error(error.message);return c.json({success:true,data})})
export default r
