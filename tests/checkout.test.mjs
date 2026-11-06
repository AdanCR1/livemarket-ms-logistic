import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import orders from '../src/routes/orders.routes.ts';
import { initDb } from '../src/lib/supabase.ts';
import { ApiError } from '../src/lib/errors.ts';

test('checkout comprueba plan, usa snapshots MS2 y recupera la misma orden', async t => {
  const store = crypto.randomUUID(), buyer = crypto.randomUUID(), product = crypto.randomUUID(), order = crypto.randomUUID();
  const deadline = new Date(Date.now()+2*86400000).toISOString();
  let allowed = false, exists = false, scheduled = false, reservations = 0, creations = 0;
  const snapshot = { id:order,store_id:store,customer_id:buyer,total:'20.00',status:'PENDING_PAYMENT',
    payment_status:'PENDING',delivery_type:'PICKUP',pickup_deadline:deadline,
    order_items:[{product_id:product,quantity:2}] };
  t.mock.method(globalThis,'fetch',async (url, options) => {
    const target = new URL(url);
    if(target.pathname.startsWith('/api/internal/store-plan/'))
      return Response.json({success:true,data:{store_id:store,plan:allowed?'PRO':'FREE',can_accept_orders:allowed}});
    if(target.pathname==='/api/internal/inventory/reserve') {
      reservations++;
      return Response.json({reservation_id:'res_fixture',expires_at:new Date(Date.now()+900000).toISOString(),currency:'BOB',
        items:[{product_id:product,name:'Fixture',unit_price:'10.00',quantity:2}]});
    }
    if(target.pathname==='/rest/v1/orders')
      return Response.json(exists?[{...snapshot,pickup_deadline:scheduled?deadline.replace('Z','+00:00'):null}]:[]);
    if(target.pathname==='/rest/v1/rpc/ms4_create_order') {
      creations++;
      const input = JSON.parse(options.body).p_input;
      assert.equal(input.items[0].unit_price,'10.00');
      assert.equal(input.items[0].quantity,2);
      assert.equal(input.items[0].name,'Fixture');
      exists=true;
      return Response.json({id:order});
    }
    if(target.pathname==='/rest/v1/rpc/ms4_schedule_pickup') {
      scheduled=true;
      return Response.json({success:true});
    }
    throw new Error('Ruta inesperada: '+target.pathname);
  });
  initDb({SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-db-key'});
  const env={JWT_SECRET:'fixture-jwt-secret',MS6_URL:'https://payments.invalid',PAYMENTS_INTERNAL_KEY:'fixture-payments',
    MS2_URL:'https://catalog.invalid',MS2_INTERNAL_KEY:'fixture-inventory',MS2_INVENTORY_OUTBOX_VERIFIED:'true'};
  const token=await sign({sub:buyer,role:'B2C',iss:'ms1-auth',exp:Math.floor(Date.now()/1000)+60},env.JWT_SECRET);
  const app=new Hono();
  app.route('/api/orders',orders);
  app.onError((error,c)=>c.json({success:false},error instanceof ApiError?error.status:500));
  const send=()=>app.request('/api/orders',{method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'fixture-stable-key'},
    body:JSON.stringify({store_id:store,delivery_type:'PICKUP',pickup_deadline:deadline,
      items:[{product_id:product,quantity:2,unit_price:0.01}],amount:0.02}),
  },env);
  assert.equal((await send()).status,403);
  assert.equal(reservations,0);
  allowed=true;
  for(let attempt=0;attempt<2;attempt++) {
    const response=await send();
    assert.equal(response.status,201);
    assert.equal((await response.json()).data.id,order);
  }
  assert.equal(reservations,1);
  assert.equal(creations,1);
});
