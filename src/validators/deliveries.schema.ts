import { z } from 'zod'
export const deliveryCreateSchema = z.object({order_id:z.uuid(), driver_name:z.string().min(2).max(120).optional(),driver_phone:z.string().min(6).max(32).optional()})
export const pairingSchema = z.object({code:z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/)})
export const locationSchema = z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)})
export const disputeSchema = z.object({reason:z.string().min(10).max(2000)})
export const deliveryStatusSchema = z.object({status:z.enum(['IN_TRANSIT','DELIVERED'])})
