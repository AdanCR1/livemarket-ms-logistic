import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ApiError } from './lib/errors.js';
import { initDb } from './lib/supabase.js';
import orders from './routes/orders.routes.js';
import deliveries from './routes/deliveries.routes.js';
import drivers from './routes/drivers.routes.js';
import internal from './routes/internal.routes.js';
import paymentQuote from './routes/payment-quote.routes.js';
import escrowSync from './routes/escrow-sync.routes.js';
import storeAccess from './routes/store-access.routes.js';
import chatAccess from './routes/chat-access.routes.js';

type Bindings = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  CORS_ORIGIN?: string;
  MS6_URL?: string;
  PAYMENTS_INTERNAL_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// 1. Inicializar la base de datos con los bindings del Worker en la primera solicitud
app.use('*', async (c, next) => {
  try {
    initDb(c.env);
  } catch (err: any) {
    console.error('[MS4 Supabase Init Error]:', err.message);
  }
  await next();
});

// 2. CORS dinámico compatible con Cloudflare Workers y entorno local
app.use('*', async (c, next) => {
  const origin = c.env?.CORS_ORIGIN || (typeof process !== 'undefined' ? process.env.CORS_ORIGIN : null) || 'http://localhost:4321';
  const corsMiddleware = cors({
    origin,
    allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Internal-Key'],
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  });
  return corsMiddleware(c, next);
});

app.get('/health', (c) =>
  c.json({ success: true, service: 'marketcloud-ms4', status: 'ok' })
);

app.route('/api/orders', orders);
app.route('/api/deliveries', deliveries);
app.route('/api/drivers', drivers);
app.route('/api/internal', internal);
app.route('/api/internal/orders', paymentQuote);
app.route('/api/internal/escrow-sync', escrowSync);
app.route('/api/store-access', storeAccess);
app.route('/api/ms5/order-access', chatAccess);

app.notFound((c) =>
  c.json(
    { success: false, error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } },
    404
  )
);

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(
      { success: false, error: { code: err.code, message: err.message } },
      err.status as 400
    );
  }
  console.error(err);
  return c.json(
    { success: false, error: { code: 'INTERNAL_ERROR', message: 'Error interno' } },
    500
  );
});

export default app;