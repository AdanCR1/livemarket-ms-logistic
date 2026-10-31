import { db } from '../lib/supabase.js'
import { ApiError } from '../lib/errors.js'
export async function getDelivery(id:string) {
  const {data,error}=await db.from('deliveries').select('*').eq('id',id).maybeSingle()
  if(error) throw new Error(error.message)
  if(!data) throw new ApiError(404,'NOT_FOUND','Envío no encontrado')
  return data
}
export async function callDelivery(fn:string,args:Record<string,unknown>) {
  const {data,error}=await db.rpc(fn,args)
  if(error) throw new ApiError(409,'DELIVERY_CONFLICT',error.message)
  return data
}
