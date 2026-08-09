import { Hono } from 'hono';
import { db } from '../db';
import { users } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { hashPassword, verifyPassword, generateAvatarInitials } from '../utils/password';
import {
  hashRefreshToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  verifyRefreshTokenHash,
} from '../utils/jwt';
import { successResponse, errorResponse } from '../utils/response';
import { authMiddleware } from '../middlewares/auth';
import { parseRegistrationInput } from '../utils/registration';

const auth = new Hono();

// POST /auth/register
auth.post('/register', async (c) => {
  try {
    const parsed = parseRegistrationInput(await c.req.json().catch(() => null));
    if ('error' in parsed) return errorResponse(c, parsed.error);
    const { name, email, password, phone } = parsed.value;

    // Check if email exists
    const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) {
      return errorResponse(c, 'Email sudah terdaftar', 409);
    }

    const passwordHash = await hashPassword(password);
    const avatarInitials = generateAvatarInitials(name);

    const [newUser] = await db.insert(users).values({
      name,
      email,
      passwordHash,
      avatarInitials,
      phone,
    }).returning();

    const accessToken = await signAccessToken({
      sub: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });

    const realRefreshToken = await signRefreshToken(newUser.id);
    await db
      .update(users)
      .set({ refreshToken: hashRefreshToken(realRefreshToken) })
      .where(eq(users.id, newUser.id));

    return successResponse(c, {
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        avatarInitials: newUser.avatarInitials,
        isPro: newUser.isPro,
      },
      accessToken,
      refreshToken: realRefreshToken,
    }, 201);
  } catch (err) {
    console.error('Register error:', err);
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// POST /auth/login
auth.post('/login', async (c) => {
  try {
    const body = await c.req.json();
    const { email, password } = body;

    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email.trim() ||
      !password
    ) {
      return errorResponse(c, 'Email dan password wajib diisi');
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return errorResponse(c, 'Email atau password salah', 401);
    }

    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = await signRefreshToken(user.id);
    await db
      .update(users)
      .set({ refreshToken: hashRefreshToken(refreshToken), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    return successResponse(c, {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatarInitials: user.avatarInitials,
        isPro: user.isPro,
        phone: user.phone,
      },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error('Login error:', err);
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// POST /auth/refresh
auth.post('/refresh', async (c) => {
  try {
    const body = await c.req.json();
    const { refreshToken } = body;

    if (!refreshToken) {
      return errorResponse(c, 'Refresh token diperlukan');
    }

    const payload = await verifyRefreshToken(refreshToken);
    const user = await db.query.users.findFirst({ where: eq(users.id, payload.sub) });

    if (!user?.refreshToken || !verifyRefreshTokenHash(refreshToken, user.refreshToken)) {
      return errorResponse(c, 'Refresh token tidak valid', 401);
    }

    const newAccessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    const newRefreshToken = await signRefreshToken(user.id);
    const [rotated] = await db
      .update(users)
      .set({
        refreshToken: hashRefreshToken(newRefreshToken),
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, user.id), eq(users.refreshToken, user.refreshToken)))
      .returning({ id: users.id });

    if (!rotated) {
      return errorResponse(c, 'Refresh token tidak valid', 401);
    }

    return successResponse(c, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch {
    return errorResponse(c, 'Refresh token expired atau tidak valid', 401);
  }
});

// POST /auth/logout — revoke the current refresh session
auth.post('/logout', authMiddleware, async (c) => {
  const userId = c.get('userId') as number;
  await db
    .update(users)
    .set({ refreshToken: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return successResponse(c, { loggedOut: true });
});

// GET /auth/me — get current user profile
auth.get('/me', authMiddleware, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

    if (!user) return errorResponse(c, 'User tidak ditemukan', 404);

    return successResponse(c, {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      avatarInitials: user.avatarInitials,
      isPro: user.isPro,
      phone: user.phone,
      createdAt: user.createdAt,
    });
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// PATCH /auth/profile — update profile
auth.patch('/profile', authMiddleware, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json();
    const { name, phone } = body;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name) { updates.name = name; updates.avatarInitials = generateAvatarInitials(name); }
    if (phone !== undefined) updates.phone = phone;

    const [updated] = await db.update(users).set(updates).where(eq(users.id, userId)).returning();
    return successResponse(c, { id: updated.id, name: updated.name, email: updated.email });
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

export default auth;
