import { createMiddleware } from 'hono/factory';
import { verify } from 'hono/jwt';
import { ApiError } from '../lib/errors.js';

export type Actor = { id: string; role: 'B2C' | 'B2B' | 'DRIVER'; storeId?: string };

export type AppEnv = {
  Bindings: {
    JWT_SECRET: string;
    JWT_ISSUER?: string;
  };
  Variables: {
    actor: Actor;
  };
};

export const auth = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const token = /^Bearer (.+)$/i.exec(authHeader || '')?.[1];

  if (!token) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Bearer token requerido');
  }

  try {
    const payload = (await verify(token, c.env.JWT_SECRET, 'HS256')) as Record<string, unknown>;

    // Validar emisor de MS1 si está configurado
    const expectedIssuer = c.env.JWT_ISSUER || 'ms1-auth';
    if (payload.iss && payload.iss !== expectedIssuer) {
      throw new Error('Emisor inválido');
    }

    const role = payload.role as string;
    if (typeof payload.sub !== 'string' || !['B2C', 'B2B', 'DRIVER'].includes(role)) {
      throw new Error('Claims inválidos');
    }

    c.set('actor', {
      id: payload.sub,
      role: role as Actor['role'],
      storeId: typeof payload.store_id === 'string' ? payload.store_id : undefined,
    });

    await next();
  } catch {
    throw new ApiError(401, 'INVALID_TOKEN', 'Token inválido o expirado');
  }
});

export const requireRole = (...roles: Actor['role'][]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const currentActor = c.get('actor');
    if (!currentActor || !roles.includes(currentActor.role)) {
      throw new ApiError(403, 'ROLE_FORBIDDEN', 'Rol no autorizado');
    }
    await next();
  });