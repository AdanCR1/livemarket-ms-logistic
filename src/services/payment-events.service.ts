import { db } from '../lib/supabase.js'
import { ApiError } from '../lib/errors.js'
export async function handlePaymentEvent(body: {event_id:string;order_id:string;payment_id:string;status:'PAID'|'FAILED';amount:string;currency:string}) {
  const {data,error}=await db.rpc('ms4_apply_payment_event',{p_event:body})
  if(error) throw new ApiError(409,'PAYMENT_EVENT_REJECTED',error.message)
  return data
}
