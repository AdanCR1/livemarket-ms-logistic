import { ApiError } from '../lib/errors.js';
import { createOrder, getOrder, transitionOrder } from '../repositories/orders.repository.js';
import { reserveInventory, releaseInventory } from './inventory.service.js';
import type { Actor } from '../middleware/auth.js';
import type { z } from 'zod';
import type { orderSchema } from '../validators/orders.schema.js';
import { ensureAccess } from '../middleware/tenant.js';

export async function placeOrder(body: z.infer<typeof orderSchema>, actor: Actor, key: string) {
  if (actor.role !== 'B2C') {
    throw new ApiError(403, 'ROLE_FORBIDDEN', 'Solo compradores crean pedidos');
  }

  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key requerida (8-128 caracteres)');
  }

  if (body.delivery_type === 'DELIVERY' && (!body.delivery_address || body.delivery_address.trim().length === 0)) {
    throw new ApiError(400, 'ADDRESS_REQUIRED', 'Para entregas a domicilio (DELIVERY) la dirección es requerida.');
  }

  // 1. Reservar stock en MS2
  const requestId = `${actor.id}:${key}`;
  const res = await reserveInventory({
    request_id: requestId,
    store_id: body.store_id,
    items: body.items,
  });

  const normalizedItems = res.items.map((it: any) => ({
    product_id: it.product_id,
    variant_id: it.variant_id ?? null,
    name: it.name || it.name_snapshot || 'Producto',
    unit_price: it.unit_price,
    quantity: it.quantity,
  }));

  try {
    // 2. Persistir orden en MS4
    const created = await createOrder({
      customer_id: actor.id,
      store_id: body.store_id,
      idempotency_key: key,
      delivery_type: body.delivery_type,
      delivery_address: body.delivery_address?.trim() || null,
      notes: body.notes?.trim() || null,
      reservation_id: res.reservation_id,
      reservation_expires_at: res.expires_at,
      currency: res.currency || 'BOB',
      items: normalizedItems,
    });

    return await getOrder(created.id);
  } catch (e: any) {
    console.error('[placeOrder DB Error]:', e);

    // 3. Compensación: revertir la reserva en MS2 si la BD de MS4 falló
    try {
      await releaseInventory(res.reservation_id);
    } catch (releaseErr: any) {
      console.error('[Rollback Inventory Failed]:', releaseErr.message);
    }

    throw new ApiError(
      e.status || 500,
      'ORDER_CREATION_FAILED',
      e.message || 'Error al persistir el pedido en la base de datos'
    );
  }
}

export async function changeOrder(id: string, status: string, actor: Actor) {
  const order = await getOrder(id);
  ensureAccess(actor, order);

  if (actor.role !== 'B2B' && status !== 'CANCELLED') {
    throw new ApiError(403, 'ROLE_FORBIDDEN', 'Solo comercio cambia preparación');
  }

  if (actor.role === 'B2C' && order.status !== 'PENDING_PAYMENT') {
    throw new ApiError(409, 'INVALID_TRANSITION', 'No se puede cancelar este pedido');
  }

  return transitionOrder(id, status, actor.id);
}