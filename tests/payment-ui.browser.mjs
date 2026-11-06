// Browser-only fixture. No frontend source changes and no live payment calls.
import assert from 'node:assert/strict';
import {chromium} from '../../livemarket-front-core/node_modules/@playwright/test/index.mjs';
const origin='http://localhost:4321',id='10000000-0000-4000-8000-000000000001';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const context=await browser.newContext();
 const claims=Buffer.from(JSON.stringify({role:'B2C',exp:Math.floor(Date.now()/1000)+120})).toString('base64url');
 await context.addCookies([{name:'mc_session',value:`e30.${claims}.fixture`,url:origin,httpOnly:true}]);
 const page=await context.newPage();let paid=false;
 const order=()=>({id,store_id:id,customer_id:id,total:'20.00',currency:'BOB',status:paid?'CONFIRMED':'PENDING_PAYMENT',payment_status:paid?'PAID':'PENDING',delivery_type:'PICKUP',created_at:new Date().toISOString(),reservation_expires_at:new Date(Date.now()+600000).toISOString(),order_items:[]});
 await page.route('**/api/orders?scope=purchases',r=>r.fulfill({json:{success:true,data:[order()]}}));
 await page.route(`**/api/orders/${id}`,r=>r.fulfill({json:{success:true,data:order()}}));
 await page.route('**/api/payments/qr',r=>r.fulfill({json:{success:true,data:{payment_id:id,qr_token:'MC-QR-fixture',amount:'20.00',currency:'BOB',purpose:'ORDER_PAYMENT',expires_at:new Date(Date.now()+600000).toISOString()}}}));
 await page.goto(origin+'/mis-pedidos');await page.getByRole('button',{name:'Pagar con QR'}).click();
 const dialog=page.getByRole('dialog',{name:'Pago QR'});
 await dialog.getByText('Vence en',{exact:false}).waitFor();
 paid=true;
 await dialog.getByText('Pago confirmado.',{exact:false}).waitFor({timeout:10000});
 assert.equal(await dialog.getByText('Vence en',{exact:false}).count(),0);
 console.log('Browser PASS: MS4 PAID removes QR expiry countdown');
}finally{await browser.close();}

