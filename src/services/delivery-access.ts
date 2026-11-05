import type { Actor } from '../middleware/auth.js'

type DeliveryParticipants = { customer_id: string; store_id: string; driver_id: string | null }

export function isAssignedDriver(actor: Actor, delivery: DeliveryParticipants) {
  return actor.role === 'DRIVER' && !!actor.storeId &&
    actor.storeId === delivery.store_id && actor.id === delivery.driver_id
}

export function canReadDelivery(actor: Actor, delivery: DeliveryParticipants) {
  return isAssignedDriver(actor, delivery) ||
    (actor.role === 'B2C' && actor.id === delivery.customer_id) ||
    (actor.role === 'B2B' && actor.storeId === delivery.store_id)
}

export function validLocation(lat: unknown, lng: unknown): lat is number {
  return typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180
}

export function canRegisterArrival(status: string) {
  return status === 'IN_TRANSIT'
}
