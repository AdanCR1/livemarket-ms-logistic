import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;

export function initDb(env?: any): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url =
    env?.SUPABASE_URL ||
    (typeof process !== 'undefined' ? process.env?.SUPABASE_URL : undefined);
  const key =
    env?.SUPABASE_SERVICE_ROLE_KEY ||
    (typeof process !== 'undefined' ? process.env?.SUPABASE_SERVICE_ROLE_KEY : undefined);

  if (!url || !key) {
    throw new Error('Variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no definidas.');
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cachedClient;
}

export function getDb(env?: any): SupabaseClient {
  if (env) return initDb(env);
  if (cachedClient) return cachedClient;
  return initDb(undefined);
}

// Proxy transparente: si cachedClient ya fue inicializado por el middleware, delega sin errores
export const db = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getDb();
    const value = (client as any)[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

export function dbResult<T>(data: T | null, error: { message: string; code?: string } | null): T {
  if (error) throw new Error(`Database error: ${error.message}`);
  if (data === null) throw new Error('Database returned null');
  return data;
}