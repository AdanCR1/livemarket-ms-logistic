import { db } from '../lib/supabase.js'
import { ApiError } from '../lib/errors.js'
import { getOrder } from '../repositories/orders.repository.js'
import { callDelivery, getDelivery } from '../repositories/deliveries.repository.js'
import { newPairingCode, pairingHash } from './pairing.service.js'
import type { Actor } from '../middleware/auth.js'
import { canRegisterArrival, isAssignedDriver } from './delivery-access.js'

export async function createDelivery(
  orderId: string,
  actor: Actor,
  info: { driver_id?: string; driver_name?: string; driver_phone?: string }
) {
  const order = await getOrder(orderId)
  if (actor.role !== 'B2B' || order.store_id !== actor.storeId) {
    throw new ApiError(403, 'FORBIDDEN', 'Comercio no autorizado')
  }
  if (order.status !== 'READY' || order.payment_status !== 'PAID' || order.delivery_type !== 'DELIVERY') {
    throw new ApiError(409, 'INVALID_ORDER', 'Debe estar pagado, listo y ser envío')
  }

  const code = newPairingCode()
  const codeHash = pairingHash(code)
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()

  // Verificar si ya existe un registro de entrega para este pedido
  const { data: existing } = await db
    .from('deliveries')
    .select('id, status')
    .eq('order_id', order.id)
    .maybeSingle()

  if (existing) {
    if (existing.status !== 'PENDING_PAIRING') {
      throw new ApiError(409, 'DELIVERY_ALREADY_ACTIVE', 'El envío ya fue aceptado por un repartidor')
    }

    const { error: updateError } = await db
      .from('deliveries')
      .update({
        driver_id: info.driver_id || null,
        ...(info.driver_name ? { driver_name: info.driver_name } : {}),
        ...(info.driver_phone ? { driver_phone: info.driver_phone } : {}),
        pairing_code_hash: codeHash,
        pairing_code_expires_at: expiresAt,
        pairing_attempts: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)

    if (updateError) throw new ApiError(409, 'DELIVERY_CONFLICT', updateError.message)

    return {
      id: existing.id,
      pairing_code: code,
      expires_in_seconds: 900,
      pairing_code_expires_at: expiresAt,
    }
  }

  const { data, error } = await db
    .from('deliveries')
    .insert({
      order_id: order.id,
      store_id: order.store_id,
      customer_id: order.customer_id,
      driver_id: info.driver_id || null,
      driver_name: info.driver_name,
      driver_phone: info.driver_phone,
      dropoff_lat: order.dropoff_lat ?? null,
      dropoff_lng: order.dropoff_lng ?? null,
      route_geojson: order.route_geojson ?? null,
      pairing_code_hash: codeHash,
      pairing_code_expires_at: expiresAt,
      status: 'PENDING_PAIRING',
    })
    .select('id')
    .single()

  if (error) throw new ApiError(409, 'DELIVERY_CONFLICT', error.message)

  return {
    id: data.id,
    pairing_code: code,
    expires_in_seconds: 900,
    pairing_code_expires_at: expiresAt,
  }
}

export async function pairDelivery(id: string, code: string, actor: Actor) {
  if (actor.role !== 'DRIVER') throw new ApiError(403, 'FORBIDDEN', 'Requiere rol DRIVER')
  const delivery = await getDelivery(id)
  if (
    !actor.storeId ||
    actor.storeId !== delivery.store_id ||
    (delivery.driver_id && delivery.driver_id !== actor.id)
  ) {
    throw new ApiError(404, 'NOT_FOUND', 'Envío no encontrado')
  }
  return callDelivery('ms4_pair_delivery', {
    p_delivery_id: id,
    p_driver_id: actor.id,
    p_hash: pairingHash(code),
  })
}

export async function setLocation(id: string, actor: Actor, lat: number, lng: number) {
  if (actor.role !== 'DRIVER') throw new ApiError(403, 'FORBIDDEN', 'Requiere rol DRIVER')
  const delivery = await getDelivery(id)
  if (!isAssignedDriver(actor, delivery)) throw new ApiError(403, 'FORBIDDEN', 'Envío no asignado')
  if (delivery.status !== 'IN_TRANSIT') throw new ApiError(409, 'INVALID_TRANSITION', 'La entrega no está en tránsito')
  return callDelivery('ms4_set_location', {
    p_delivery_id: id,
    p_driver_id: actor.id,
    p_lat: lat,
    p_lng: lng,
  })
}

export async function confirmDelivery(id: string, actor: Actor) {
  const delivery = await getDelivery(id)
  if (!['B2C', 'B2B'].includes(actor.role) || delivery.customer_id !== actor.id) {
    throw new ApiError(404, 'NOT_FOUND', 'Envío no encontrado')
  }
  return callDelivery('ms4_delivery_confirm', {
    p_delivery_id: id,
    p_customer_id: actor.id,
  })
}

export async function setDeliveryStatus(id: string, actor: Actor, status: string) {
  if (actor.role !== 'DRIVER') throw new ApiError(403, 'FORBIDDEN', 'Requiere rol DRIVER')
  const delivery = await getDelivery(id)
  if (!isAssignedDriver(actor, delivery)) throw new ApiError(403, 'FORBIDDEN', 'Envío no asignado')
  if (status === 'DELIVERED' && !canRegisterArrival(delivery.status)) {
    throw new ApiError(409, 'INVALID_TRANSITION', 'Solo un envío en tránsito puede registrar llegada')
  }

  return callDelivery('ms4_delivery_status', {
    p_delivery_id: id,
    p_driver_id: actor.id,
    p_status: status,
  })
}

export async function disputeDelivery(id: string, actor: Actor, reason: string) {
  const delivery = await getDelivery(id)
  if (actor.role !== 'B2C' || delivery.customer_id !== actor.id) {
    throw new ApiError(404, 'NOT_FOUND', 'Envío no encontrado')
  }

  return callDelivery('ms4_delivery_dispute', {
    p_delivery_id: id,
    p_customer_id: actor.id,
    p_reason: reason,
  })
}