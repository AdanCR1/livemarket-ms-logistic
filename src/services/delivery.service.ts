import { db } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';
import { getOrder } from '../repositories/orders.repository.js';
import { callDelivery, getDelivery } from '../repositories/deliveries.repository.js';
import { newPairingCode, pairingHash } from './pairing.service.js';
import type { Actor } from '../middleware/auth.js';

// Notificación asíncrona hacia MS6 Escrow
async function notifyEscrow(endpoint: string, payload: Record<string, unknown>) {
  const ms6Url = process.env.MS6_URL || 'http://localhost:8788';
  const paymentKey = process.env.PAYMENTS_INTERNAL_KEY;

  try {
    await fetch(`${ms6Url.replace(/\/$/, '')}/api/internal/escrow/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': paymentKey || '',
      },
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    console.error(`[Escrow Notification Failed: ${endpoint}]:`, err.message);
  }
}

export async function createDelivery(
  orderId: string,
  actor: Actor,
  info: { driver_name?: string; driver_phone?: string }
) {
  const order = await getOrder(orderId);
  if (actor.role !== 'B2B' || order.store_id !== actor.storeId) {
    throw new ApiError(403, 'FORBIDDEN', 'Comercio no autorizado');
  }
  if (order.status !== 'READY' || order.payment_status !== 'PAID' || order.delivery_type !== 'DELIVERY') {
    throw new ApiError(409, 'INVALID_ORDER', 'Debe estar pagado, listo y ser envío');
  }

  const { data, error } = await db
    .from('deliveries')
    .insert({
      order_id: order.id,
      store_id: order.store_id,
      customer_id: order.customer_id,
      driver_name: info.driver_name,
      driver_phone: info.driver_phone,
      pairing_code_hash: 'PENDING',
    })
    .select('id')
    .single();

  if (error) throw new ApiError(409, 'DELIVERY_CONFLICT', error.message);

  const code = newPairingCode();
  const { error: updateError } = await db
    .from('deliveries')
    .update({
      pairing_code_hash: pairingHash(data.id, code),
      pairing_code_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    })
    .eq('id', data.id);

  if (updateError) throw new Error(updateError.message);
  return { id: data.id, pairing_code: code, expires_in_seconds: 600 };
}

export async function pairDelivery(id: string, code: string, actor: Actor) {
  if (actor.role !== 'DRIVER') throw new ApiError(403, 'FORBIDDEN', 'Requiere rol DRIVER');
  return callDelivery('ms4_pair_delivery', {
    p_delivery_id: id,
    p_driver_id: actor.id,
    p_hash: pairingHash(id, code),
  });
}

export async function setLocation(id: string, actor: Actor, lat: number, lng: number) {
  if (actor.role !== 'DRIVER') throw new ApiError(403, 'FORBIDDEN', 'Requiere rol DRIVER');
  return callDelivery('ms4_set_location', {
    p_delivery_id: id,
    p_driver_id: actor.id,
    p_lat: lat,
    p_lng: lng,
  });
}

export async function confirmDelivery(id: string, actor: Actor) {
  const delivery = await getDelivery(id);
  if (actor.role !== 'B2C' || delivery.customer_id !== actor.id) {
    throw new ApiError(404, 'NOT_FOUND', 'Envío no encontrado');
  }
  return callDelivery('ms4_delivery_confirm', {
    p_delivery_id: id,
    p_customer_id: actor.id,
  });
}

export async function setDeliveryStatus(id: string, actor: Actor, status: string) {
  if (actor.role !== 'DRIVER') throw new ApiError(403, 'FORBIDDEN', 'Requiere rol DRIVER');

  const result = await callDelivery('ms4_delivery_status', {
    p_delivery_id: id,
    p_driver_id: actor.id,
    p_status: status,
  });

  // Al marcar DELIVERED, arrancar el contador de 5 minutos en MS6
  if (status === 'DELIVERED') {
    const delivery = await getDelivery(id);
    await notifyEscrow('delivered', {
      order_id: delivery.order_id,
      timer_minutes: 5,
    });
  }

  return result;
}

export async function disputeDelivery(id: string, actor: Actor, reason: string) {
  const delivery = await getDelivery(id);
  if (actor.role !== 'B2C' || delivery.customer_id !== actor.id) {
    throw new ApiError(404, 'NOT_FOUND', 'Envío no encontrado');
  }

  const result = await callDelivery('ms4_delivery_dispute', {
    p_delivery_id: id,
    p_customer_id: actor.id,
    p_reason: reason,
  });

  // Congelar retención de saldo en MS6
  await notifyEscrow('dispute', {
    order_id: delivery.order_id,
    action: 'FREEZE',
    reason,
  });

  return result;
}