import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Cache para no instanciar el cliente en cada request
let cachedClient: SupabaseClient | null = null;

export function getDb(env?: any): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = env?.SUPABASE_URL || process.env?.SUPABASE_URL;
  const key = env?.SUPABASE_SERVICE_ROLE_KEY || process.env?.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no definidas.');
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cachedClient;
}

// Proxy para mantener compatibilidad si repositorios llaman a db.from(...)
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