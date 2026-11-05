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
  if (!response.ok) throw new ApiError(response.status === 409 ? 409 : 502, 'INVENTORY_ERROR',
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
export const releaseInventory = (reservation_id: string, env: InventoryEnv) =>
  requestMS2('/api/internal/inventory/release', { reservation_id }, env);
export const commitInventory = (reservation_id: string, env: InventoryEnv) =>
  requestMS2('/api/internal/inventory/commit', { reservation_id }, env);
