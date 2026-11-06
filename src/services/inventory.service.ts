import { ApiError } from '../lib/errors.js';

export type QuoteItem = { product_id: string; variant_id?: string | null; name: string; unit_price: string; quantity: number };
export type Reservation = { reservation_id: string; expires_at: string; currency: 'BOB'; items: QuoteItem[] };
export type InventoryEnv = { MS2_URL?: string; MS2_INTERNAL_KEY?: string };

async function requestMS2(path: string, body: unknown, env: InventoryEnv) {
  // Cloudflare Workers obtiene secrets/bindings desde c.env, nunca del bundle.
  const base = env.MS2_URL?.replace(/\/+$/, '');
  if (!base || !env.MS2_INTERNAL_KEY) {
    throw new ApiError(503, 'INVENTORY_CONFIG_MISSING', 'MS2 no configurado');
  }
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': env.MS2_INTERNAL_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ApiError(503, 'INVENTORY_UNAVAILABLE', 'MS2 no disponible');
  }
  const json = await response.json().catch(() => null) as any;
  if (!response.ok || !json || json.success === false) throw new ApiError(response.status === 409 ? 409 : 502, 'INVENTORY_ERROR',
    typeof json?.error === 'string' ? json.error : 'Error de inventario');
  return json;
}
export async function reserveInventory(body: {
  request_id: string; store_id: string; items: { product_id: string; variant_id?: string; quantity: number }[];
}, env: InventoryEnv): Promise<Reservation> {
  const result = await requestMS2('/api/internal/inventory/reserve', body, env);
  // Compatibilidad con ambas respuestas documentadas: JSON plano o sobre {success,data}.
  const res = result?.data ?? result;
  if (!res?.reservation_id || !Array.isArray(res.items) || res.items.length !== body.items.length ||
      res.currency !== 'BOB' || !res.expires_at) {
    throw new ApiError(502, 'INVALID_MS2_RESPONSE', 'Respuesta inválida de MS2');
  }
  return res;
}
async function finishInventory(operation: 'commit' | 'release', reservation_id: string, env: InventoryEnv) {
  const result = await requestMS2('/api/internal/inventory/' + operation, { reservation_id }, env);
  const state = operation === 'commit' ? 'COMMITTED' : 'RELEASED';
  const legacy = operation === 'commit' ? result.committed : result.released;
  if (result.success !== true || (result.data?.state !== state && legacy !== true))
    throw new ApiError(502, 'INVALID_MS2_RESPONSE', 'MS2 no confirmó el estado de la reserva');
  return result;
}
export const releaseInventory = (reservation_id: string, env: InventoryEnv) => finishInventory('release', reservation_id, env);
export const commitInventory = (reservation_id: string, env: InventoryEnv) => finishInventory('commit', reservation_id, env);
