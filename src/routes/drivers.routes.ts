import { Hono } from 'hono'
import { auth,requireRole,type AppEnv } from '../middleware/auth.js'
import { db } from '../lib/supabase.js'
const r=new Hono<AppEnv>();r.use('*',auth,requireRole('DRIVER'))
r.get('/deliveries', async c => {
  c.header('Cache-Control', 'no-store')
  const actor = c.get('actor')
  if (!actor.storeId) return c.json({ success: false, error: 'Repartidor sin tienda vinculada' }, 403)
  const { data, error } = await db.from('deliveries').select('id,order_id,status,created_at')
    .eq('driver_id', actor.id).eq('store_id', actor.storeId)
    .order('created_at', { ascending: false }).limit(100)
  if (error) throw new Error(error.message)
  return c.json({ success: true, data })
})
export default r
