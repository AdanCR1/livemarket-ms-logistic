import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { auth, type AppEnv } from '../middleware/auth.js'
import { db } from '../lib/supabase.js'

const routes = new Hono<AppEnv>()
routes.get('/:id', async (c, next) => {
  const secret = c.env.MS5_INTERNAL_KEY
  const provided = c.req.header('X-Internal-Key')
  if (!secret || !provided) return c.json({ success: false }, 401)
  const expected = Buffer.from(secret)
  const actual = Buffer.from(provided)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return c.json({ success: false }, 401)
  }
  await next()
}, auth, async c => {
  const id = c.req.param('id')
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) {
    return c.json({ success: false }, 400)
  }
  const actor = c.get('actor')
  const { data: order, error } = await db.from('orders')
    .select('id,customer_id,store_id').eq('id', id).maybeSingle()
  if (error) return c.json({ success: false }, 503)
  const isBuyer = actor.role !== 'DRIVER' && order?.customer_id === actor.id
  const isSeller = actor.role === 'B2B' && actor.storeId === order?.store_id
  if (!order || (!isBuyer && !isSeller)) return c.json({ success: false }, 404)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: { order_id: order.id, store_id: order.store_id } })
})
export default routes
