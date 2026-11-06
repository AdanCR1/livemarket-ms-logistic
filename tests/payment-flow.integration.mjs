// In-process HTTP + real PostgreSQL simulation. No bank/debit RPC exists in this database.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Hono} from 'hono';
import ms4Routes from '../src/routes/internal.routes.ts';
import ms2Routes from '../../livemarket-ms-catalog/src/routes/internal.ts';
import ms6Routes from '../../livemarket-ms-payments/src/routes/internal.routes.ts';
import worker from '../../livemarket-ms-payments/src/index.ts';
import {processPaymentOutbox} from '../../livemarket-ms-payments/src/services/payment-outbox.ts';
import {initDb} from '../src/lib/supabase.ts';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const pg=new PGlite();
const sql=async path=>pg.exec(await readFile(new URL(path,import.meta.url),'utf8'));
await pg.exec(`create role anon;create role authenticated;create role service_role;
create table public.orders(id uuid primary key,store_id uuid,customer_id uuid,idempotency_key text,reservation_id text,reservation_expires_at timestamptz,status text,payment_status text,delivery_type text,currency text,total numeric,created_at timestamptz,updated_at timestamptz);
create table public.inventory_outbox(id uuid primary key default gen_random_uuid(),order_id uuid references orders(id),reservation_id text,action text,state text default 'PENDING',attempts int default 0,next_attempt_at timestamptz default now(),created_at timestamptz default now(),updated_at timestamptz default now());
create function public.ms4_apply_payment_event(jsonb) returns jsonb language sql as 'select ''{}''::jsonb';
create function public.ms4_expire_orders() returns jsonb language sql as 'select ''{}''::jsonb';
create table public.products(id uuid primary key,store_id uuid,stock int,name text,price numeric);
create type public.outbox_status as enum('PENDING','PROCESSING','SENT','FAILED');
create table public.payment_outbox(id uuid primary key default gen_random_uuid(),event_type text,destination text,aggregate_id uuid,payload jsonb,status public.outbox_status default 'PENDING',attempts int default 0,next_retry_at timestamptz default now(),claimed_at timestamptz,sent_at timestamptz,last_error text,created_at timestamptz default now());
create table public.payments(id uuid primary key,purpose text,reference_id uuid,target_store_id uuid,amount numeric,currency text,status text,paid_at timestamptz);
create table public.escrow_settlements(id uuid primary key,payment_id uuid,status text);`);
await sql('../sql/20261106_timely_payment_receipts.sql');
await sql('../../livemarket-ms-catalog/sql/001_inventory_reservations.sql');
await sql('../../livemarket-ms-payments/sql/20261105_payment_outbox_leases.sql');
await sql('../../livemarket-ms-payments/sql/20261106_order_payment_dispatch.sql');
const env={SUPABASE_URL:'https://fixture-db.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',MS4_URL:'https://ms4.invalid',MS6_URL:'https://ms6.invalid',MS2_URL:'https://ms2.invalid',MS2_INTERNAL_KEY:'inventory-key',PAYMENTS_INTERNAL_KEY:'payments-key'};
initDb(env);
const ms4=new Hono().route('/api/internal',ms4Routes);
ms4.onError((e,c)=>c.json({success:false,code:e.code||'ERROR'},e.status||503));
let failMS2=false,loseFinalizeResponse=false;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
 const u=new URL(input),path=u.pathname;
 const request=new Request(u,{...options});
 if(u.hostname==='ms4.invalid')return ms4.fetch(request,env);
 if(u.hostname==='ms6.invalid')return ms6Routes.request(path.replace('/api/internal',''),options,env);
 if(u.hostname==='ms2.invalid'){
  if(failMS2)return Response.json({success:false},{status:503});
  return ms2Routes.request(path.replace('/api/internal',''),options,env);
 }
 assert.equal(u.hostname,'fixture-db.invalid','External network forbidden');
 if(path.includes('/rpc/')){
  const name=path.split('/').pop(),args=JSON.parse(options.body);
  const signatures={ms4_apply_payment_event:['p_event'],ms2_finish_inventory_reservation:['p_reservation_id','p_action'],ms6_claim_order_payment_events_v3:['p_limit','p_payment_id','p_outbox_id'],ms6_ack_payment_event_v2:['p_event_id','p_claim_token','p_success','p_error']};
  assert.ok(signatures[name],name);
  const values=signatures[name].map(k=>typeof args[k]==='object'&&args[k]!==null?JSON.stringify(args[k]):args[k]);
  const params=signatures[name].map((k,i)=>`${k} := $${i+1}${k==='p_event'?'::jsonb':''}`).join(',');
  try{
   const claim=name==='ms6_claim_order_payment_events_v3';
   const r=await pg.query(claim?`select * from public.${name}(${params})`:`select public.${name}(${params}) as value`,values);
   if(name==='ms4_apply_payment_event'&&args.p_event.stage==='FINALIZE'&&loseFinalizeResponse){loseFinalizeResponse=false;return Response.json({code:'TEMPORARY'},{status:503});}
   return Response.json(claim?r.rows:r.rows[0].value);
  }catch(e){return Response.json({code:'P0001',message:'Fixture RPC rejection'},{status:409});}
 }
 const table=path.split('/').pop();assert.ok(['payments','escrow_settlements','ms2_inventory_reservations'].includes(table));
 const fields=u.searchParams.get('select');assert.match(fields,/^[a-z_,]+$/);
 const key=['id','payment_id'].find(k=>u.searchParams.has(k));assert.ok(key);
 const r=await pg.query(`select ${fields} from public.${table} where ${key}=$1`,[u.searchParams.get(key).slice(3)]);
 return Response.json(r.rows[0]??null);
};
try{
 for(const scenario of ['immediate','delayed','committed','released','late','ms2-retry','lost-finalize-response','concurrent','cron']){
  await pg.exec('begin');
  const oid=crypto.randomUUID(),pid=crypto.randomUUID(),eid=crypto.randomUUID(),outid=crypto.randomUUID(),sid=crypto.randomUUID();
  const expires=scenario==='immediate'?new Date(Date.now()+600000):new Date(Date.now()-3600000);
  const paid=scenario==='late'?new Date(Date.now()-1800000):new Date(Math.min(Date.now()-1000,expires.getTime()-600000));
  const product=crypto.randomUUID();
  const state=scenario==='committed'?'COMMITTED':scenario==='released'?'RELEASED':'RESERVED';
  const payload={event_id:eid,payment_id:pid,order_id:oid,status:'PAID',amount:20,currency:'BOB'};
  await pg.query(`insert into orders values($1,$2,$3,'fixture','res_fixture',$4,'PENDING_PAYMENT','PENDING','PICKUP','BOB',20,now()-interval '2 hours',now())`,[oid,sid,crypto.randomUUID(),expires.toISOString()]);
  await pg.query("insert into products values($1,$2,$3,'fixture',20)",[product,sid,state==='RELEASED'?2:1]);
  await pg.query(`insert into ms2_inventory_reservations(id,request_id,store_id,requested_items,items,expires_at,state)values('res_fixture','fixture',$1,'[]',$4,$2,$3)`,[sid,expires.toISOString(),state,JSON.stringify([{product_id:product,quantity:1}])]);
  await pg.query(`insert into payments values($1,'ORDER_PAYMENT',$2,$3,20,'BOB','PAID',$4)`,[pid,oid,sid,paid.toISOString()]);
  await pg.query(`insert into escrow_settlements values($1,$2,'HELD')`,[crypto.randomUUID(),pid]);
  await pg.query(`insert into payment_outbox(id,event_type,destination,aggregate_id,payload)values($1,'PAYMENT_SUCCEEDED','MS4',$2,$3)`,[outid,pid,JSON.stringify(payload)]);
  failMS2=scenario==='ms2-retry';loseFinalizeResponse=scenario==='lost-finalize-response';
  let result;
  if(scenario==='concurrent'){
   const both=await Promise.all([processPaymentOutbox(env,{outbox_id:outid}),processPaymentOutbox(env,{outbox_id:outid})]);
   assert.equal(both.reduce((n,r)=>n+(r.sent||0),0),1);result=both.find(r=>r.sent===1);
  }else if(scenario==='cron'){let task;worker.scheduled({},env,{waitUntil:p=>task=p});result=await task;}
  else result=await processPaymentOutbox(env,{payment_id:pid});
  if(['ms2-retry','lost-finalize-response'].includes(scenario)){
   assert.equal(result.success,false);failMS2=false;
   await pg.query(`update payment_outbox set next_retry_at=clock_timestamp()-interval '1 second' where id=$1`,[outid]);
   result=await processPaymentOutbox(env,{outbox_id:outid});
  }
  const row=(await pg.query('select o.status,o.payment_status,r.state as reservation_state,b.status as outbox_state,e.status as escrow_state from orders o cross join ms2_inventory_reservations r cross join payment_outbox b cross join escrow_settlements e')).rows[0];
  if(['released','late'].includes(scenario)){
   assert.equal(result.success,false);assert.equal(row.payment_status,'PENDING');assert.equal(row.outbox_state,'FAILED');assert.equal(row.reservation_state,state);
  }else{assert.equal(result.success,true);assert.equal(row.status,'CONFIRMED');assert.equal(row.payment_status,'PAID');assert.equal(row.reservation_state,'COMMITTED');assert.equal(row.outbox_state,'SENT');}
  assert.equal(row.escrow_state,'HELD');
  assert.equal((await pg.query('select stock from products')).rows[0].stock,state==='RELEASED'?2:1,'No duplicate inventory deduction');
  const replay=await processPaymentOutbox(env,{outbox_id:outid});assert.equal(replay.claimed,0);
  await pg.exec('rollback');console.log('HTTP/PostgreSQL integration PASS '+scenario);
 }
}finally{globalThis.fetch=originalFetch;await pg.close();}
