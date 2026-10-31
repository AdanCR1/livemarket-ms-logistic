import { ApiError } from '../lib/errors.js'
// Integrar contra el MS de suscripciones (no aceptar el plan enviado por el cliente).
export function requirePlus(plan: string | null | undefined) {
  if (plan !== 'PLUS') throw new ApiError(403, 'PLAN_REQUIRED', 'Se requiere plan Plus')
}
