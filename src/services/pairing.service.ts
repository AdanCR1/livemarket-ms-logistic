import { randomInt, createHmac } from 'node:crypto'
export const newPairingCode=()=>randomInt(0,1_000_000).toString().padStart(6,'0')
export const pairingHash=(deliveryId:string,code:string)=>createHmac('sha256',process.env.MS4_INTERNAL_KEY!).update(`${deliveryId}:${code}`).digest('hex')
