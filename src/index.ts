import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ApiError } from './lib/errors.js'
import './lib/supabase.js'
import orders from './routes/orders.routes.js'
import deliveries from './routes/deliveries.routes.js'
import drivers from './routes/drivers.routes.js'
import internal from './routes/internal.routes.js'
const app = new Hono()
app.use('*', cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:4321', allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Internal-Key'], allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'] }))
app.get('/health', c => c.json({ success: true, service: 'marketcloud-ms4', status: 'ok' }))
app.route('/api/orders', orders)
app.route('/api/deliveries', deliveries)
app.route('/api/drivers', drivers)
app.route('/api/internal', internal)
app.notFound(c => c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } }, 404))
app.onError((err, c) => { if (err instanceof ApiError) return c.json({ success: false, error: { code: err.code, message: err.message } }, err.status as 400); console.error(err); return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Error interno' } }, 500) })
const port = Number(process.env.PORT || 8790)
export default app
