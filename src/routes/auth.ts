import { Hono } from 'hono';
import { db } from '../db';
import { doctors, users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword, generateAvatarInitials } from '../utils/password';
import { signAccessToken, signRefreshToken, verifyToken } from '../utils/jwt';
import { successResponse, errorResponse } from '../utils/response';
import { authMiddleware } from '../middlewares/auth';
import {
  formatUserResponse,
  isUserIdentityComplete,
  parseIdentityPatch,
} from '../utils/user-profile';

const auth = new Hono();

// POST /auth/register
auth.post('/register', async (c) => {
  try {
    const body = await c.req.json();
    const { name, email, password, phone } = body;

    if (!name || !email || !password) {
      return errorResponse(c, 'Nama, email, dan password wajib diisi');
    }

    if (password.length < 6) {
      return errorResponse(c, 'Password minimal 6 karakter');
    }

    // Check if email exists
    const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) {
      return errorResponse(c, 'Email sudah terdaftar', 409);
    }

    const passwordHash = hashPassword(password);
    const avatarInitials = generateAvatarInitials(name);
    const refreshToken = await signRefreshToken(0); // temp token

    const [newUser] = await db.insert(users).values({
      name,
      email: email.toLowerCase().trim(),
      passwordHash,
      avatarInitials,
      phone: phone ?? null,
      refreshToken,
    }).returning();

    const accessToken = await signAccessToken({
      sub: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });

    const realRefreshToken = await signRefreshToken(newUser.id);
    await db.update(users).set({ refreshToken: realRefreshToken }).where(eq(users.id, newUser.id));

    return successResponse(c, {
      user: formatUserResponse(newUser),
      accessToken,
      refreshToken: realRefreshToken,
    }, 201);
  } catch (err) {
    console.error('Register error:', err);
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// POST /auth/register-doctor — web doctor portal signup
auth.post('/register-doctor', async (c) => {
  try {
    const body = await c.req.json();
    const { name, email, password, phone, specialty, bio } = body;

    if (!name || !email || !password || !specialty) {
      return errorResponse(c, 'Nama, email, password, dan spesialisasi wajib diisi');
    }

    if (password.length < 8) {
      return errorResponse(c, 'Password minimal 8 karakter');
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existing = await db.query.users.findFirst({ where: eq(users.email, normalizedEmail) });
    if (existing) {
      return errorResponse(c, 'Email sudah terdaftar', 409);
    }

    const passwordHash = hashPassword(password);
    const avatarInitials = generateAvatarInitials(name);
    const tempRefresh = await signRefreshToken(0);

    const [newUser] = await db.insert(users).values({
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash,
      role: 'doctor',
      avatarInitials,
      phone: phone ? String(phone).trim() : null,
      refreshToken: tempRefresh,
    }).returning();

    await db.insert(doctors).values({
      userId: newUser.id,
      specialty: String(specialty).trim(),
      bio: bio ? String(bio).trim() : null,
      isAvailable: true,
    });

    const accessToken = await signAccessToken({
      sub: newUser.id,
      email: newUser.email,
      role: newUser.role,
    });
    const refreshToken = await signRefreshToken(newUser.id);
    await db.update(users).set({ refreshToken }).where(eq(users.id, newUser.id));

    return successResponse(c, {
      user: formatUserResponse(newUser),
      accessToken,
      refreshToken,
    }, 201);
  } catch (err) {
    console.error('Register doctor error:', err);
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// POST /auth/login
auth.post('/login', async (c) => {
  try {
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      return errorResponse(c, 'Email dan password wajib diisi');
    }

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return errorResponse(c, 'Email atau password salah', 401);
    }

    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = await signRefreshToken(user.id);
    await db.update(users).set({ refreshToken, updatedAt: new Date() }).where(eq(users.id, user.id));

    return successResponse(c, {
      user: formatUserResponse(user),
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error('Login error:', err);
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// POST /auth/logout
auth.post('/logout', authMiddleware, async (c) => {
  try {
    const userId = c.get('userId') as number;
    await db.update(users).set({ refreshToken: null, updatedAt: new Date() }).where(eq(users.id, userId));
    return successResponse(c, { ok: true });
  } catch {
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

    const payload = await verifyToken(refreshToken);
    const user = await db.query.users.findFirst({ where: eq(users.id, payload.sub) });

    if (!user || user.refreshToken !== refreshToken) {
      return errorResponse(c, 'Refresh token tidak valid', 401);
    }

    const newAccessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    return successResponse(c, { accessToken: newAccessToken });
  } catch {
    return errorResponse(c, 'Refresh token expired atau tidak valid', 401);
  }
});

// GET /auth/me — get current user profile
auth.get('/me', authMiddleware, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

    if (!user) return errorResponse(c, 'User tidak ditemukan', 404);

    return successResponse(c, formatUserResponse(user));
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

// PATCH /auth/profile — update profile
auth.patch('/profile', authMiddleware, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = await c.req.json();
    const { name, phone, dateOfBirth, bloodType, allergies, conditions } = body;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name) { updates.name = name; updates.avatarInitials = generateAvatarInitials(name); }
    if (phone !== undefined) updates.phone = phone;
    if (dateOfBirth !== undefined) updates.dateOfBirth = dateOfBirth;
    if (bloodType !== undefined) updates.bloodType = bloodType;
    if (allergies !== undefined) updates.allergies = allergies;
    if (conditions !== undefined) updates.conditions = conditions;

    const identityPatch = parseIdentityPatch(body);
    if (identityPatch.error) {
      return errorResponse(c, identityPatch.error);
    }
    Object.assign(updates, identityPatch.updates);

    const [updated] = await db.update(users).set(updates).where(eq(users.id, userId)).returning();
    if (!updated) return errorResponse(c, 'User tidak ditemukan', 404);

    if (isUserIdentityComplete(updated) && !updated.identityCompletedAt) {
      const [withStamp] = await db
        .update(users)
        .set({ identityCompletedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning();
      return successResponse(c, formatUserResponse(withStamp ?? updated));
    }

    return successResponse(c, formatUserResponse(updated));
  } catch {
    return errorResponse(c, 'Terjadi kesalahan server', 500);
  }
});

export default auth;
