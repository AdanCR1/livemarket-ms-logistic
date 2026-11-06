import {readFile,writeFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
const result={};
for(const service of ['logistic','catalog','payments']){
 const e=parseEnv(await readFile(`D:/Grado/livemarket-ms-${service}/.dev.vars`,'utf8'));
 const get=async p=>{const r=await fetch(e.SUPABASE_URL+'/rest/v1/'+p,{headers:{apikey:e.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+e.SUPABASE_SERVICE_ROLE_KEY}});if(!r.ok)throw Error(service+' HTTP '+r.status);return r.json()};
 const schema=await get('');
 result[service]={rpc:service==='logistic'?Object.fromEntries(Object.entries(schema.paths??{}).filter(([k])=>/ms4_(apply_payment_event|expire_orders)$/.test(k))):undefined,tables:Object.fromEntries(Object.entries(schema.definitions??{}).filter(([k])=>['orders','inventory_outbox','payment_events','ms2_inventory_reservations','payments'].includes(k)))};
 if(service==='catalog')result[service].reservation=await get('ms2_inventory_reservations?select=id,store_id,state,expires_at&id=eq.res_e9828e00-f4f1-4aa8-9601-5ab5acee9084');
 if(service==='logistic')result[service].order=await get('orders?select=id,status,payment_status,reservation_id,reservation_expires_at,total,currency,created_at&id=eq.c1998ee1-eae2-4616-a228-956bec148eff');
}
await writeFile('tests/payment-schema.snapshot.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
