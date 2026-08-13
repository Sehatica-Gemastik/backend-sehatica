import type { users } from '../db/schema';

export type DbUser = typeof users.$inferSelect;

export function isUserIdentityComplete(user: Pick<
  DbUser,
  'age' | 'sex' | 'raceEthnicity' | 'education' | 'incomePovertyRatio'
>): boolean {
  return (
    user.age != null
    && user.sex != null
    && user.raceEthnicity != null
    && user.education != null
    && user.incomePovertyRatio != null
  );
}

export function formatUserResponse(user: DbUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatarInitials: user.avatarInitials,
    isPro: user.isPro,
    phone: user.phone,
    dateOfBirth: user.dateOfBirth,
    bloodType: user.bloodType,
    allergies: user.allergies,
    conditions: user.conditions,
    age: user.age,
    sex: user.sex,
    race_ethnicity: user.raceEthnicity,
    education: user.education,
    income_poverty_ratio: user.incomePovertyRatio != null ? Number(user.incomePovertyRatio) : null,
    identityCompletedAt: user.identityCompletedAt?.toISOString() ?? null,
    identityComplete: isUserIdentityComplete(user),
    createdAt: user.createdAt,
  };
}

export type IdentityPatch = {
  age?: number;
  sex?: number;
  race_ethnicity?: number;
  education?: number;
  income_poverty_ratio?: number;
};

export function parseIdentityPatch(body: Record<string, unknown>): {
  updates: Partial<Pick<DbUser, 'age' | 'sex' | 'raceEthnicity' | 'education' | 'incomePovertyRatio' | 'identityCompletedAt'>>;
  error?: string;
} {
  const updates: Partial<Pick<DbUser, 'age' | 'sex' | 'raceEthnicity' | 'education' | 'incomePovertyRatio' | 'identityCompletedAt'>> = {};

  if (body.age !== undefined) {
    const age = Number(body.age);
    if (!Number.isFinite(age) || age < 18 || age > 120) {
      return { updates, error: 'Usia harus antara 18–120 tahun' };
    }
    updates.age = age;
  }

  if (body.sex !== undefined) {
    const sex = Number(body.sex);
    if (![1, 2].includes(sex)) {
      return { updates, error: 'Jenis kelamin tidak valid' };
    }
    updates.sex = sex;
  }

  if (body.race_ethnicity !== undefined) {
    const race = Number(body.race_ethnicity);
    if (![1, 2, 3, 4, 6, 7].includes(race)) {
      return { updates, error: 'Latar belakang tidak valid' };
    }
    updates.raceEthnicity = race;
  }

  if (body.education !== undefined) {
    const education = Number(body.education);
    if (![1, 2, 3, 4, 5].includes(education)) {
      return { updates, error: 'Pendidikan tidak valid' };
    }
    updates.education = education;
  }

  if (body.income_poverty_ratio !== undefined) {
    const income = Number(body.income_poverty_ratio);
    if (![0.5, 1, 2, 3, 4, 5].includes(income)) {
      return { updates, error: 'Kondisi ekonomi tidak valid' };
    }
    updates.incomePovertyRatio = String(income);
  }

  return { updates };
}
