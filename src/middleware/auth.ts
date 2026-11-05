import { createMiddleware } from 'hono/factory';
import { verify } from 'hono/jwt';
import { ApiError } from '../lib/errors.js';
export type Actor={id:string;role:'B2C'|'B2B'|'DRIVER';storeId?:string};
export type AppEnv={Bindings:{JWT_SECRET:string;JWT_ISSUER?:string;MS2_URL?:string;MS2_INTERNAL_KEY?:string;
 SUPABASE_URL:string;SUPABASE_SERVICE_ROLE_KEY:string;
 MS2_INVENTORY_OUTBOX_VERIFIED?:string;
 MS5_INTERNAL_KEY?:string;
 MS6_URL?:string;PAYMENTS_INTERNAL_KEY?:string;MS4_INTERNAL_KEY?:string},Variables:{actor:Actor}};
export const auth=createMiddleware<AppEnv>(async(c,next)=>{
 const token=/^Bearer (.+)$/i.exec(c.req.header('Authorization')||'')?.[1];
 if(!token)throw new ApiError(401,'UNAUTHORIZED','Bearer requerido');
 let payload:Record<string,unknown>;
 try {payload=await verify(token,c.env.JWT_SECRET,'HS256') as Record<string,unknown>;}catch{throw new ApiError(401,'INVALID_TOKEN','Token inválido');}
 if(payload.iss!==(c.env.JWT_ISSUER||'ms1-auth')||typeof payload.sub!=='string'||typeof payload.exp!=='number'||
  !['B2C','B2B','DRIVER'].includes(String(payload.role)))
  throw new ApiError(401,'INVALID_TOKEN','Claims inválidos');
 c.set('actor',{id:payload.sub,role:payload.role as Actor['role'],storeId:typeof payload.store_id==='string'?payload.store_id:undefined});
 await next();
});
export const requireRole=(...roles:Actor['role'][])=>createMiddleware<AppEnv>(async(c,next)=>{
 if(!roles.includes(c.get('actor').role))throw new ApiError(403,'FORBIDDEN','Rol no autorizado');
 await next();
});
