import { Hono } from 'hono';
import type { AppEnv } from '../middleware/auth.js';
import { ApiError } from '../lib/errors.js';
import { getStorePlan } from '../services/plan.service.js';

const routes = new Hono<AppEnv>();
routes.get('/:id', async c => {
  const id = c.req.param('id');
  c.header('Cache-Control', 'no-store');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    return c.json({ success: false, error: 'ID inválido' }, 400);
  }
  try {
    const data = await getStorePlan(id, c.env);
    return c.json({ success: true, data });
  } catch (error) {
    return c.json({ success: false, error: 'No se pudo verificar el plan',
      code: error instanceof ApiError ? error.code : 'PLAN_UNAVAILABLE' }, 503);
  }
});
export default routes;
