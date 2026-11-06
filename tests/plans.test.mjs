import assert from 'node:assert/strict';
import { test } from 'node:test';
import routes from '../src/routes/store-access.routes.ts';
import { assertStoreCanSell } from '../src/services/plan.service.ts';

const store = '10000000-0000-4000-8000-000000000001';
const env = { MS6_URL: 'https://payments.invalid', PAYMENTS_INTERNAL_KEY: 'fixture-key' };
for (const allowed of [true, false]) {
  test('plan verificado=' + allowed + ' se conserva en ruta pública y creación', async t => {
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, env.MS6_URL + '/api/internal/store-plan/' + store);
      assert.equal(init.headers['X-Internal-Key'], env.PAYMENTS_INTERNAL_KEY);
      assert.equal(init.redirect, 'manual');
      return Response.json({ success: true, data: { store_id: store, plan: allowed ? 'PRO' : 'FREE', can_accept_orders: allowed } });
    });
    const response = await routes.request('/' + store, {}, env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.can_accept_orders, allowed);
    if (allowed) await assertStoreCanSell(store, env);
    else await assert.rejects(assertStoreCanSell(store, env), error => error.status === 403);
  });
}
for (const [name, upstream] of [
  ['Worker responde HTML 404', () => new Response('error code: 1042', { status: 404 })],
  ['JSON inválido', () => new Response('invalid')],
  ['tienda distinta', () => Response.json({ success: true, data: { store_id: 'other', can_accept_orders: true } })],
  ['sin booleano', () => Response.json({ success: true, data: { store_id: store } })],
]) {
  test(name + ' nunca autoriza ventas', async t => {
    t.mock.method(globalThis, 'fetch', upstream);
    const response = await routes.request('/' + store, {}, env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).success, false);
    await assert.rejects(assertStoreCanSell(store, env), error => error.status === 503);
  });
}
