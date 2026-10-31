import { db, dbResult } from '../lib/supabase.js'
import { ApiError } from '../lib/errors.js'
export async function getOrder(id: string) {
  const {data,error}=await db.from('orders').select('*,order_items(*),deliveries(*)').eq('id',id).maybeSingle()
  if(error) throw new Error(error.message)
  if(!data) throw new ApiError(404,'NOT_FOUND','Pedido no encontrado')
  return data
}
export async function createOrder(input: Record<string,unknown>) {
  const {data,error}=await db.rpc('ms4_create_order', {p_input: input})
  return dbResult(data,error)
}
export async function transitionOrder(id: string, status: string, actor: string) {
  const {data,error}=await db.rpc('ms4_transition_order',{p_order_id:id,p_new_status:status,p_actor:actor})
  if(error) throw new ApiError(409,'INVALID_TRANSITION',error.message)
  return data
}
export async function listOrders(filter: { customer_id?: string; store_id?: string }) {
  let q = db.from('orders').select('*,order_items(*)').order('created_at',{ascending:false}).limit(100)
  if(filter.customer_id) q=q.eq('customer_id',filter.customer_id)
  if(filter.store_id) q=q.eq('store_id',filter.store_id)
  const {data,error}=await q
  return dbResult(data,error)
}
