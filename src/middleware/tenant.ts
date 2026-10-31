import type { Actor } from './auth.js'
import { ApiError } from '../lib/errors.js'
export function canAccess(actor: Actor, order: {customer_id: string; store_id: string}) {
  return (actor.role === 'B2C' && order.customer_id === actor.id) || (actor.role === 'B2B' && actor.storeId === order.store_id)
}
export function ensureAccess(actor: Actor, order: {customer_id: string; store_id: string}) {
  if (!canAccess(actor, order)) throw new ApiError(404, 'NOT_FOUND', 'Recurso no encontrado')
}
