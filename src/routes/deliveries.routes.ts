import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { zValidator } from '@hono/zod-validator'
import { auth, type AppEnv } from '../middleware/auth.js'
import {
  deliveryCreateSchema,
  pairingSchema,
  locationSchema,
  disputeSchema,
  deliveryStatusSchema,
} from '../validators/deliveries.schema.js'
import {
  createDelivery,
  pairDelivery,
  setLocation,
  setDeliveryStatus,
  confirmDelivery,
  disputeDelivery,
} from '../services/delivery.service.js'
import { getDelivery } from '../repositories/deliveries.repository.js'
import { ApiError } from '../lib/errors.js'
import { pairingHash } from '../services/pairing.service.js'
import { canReadDelivery, validLocation } from '../services/delivery-access.js'

const r = new Hono<AppEnv>()
r.use('*', auth)

// ─── POST /claim-by-code (Ruta fija antes de rutas con parámetro dinámico) ───
r.post('/claim-by-code', async (c) => {
  const actor = c.get('actor')
  if (actor.role !== 'DRIVER') {
    return c.json({ success: false, error: 'Requiere rol DRIVER' }, 403)
  }

  const { code } = await c.req.json().catch(() => ({}))
  if (!code || typeof code !== 'string' || code.trim().length !== 6) {
    return c.json({ success: false, error: 'Ingresa un código de 6 caracteres válido' }, 400)
  }

  const codeHash = pairingHash(code.trim().toUpperCase())
  const supabase = createSupabaseAdmin(c.env)

  const { data, error } = await supabase.rpc('ms4_claim_by_code', {
    p_driver_id: actor.id,
    p_hash: codeHash,
  })

  if (error || !data?.success) {
    return c.json({ success: false, error: error?.message || data?.error }, 400)
  }

  return c.json({ success: true, data: data.data })
})

// ─── POST / (Crear Delivery por el comercio B2B) ──────────────────────────────
r.post('/', zValidator('json', deliveryCreateSchema), async (c) => {
  const body = c.req.valid('json')
  return c.json(
    {
      success: true,
      data: await createDelivery(body.order_id, c.get('actor'), body),
    },
    201
  )
})

// ─── GET /:id (Consultar detalle del envío) ──────────────────────────────────
r.get('/:id', async (c) => {
  const d = await getDelivery(c.req.param('id'))
  const a = c.get('actor')

  if (!canReadDelivery(a, d)) {
    throw new ApiError(404, 'NOT_FOUND', 'Envío no encontrado')
  }

  const { pairing_code_hash, last_latitude, last_longitude, ...safe } = d
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: {
    ...safe,
    last_latitude: d.status === 'IN_TRANSIT' ? last_latitude : null,
    last_longitude: d.status === 'IN_TRANSIT' ? last_longitude : null,
  } })
})

// ─── POST /:id/pair (Método tradicional con ID + Código) ─────────────────────
r.post('/:id/pair', zValidator('json', pairingSchema), async (c) => {
  return c.json({
    success: true,
    data: await pairDelivery(c.req.param('id'), c.req.valid('json').code, c.get('actor')),
  })
})

// ─── POST y PATCH /:id/location (Soporta lat/lng y latitude/longitude) ───────
const handleLocation = async (c: any) => {
  const body = await c.req.json().catch(() => ({}))
  const lat = body?.lat ?? body?.latitude
  const lng = body?.lng ?? body?.longitude

  if (!validLocation(lat, lng) || typeof lng !== 'number') {
    return c.json({ success: false, error: 'Coordenadas lat y lng inválidas' }, 400)
  }

  return c.json({
    success: true,
    data: await setLocation(c.req.param('id'), c.get('actor'), lat, lng),
  })
}

r.post('/:id/location', handleLocation)
r.patch('/:id/location', handleLocation)

// ─── PATCH /:id/status (Actualizar estado: IN_TRANSIT, DELIVERED, etc.) ───────
r.patch('/:id/status', zValidator('json', deliveryStatusSchema), async (c) => {
  return c.json({
    success: true,
    data: await setDeliveryStatus(c.req.param('id'), c.get('actor'), c.req.valid('json').status),
  })
})

// ─── POST /:id/confirm (Confirmar entrega por el cliente B2C) ─────────────────
r.post('/:id/confirm', async (c) => {
  return c.json({
    success: true,
    data: await confirmDelivery(c.req.param('id'), c.get('actor')),
  })
})

// ─── POST /:id/disputes (Abrir disputa por el cliente B2C) ────────────────────
r.post('/:id/disputes', zValidator('json', disputeSchema), async (c) => {
  return c.json(
    {
      success: true,
      data: await disputeDelivery(c.req.param('id'), c.get('actor'), c.req.valid('json').reason),
    },
    201
  )
})

export default r

function createSupabaseAdmin(env: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
}
