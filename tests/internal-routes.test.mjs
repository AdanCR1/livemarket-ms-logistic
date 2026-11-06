import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import routes from '../src/routes/internal.routes.ts';
import { ApiError } from '../src/lib/errors.ts';
import { initDb } from '../src/lib/supabase.ts';

function app() {
  const server = new Hono();
  server.route('/api/internal', routes);
  server.onError((error,c) => c.json({ code: error instanceof ApiError ? error.code : error.message },
    error instanceof ApiError ? error.status : 500));
  return server;
}
const env = { MS4_INTERNAL_KEY: 'fixture-jobs', PAYMENTS_INTERNAL_KEY: 'fixture-payments' };
test('reconcile y expire validan la clave sin registrar una cadena como handler', async () => {
  for (const path of ['reconcile','expire']) {
    const response = await app().request('/api/internal/' + path, { method: 'POST' }, env);
    assert.equal(response.status, 401, JSON.stringify(await response.json()));
  }
});
test('reconcile conserva la guarda con la clave válida', async () => {
  const response = await app().request('/api/internal/reconcile', {
    method: 'POST', headers: { 'X-Internal-Key': env.MS4_INTERNAL_KEY },
  }, env);
  assert.equal(response.status, 503, JSON.stringify(await response.json()));
});
test('eventos de pago requieren la clave de pagos, no la clave del job', async () => {
  const response = await app().request('/api/internal/payments/events', {
    method: 'POST', headers: { 'X-Internal-Key': env.MS4_INTERNAL_KEY },
  }, env);
  assert.equal(response.status, 401);
});
test('acepta el amount numérico del productor y rechaza un fallo lógico de la RPC', async t => {
  let succeeds = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(String(url).endsWith('/rest/v1/rpc/ms4_apply_payment_event'));
    const body = JSON.parse(options.body);
    assert.equal(body.p_event.amount, '20');
    return Response.json({ success: succeeds });
  });
  initDb({ SUPABASE_URL: 'https://database.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key' });
  const body = { event_id: crypto.randomUUID(), payment_id: crypto.randomUUID(),
    order_id: crypto.randomUUID(), amount: 20, status: 'PAID', currency: 'BOB' };
  const send = () => app().request('/api/internal/payments/events', {
    method: 'POST', headers: { 'X-Internal-Key': env.PAYMENTS_INTERNAL_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
  assert.equal((await send()).status, 200);
  succeeds = false;
  assert.equal((await send()).status, 409);
});
