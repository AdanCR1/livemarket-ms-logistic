import {Hono} from 'hono';
import type {AppEnv} from '../middleware/auth.js';
/** Publica solo el booleano para mostrar u ocultar Comprar; nunca es autoridad de permisos. */
const r=new Hono<AppEnv>();
r.get('/:id',async c=>{
 const id=c.req.param('id');
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))return c.json({success:false,error:'ID inválido'},400);
 if(!c.env?.MS6_URL||!c.env?.PAYMENTS_INTERNAL_KEY)return c.json({success:false,error:'Configuración de planes ausente en MS4',code:'PLAN_CONFIG_MISSING'},503);
 try{
  const res=await fetch(`${c.env.MS6_URL.replace(/\/+$/,'')}/api/internal/store-plan/${id}`,{
    headers:{'X-Internal-Key':c.env.PAYMENTS_INTERNAL_KEY},signal:AbortSignal.timeout(6000)
  });
  const v:any=await res.json().catch(()=>null);
  if(!res.ok||v?.success!==true){console.warn('[MS4 store-access] MS6 devolvió HTTP',res.status);return c.json({success:false,error:'MS6 no pudo verificar el plan',code:'PLAN_UPSTREAM_ERROR'},503);}
  return c.json({success:true,data:{store_id:id,can_accept_orders:v.data.can_accept_orders===true}});
 }catch(e){console.error('[MS4 store-access] Error consultando MS6',e);return c.json({success:false,error:'No se pudo contactar con MS6',code:'PLAN_UNAVAILABLE'},503);}
});
export default r;
