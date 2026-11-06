
import { Hono } from 'hono';
import type { AppEnv } from '../middleware/auth.js';

const r = new Hono<AppEnv>();

type PlanResponse = {
  success?: boolean;
  data?: {
    can_accept_orders?: unknown;
    plan?: unknown;
  };
  code?: string;
};

r.get('/:id', async (c) => {
  const id = c.req.param('id');

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    return c.json({
      success: false,
      error: 'ID inválido',
    }, 400);
  }

  const rawUrl = (c.env.MS6_URL ?? '').trim();
  const internalKey =
    (c.env.PAYMENTS_INTERNAL_KEY ?? '').trim();

  if (!rawUrl || !internalKey) {
    console.error('[MS4 STORE ACCESS]', {
      code: 'PLAN_CONFIG_MISSING',
      hasMS6Url: Boolean(rawUrl),
      hasInternalKey: Boolean(internalKey),
    });

    return c.json({
      success: false,
      code: 'PLAN_NOT_CONFIGURED',
      error: 'No se pudo verificar el plan',
    }, 503);
  }

  let base: URL;

  try {
    base = new URL(rawUrl);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname.replace(/\/+$/, '') !== ''
    ) {
      throw new Error('URL base inválida');
    }

    if (
      base.protocol !== 'https:' &&
      !['localhost', '127.0.0.1'].includes(base.hostname)
    ) {
      throw new Error('MS6 remoto requiere HTTPS');
    }
  } catch {
    console.error('[MS4 STORE ACCESS]', {
      code: 'PLAN_CONFIG_INVALID_URL',
    });

    return c.json({
      success: false,
      code: 'PLAN_INVALID_CONFIG',
      error: 'Configuración de planes inválida',
    }, 503);
  }

  const startedAt = Date.now();

  let response: Response;

  try {
    response = await fetch(
      `${base.origin}/api/internal/store-plan/${id}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Internal-Key': internalKey,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      }
    );
  } catch (error) {
    const name =
      error instanceof Error ? error.name : 'UnknownError';

    const timedOut =
      name === 'TimeoutError' || name === 'AbortError';

    console.error('[MS4 STORE ACCESS]', {
      code: timedOut ? 'PLAN_TIMEOUT' : 'PLAN_NETWORK_ERROR',
      storeId: id,
      ms6Host: base.host,
      elapsedMs: Date.now() - startedAt,
      errorType: name,
    });

    return c.json({
      success: false,
      code: timedOut ? 'PLAN_TIMEOUT' : 'PLAN_UNAVAILABLE',
      error: 'No se pudo consultar el plan',
    }, 503);
  }

  const data = await response
    .json()
    .catch(() => null) as PlanResponse | null;

  const elapsedMs = Date.now() - startedAt;

  if (!response.ok || data?.success !== true) {
    console.error('[MS4 STORE ACCESS]', {
      code: `PLAN_UPSTREAM_${response.status}`,
      storeId: id,
      ms6Host: base.host,
      status: response.status,
      elapsedMs,
      upstreamCode:
        typeof data?.code === 'string'
          ? data.code.slice(0, 100)
          : null,
    });

    return c.json({
      success: false,
      code: 'PLAN_UPSTREAM_ERROR',
      error: 'MS6 no pudo verificar el plan',
    }, 503);
  }

  const allowed = data.data?.can_accept_orders;

  if (typeof allowed !== 'boolean') {
    console.error('[MS4 STORE ACCESS]', {
      code: 'PLAN_INVALID_RESPONSE',
      storeId: id,
      elapsedMs,
    });

    return c.json({
      success: false,
      code: 'PLAN_INVALID_RESPONSE',
      error: 'Respuesta inválida de MS6',
    }, 503);
  }

  console.info('[MS4 STORE ACCESS]', {
    code: allowed ? 'PLAN_VERIFIED' : 'PLAN_DENIED',
    storeId: id,
    elapsedMs,
  });

  return c.json({
    success: true,
    data: {
      store_id: id,
      can_accept_orders: allowed,
      plan:
        typeof data.data?.plan === 'string'
          ? data.data.plan
          : null,
    },
  });
});

export default r;
