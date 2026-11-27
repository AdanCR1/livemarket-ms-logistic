import { ApiError } from '../lib/errors.js';
import { db } from '../lib/supabase.js';
import { createOrder, getOrder, transitionOrder, findOrderByRequest } from '../repositories/orders.repository.js';
import { reserveInventory, releaseInventory, type InventoryEnv } from './inventory.service.js';
import { assertStoreCanSell } from './plan.service.js';
import type { Actor } from '../middleware/auth.js';
import type { z } from 'zod';
import type { orderSchema } from '../validators/orders.schema.js';

type Env = InventoryEnv & {
  MS1_URL?: string;
  MS6_URL?: string;
  PAYMENTS_INTERNAL_KEY?: string;
  MS2_INVENTORY_OUTBOX_VERIFIED?: string;
};
type Input = z.infer<typeof orderSchema>;

async function schedule(orderId: string, actor: Actor, deadline: string) {
  const { data, error } = await db.rpc('ms4_schedule_pickup', {
    p_order_id: orderId,
    p_customer_id: actor.id,
    p_deadline: deadline,
    p_buyer_role: actor.role,
  });
  if (error || data?.success !== true) {
    throw new ApiError(
      409,
      'PICKUP_SCHEDULE_FAILED',
      `Pedido registrado pero fecha pendiente (${data?.code ?? error?.message ?? 'ERROR'}). Reintenta con la misma Idempotency-Key`
    );
  }
}

export async function placeOrder(body: Input, actor: Actor, key: string, env: Env) {
  if (!['B2C', 'B2B'].includes(actor.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'Requiere cuenta compradora');
  }
  if (actor.role === 'B2B' && actor.storeId === body.store_id) {
    throw new ApiError(403, 'SELF_PURCHASE', 'Un comercio no puede comprarse a sí mismo');
  }
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key inválida');
  }

  // Validación diferenciada por modalidad
  if (body.delivery_type === 'PICKUP') {
    if (!body.pickup_deadline) {
      throw new ApiError(400, 'PICKUP_DEADLINE_REQUIRED', 'Fecha de recogida requerida');
    }
    const deadline = Date.parse(body.pickup_deadline);
    if (!Number.isFinite(deadline) || deadline < Date.now() + 86400000 || deadline > Date.now() + 7 * 86400000) {
      throw new ApiError(400, 'PICKUP_DATE_OUT_OF_RANGE', 'Selecciona fecha entre 1 y 7 días');
    }
  } else if (body.delivery_type === 'DELIVERY') {
    if (!body.delivery_address || body.delivery_address.trim().length < 10) {
      throw new ApiError(400, 'DELIVERY_ADDRESS_REQUIRED', 'Dirección de entrega requerida (mínimo 10 caracteres)');
    }
  }

  // Verificación de plan ANTES de bloquear inventario
  await assertStoreCanSell(body.store_id, env);

  const previous = await findOrderByRequest(actor.id, key);
  if (previous) {
    const existing = await getOrder(previous.id);
    if (body.delivery_type === 'DELIVERY') return existing;
    if (existing.pickup_deadline === body.pickup_deadline) return existing;
    if (existing.pickup_deadline) {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Pedido existente con otra fecha de recogida');
    }
    await schedule(previous.id, actor, body.pickup_deadline!);
    return getOrder(previous.id);
  }

  if (env.MS2_INVENTORY_OUTBOX_VERIFIED !== 'true') {
    throw new ApiError(503, 'INVENTORY_NOT_VERIFIED', 'Reservas persistentes pendientes de validar en MS2');
  }

  const requestId = `${actor.id}:${key}`;
  const reservation = await reserveInventory(
    { request_id: requestId, store_id: body.store_id, items: body.items },
    env
  );

  try {
    const created = await createOrder({
      customer_id: actor.id,
      store_id: body.store_id,
      idempotency_key: key,
      delivery_type: body.delivery_type,
      delivery_address: body.delivery_type === 'DELIVERY' ? body.delivery_address!.trim() : null,
      dropoff_lat: body.delivery_type === 'DELIVERY' ? body.dropoff_lat : null,
      dropoff_lng: body.delivery_type === 'DELIVERY' ? body.dropoff_lng : null,
      route_geojson: body.delivery_type === 'DELIVERY' ? body.route_geojson ?? null : null,
      notes: body.notes?.trim() || null,
      reservation_id: reservation.reservation_id,
      reservation_expires_at: reservation.expires_at,
      currency: reservation.currency,
      items: reservation.items.map((i) => ({
        product_id: i.product_id,
        variant_id: i.variant_id ?? null,
        name: i.name,
        unit_price: i.unit_price,
        quantity: i.quantity,
      })),
    });

    if (body.delivery_type === 'PICKUP' && body.pickup_deadline) {
      await schedule(created.id, actor, body.pickup_deadline);
    }

    return await getOrder(created.id);
  } catch (e) {
    let exists;
    try {
      exists = await findOrderByRequest(actor.id, key);
    } catch {
      throw new ApiError(503, 'ORDER_STATE_UNKNOWN', 'Resultado ambiguo; reintenta con la misma clave');
    }
    if (exists) throw e;
    try {
      await releaseInventory(reservation.reservation_id, env);
    } catch (err) {
      console.error('Inventory release pending', err);
    }
    throw e;
  }
}

export async function changeOrder(id: string, status: string, actor: Actor) {
  const order = await getOrder(id);
  const isBuyer = order.customer_id === actor.id;
  const isSeller = actor.role === 'B2B' && actor.storeId === order.store_id;
  if (!isBuyer && !isSeller) throw new ApiError(404, 'NOT_FOUND', 'Pedido no encontrado');
  if (status === 'CANCELLED') {
    if (!isBuyer || order.status !== 'PENDING_PAYMENT') {
      throw new ApiError(409, 'INVALID_TRANSITION', 'Cancelación no autorizada');
    }
  } else if (!isSeller || !['PREPARING', 'READY'].includes(status)) {
    throw new ApiError(403, 'FORBIDDEN', 'Acción no permitida');
  }
  return transitionOrder(id, status, actor.id);
}

export async function deliveryAvailability(storeId: string, env: Env = {}) {
  if (!storeId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storeId)) {
    throw new ApiError(400, 'INVALID_STORE_ID', 'ID de tienda inválido');
  }

  // 1. Verificar que la tienda pueda operar/vender según su plan
  try {
    await assertStoreCanSell(storeId, env);
  } catch {
    return { store_id: storeId, delivery_available: false, reason: 'PLAN_INACTIVE' };
  }

  // 2. Consultar flota activa en MS1 si está configurado (con fallback permisivo si MS1 no expone ruta interna)
  const ms1Base = (env.MS1_URL || '').trim().replace(/\/+$/, '');
  if (ms1Base) {
    try {
      const res = await fetch(`${ms1Base}/api/stores/${storeId}/drivers/active`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const json: any = await res.json().catch(() => null);
        const count = json?.data?.active_count ?? (Array.isArray(json?.data) ? json.data.length : null);
        if (typeof count === 'number') {
          return { store_id: storeId, delivery_available: count > 0 };
        }
      }
    } catch {
      // Si MS1 no responde o no tiene ese endpoint público, continuar con disponibilidad activa
    }
  }

  return { store_id: storeId, delivery_available: true };
}