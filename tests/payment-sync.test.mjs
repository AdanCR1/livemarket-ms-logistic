import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handlePaymentEvent} from '../src/services/payment-events.service.ts';
import {initDb} from '../src/lib/supabase.ts';
const env={SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',MS6_URL:'https://payments.invalid',MS2_URL:'https://catalog.invalid',PAYMENTS_INTERNAL_KEY:'payments-key',MS2_INTERNAL_KEY:'inventory-key'};
initDb(env);
const body={event_id:crypto.randomUUID(),payment_id:crypto.randomUUID(),order_id:crypto.randomUUID(),status:'PAID',amount:'20',currency:'BOB',paid_at:'2099-01-01T00:00:00Z'};
const paid_at='2026-11-06T03:39:43Z',store_id=crypto.randomUUID();
for(const scenario of ['immediate','delayed','committed','released','late','replay-event','replay-payment','ms2-error','ms6-error','finalize-error','wrong-amount']){
 test(scenario,async t=>{
  let commits=0,finalized=0,resolutions=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
   const path=new URL(url).pathname;
   if(path.endsWith('/proof'))return Response.json(scenario==='ms6-error'?{success:false}:{success:true,data:{...body,store_id,paid_at,amount:scenario==='wrong-amount'?'21':'20'}},{status:scenario==='ms6-error'?503:200});
   if(path.endsWith('/rpc/ms4_apply_payment_event')){
    const {p_event:e}=JSON.parse(options.body);assert.equal(e.paid_at,paid_at);assert.equal(e.event_id,body.event_id);
    if(e.stage==='PREPARE')return Response.json({success:scenario!=='late',complete:scenario.startsWith('replay'),reservation_id:'res_fixture'});
    if(e.stage==='RESOLUTION'){resolutions++;return Response.json({success:false,code:'RESOLUTION_REQUIRED'});}
    finalized++;return Response.json({success:scenario!=='finalize-error',complete:true});
   }
   if(path.endsWith('/inventory/status'))return Response.json({success:scenario!=='ms2-error',data:{id:'res_fixture',store_id,state:scenario==='committed'?'COMMITTED':scenario==='released'?'RELEASED':'RESERVED',expires_at:'2026-11-06T03:54:19Z'}},{status:scenario==='ms2-error'?503:200});
   if(path.endsWith('/inventory/commit')){commits++;return Response.json({success:true,data:{state:'COMMITTED'}});}
   throw Error('Unexpected route '+path);
  });
  if(['released','late','ms2-error','ms6-error','finalize-error','wrong-amount'].includes(scenario))await assert.rejects(handlePaymentEvent(body,env));
  else assert.equal((await handlePaymentEvent(body,env)).complete,true);
  assert.equal(commits,['immediate','delayed','finalize-error'].includes(scenario)?1:0);
  assert.equal(finalized,['immediate','delayed','committed','finalize-error'].includes(scenario)?1:0);
  assert.equal(resolutions,scenario==='released'?1:0);
 });
}
