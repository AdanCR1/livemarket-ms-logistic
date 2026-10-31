import { Hono } from 'hono'
import { auth,requireRole,type AppEnv } from '../middleware/auth.js'
import { db } from '../lib/supabase.js'
const r=new Hono<AppEnv>();r.use('*',auth,requireRole('DRIVER'))
r.get('/deliveries',async c=>{const {data,error}=await db.from('deliveries').select('id,order_id,status,created_at').eq('driver_id',c.get('actor').id).limit(100);if(error)throw new Error(error.message);return c.json({success:true,data})})
export default r
