import { ApiError } from '../lib/errors.js';

export type QuoteItem = {
  product_id: string;
  variant_id?: string | null;
  name: string;
  unit_price: string;
  quantity: number;
};

export type Reservation = {
  reservation_id: string;
  expires_at: string;
  currency: 'BOB';
  items: QuoteItem[];
};

// Helper interno para invocar MS2
async function requestMS2(path: string, body: unknown, env?: any) {
  // En Cloudflare Workers env viene por inyección, fallback a process.env si está en runtime híbrido
  const ms2Url = (env?.MS2_URL || process.env.MS2_URL || 'http://localhost:8788').replace(/\/$/, '');
  const internalKey = env?.MS2_INTERNAL_KEY || process.env.MS2_INTERNAL_KEY || '';

  const response = await fetch(`${ms2Url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': internalKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  const json = (await response.json().catch(() => null)) as any;
  if (!response.ok) {
    throw new ApiError(
      response.status === 409 ? 409 : 502,
      'INVENTORY_ERROR',
      json?.error || 'MS2 no disponible'
    );
  }
  return json;
}

// ─── Funciones requeridas por order.service.ts e internal.routes.ts ─────────

export async function reserveInventory(
  body: {
    request_id: string;
    store_id: string;
    items: { product_id: string; variant_id?: string; quantity: number }[];
  },
  env?: any
): Promise<Reservation> {
  const res = await requestMS2('/api/internal/inventory/reserve', body, env);
  if (
    !res?.reservation_id ||
    !Array.isArray(res?.items) ||
    res.items.length !== body.items.length ||
    res.currency !== 'BOB' ||
    !res.expires_at
  ) {
    throw new ApiError(502, 'INVALID_MS2_RESPONSE', 'Respuesta inválida de MS2');
  }
  return res;
}

export async function releaseInventory(reservation_id: string, env?: any) {
  return requestMS2('/api/internal/inventory/release', { reservation_id }, env);
}

export async function commitInventory(reservation_id: string, env?: any) {
  return requestMS2('/api/internal/inventory/commit', { reservation_id }, env);
}