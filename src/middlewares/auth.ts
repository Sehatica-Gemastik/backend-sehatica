import { MiddlewareHandler } from 'hono';
import { verifyToken } from '../utils/jwt';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface AuthVariables {
  userId: number;
  userEmail: string;
  userRole: string;
}

export const authMiddleware: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const authorization = c.req.header('Authorization');

  if (!authorization || !authorization.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Unauthorized: Missing token' }, 401);
  }

  const token = authorization.slice(7);

  try {
    const payload = await verifyToken(token);

    // Verify user still exists in DB
    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.sub),
    });

    if (!user) {
      return c.json({ success: false, error: 'Unauthorized: User not found' }, 401);
    }

    c.set('userId', payload.sub);
    c.set('userEmail', payload.email);
    c.set('userRole', payload.role);

    await next();
  } catch (err) {
    return c.json({ success: false, error: 'Unauthorized: Invalid token' }, 401);
  }
};

export const doctorMiddleware: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const role = c.get('userRole');
  if (role !== 'doctor' && role !== 'admin') {
    return c.json({ success: false, error: 'Forbidden: Doctor access required' }, 403);
  }
  await next();
};
