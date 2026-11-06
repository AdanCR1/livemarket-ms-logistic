import { db } from '../lib/supabase.js'
import { ApiError } from '../lib/errors.js'
export async function handlePaymentEvent(body: {event_id:string;order_id:string;payment_id:string;status:'PAID'|'FAILED';amount:string;currency:string}) {
  const {data,error}=await db.rpc('ms4_apply_payment_event',{p_event:body})
  if(error || !data || data.success===false) {
    console.warn({component:'MS4_PAYMENT_EVENT',eventId:body.event_id,
      databaseCode:error?.code??'LOGICAL_REJECTION'});
    throw new ApiError(409,'PAYMENT_EVENT_REJECTED','No se pudo aplicar el evento de pago')
  }
  return data
}
