import { Hono } from 'hono';
import { db } from '../lib/supabase.js';
import type { AppEnv } from '../middleware/auth.js';

/** Despachador de eventos escrow persistidos por triggers de PostgreSQL. */
const r = new Hono<AppEnv>();
r.post('/', async (c) => {
  const key = c.req.header('X-Internal-Key');
  if (!c.env.MS4_INTERNAL_KEY || key !== c.env.MS4_INTERNAL_KEY) {
    return c.json({success:false,error:'No autorizado'},401);
  }
  if (!c.env.MS6_URL || !c.env.PAYMENTS_INTERNAL_KEY) {
    return c.json({success:false,error:'MS6 no configurado'},503);
  }
  const {data: claimed, error} = await db.rpc('ms4_claim_escrow_events', {p_limit:10});
  if (error) return c.json({success:false,error:'Error al reclamar eventos'},500);
  let delivered=0;
  for (const event of claimed ?? []) {
    const target = event.event_type === 'DELIVERED' ? 'delivered' : 'dispute';
    const payload = target === 'delivered'
      ? {order_id:event.order_id,timer_minutes:5}
      : {order_id:event.order_id,action:'FREEZE',reason:'Disputa registrada en MS4'};
    let ok=false; let message='';
    try {
      const res=await fetch(`${c.env.MS6_URL.replace(/\/+$/,'')}/api/internal/escrow/${target}`,{
        method:'POST',headers:{'Content-Type':'application/json','X-Internal-Key':c.env.PAYMENTS_INTERNAL_KEY},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)
      });
      ok=res.ok; if(!ok) message=`HTTP ${res.status}`;
    } catch(e) { message=e instanceof Error?e.message:'Error de red'; }
    const {error: ackError}=await db.rpc('ms4_ack_escrow_event',{
      p_event_id:event.id,p_success:ok,p_error:message
    });
    if(ackError) console.error('No se pudo confirmar estado outbox',event.id);
    if(ok) delivered++;
  }
  return c.json({success:true,claimed:(claimed??[]).length,delivered});
});
export default r;
