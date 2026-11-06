
import { ApiError } from '../lib/errors.js';

export interface PlanEnv {
  MS6_URL?: string;
  PAYMENTS_INTERNAL_KEY?: string;
}

const TIMEOUT_MS = 8000;

type PlanResponse = {
  success?: boolean;
  data?: {
    can_accept_orders?: unknown;
    plan?: unknown;
  };
  code?: string;
  error?: unknown;
};

function diagnostic(
  level: 'info' | 'warn' | 'error',
  code: string,
  details: Record<string, unknown>
): void {
  const entry = {
    component: 'MS4_PLAN',
    code,
    timestamp: new Date().toISOString(),
    ...details,
  };

  if (level === 'info') console.info('[MS4 PLAN]', entry);
  else if (level === 'warn') console.warn('[MS4 PLAN]', entry);
  else console.error('[MS4 PLAN]', entry);
}

function resolveConfiguration(env: PlanEnv) {
  const rawUrl =
    typeof env?.MS6_URL === 'string'
      ? env.MS6_URL.trim()
      : '';

  const internalKey =
    typeof env?.PAYMENTS_INTERNAL_KEY === 'string'
      ? env.PAYMENTS_INTERNAL_KEY.trim()
      : '';

  if (!rawUrl || !internalKey) {
    diagnostic('error', 'PLAN_CONFIG_MISSING', {
      hasMS6Url: Boolean(rawUrl),
      hasInternalKey: Boolean(internalKey),
    });

    throw new ApiError(
      503,
      'PLAN_NOT_CONFIGURED',
      'Servicio de planes no configurado'
    );
  }

  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    diagnostic('error', 'PLAN_CONFIG_INVALID_URL', {
      reason: 'URL no válida',
    });

    throw new ApiError(
      503,
      'PLAN_INVALID_CONFIG',
      'URL del servicio de planes inválida'
    );
  }

  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, '') !== ''
  ) {
    diagnostic('error', 'PLAN_CONFIG_INVALID_URL', {
      reason: 'Se esperaba una URL base sin ruta ni credenciales',
      protocol: url.protocol,
    });

    throw new ApiError(
      503,
      'PLAN_INVALID_CONFIG',
      'Configuración inválida del servicio de planes'
    );
  }

  if (
    url.protocol !== 'https:' &&
    !['localhost', '127.0.0.1'].includes(url.hostname)
  ) {
    diagnostic('error', 'PLAN_CONFIG_INVALID_URL', {
      reason: 'El servicio remoto debe utilizar HTTPS',
    });

    throw new ApiError(
      503,
      'PLAN_INVALID_CONFIG',
      'El servicio de planes requiere HTTPS'
    );
  }

  const local = ['localhost', '127.0.0.1'].includes(url.hostname);

  diagnostic('info', 'PLAN_CONFIG_READY', {
    ms6Host: url.host,
    local,
    hasInternalKey: true,
  });

  return {
    base: url.origin,
    internalKey,
  };
}

export async function assertStoreCanSell(
  storeId: string,
  env: PlanEnv
): Promise<void> {
  const { base, internalKey } = resolveConfiguration(env);

  const target =
    `${base}/api/internal/store-plan/${encodeURIComponent(storeId)}`;

  const startedAt = Date.now();
  let response: Response;

  try {
    response = await fetch(target, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Internal-Key': internalKey,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;

    const name =
      error instanceof Error ? error.name : 'UnknownError';

    const timedOut =
      name === 'TimeoutError' || name === 'AbortError';

    diagnostic(
      'error',
      timedOut ? 'PLAN_TIMEOUT' : 'PLAN_NETWORK_ERROR',
      {
        storeId,
        ms6Host: new URL(base).host,
        elapsedMs,
        errorType: name,
      }
    );

    throw new ApiError(
      503,
      timedOut ? 'PLAN_TIMEOUT' : 'PLAN_UNAVAILABLE',
      timedOut
        ? 'La verificación del plan excedió el tiempo permitido'
        : 'No se pudo conectar con el servicio de planes'
    );
  }

  const elapsedMs = Date.now() - startedAt;

  const body = await response
    .json()
    .catch(() => null) as PlanResponse | null;

  if (!response.ok || body?.success !== true) {
    diagnostic('error', `PLAN_UPSTREAM_${response.status}`, {
      storeId,
      status: response.status,
      elapsedMs,
      upstreamCode:
        typeof body?.code === 'string'
          ? body.code.slice(0, 100)
          : null,
      responseIsJson: body !== null,
    });

    throw new ApiError(
      503,
      'PLAN_UPSTREAM_ERROR',
      `MS6 no pudo confirmar el plan (HTTP ${response.status})`
    );
  }

  const canAccept = body.data?.can_accept_orders;

  if (typeof canAccept !== 'boolean') {
    diagnostic('error', 'PLAN_INVALID_RESPONSE', {
      storeId,
      elapsedMs,
      hasData: Boolean(body.data),
      receivedType: typeof canAccept,
    });

    throw new ApiError(
      503,
      'PLAN_INVALID_RESPONSE',
      'MS6 devolvió una respuesta de plan inválida'
    );
  }

  if (!canAccept) {
    diagnostic('info', 'PLAN_DENIED', {
      storeId,
      elapsedMs,
      plan:
        typeof body.data?.plan === 'string'
          ? body.data.plan
          : 'unknown',
    });

    throw new ApiError(
      403,
      'PLAN_REQUIRED',
      'Tienda sin acceso a compras PRO'
    );
  }

  diagnostic('info', 'PLAN_VERIFIED', {
    storeId,
    elapsedMs,
    plan:
      typeof body.data?.plan === 'string'
        ? body.data.plan
        : 'unknown',
  });
}
