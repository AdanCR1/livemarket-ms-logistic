import { Hono } from 'hono';
import type { AppEnv } from '../middleware/auth.js';

/** Publica solo el booleano para mostrar u ocultar Comprar; nunca es autoridad de permisos. */
const r = new Hono<AppEnv>();

r.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) {
    return c.json({ success: false, error: 'ID inválido' }, 400);
  }

  const ms6Base = (c.env?.MS6_URL || '').trim().replace(/\/+$/, '');
  const internalKey = (c.env?.PAYMENTS_INTERNAL_KEY || '').trim();

  if (!ms6Base || !internalKey) {
    console.warn('[MS4 store-access] Variables MS6 no definidas en c.env, usando fallback permisivo');
    return c.json({
      success: true,
      data: { store_id: id, can_accept_orders: true, fallback: true }
    });
  }

  try {
    const targetUrl = `${ms6Base}/api/internal/store-plan/${id}`;
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MarketCloud-MS4/1.0',
        'X-Internal-Key': internalKey,
      },
      signal: AbortSignal.timeout(4000),
    });

    const v: any = await res.json().catch(() => null);

    if (!res.ok || v?.success !== true) {
      console.warn('[MS4 store-access] MS6 respondió:', {
        status: res.status,
        body: v,
        targetUrl
      });
      // Resiliencia: si falla la verificación upstream, no bloquear la tienda
      return c.json({
        success: true,
        data: { store_id: id, can_accept_orders: true, plan: 'PRO', fallback: true }
      });
    }

    const canAccept = v?.data?.can_accept_orders ?? v?.can_accept_orders ?? true;

    return c.json({
      success: true,
      data: {
        store_id: id,
        can_accept_orders: Boolean(canAccept),
        plan: v?.data?.plan || 'PRO'
      }
    });
  } catch (e: any) {
    console.error('[MS4 store-access] Excepción de red hacia MS6:', e?.message || e);
    return c.json({
      success: true,
      data: { store_id: id, can_accept_orders: true, fallback: true }
    });
  }
});

export default r;