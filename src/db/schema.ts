import {
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const userRoleEnum = pgEnum('user_role', ['user', 'doctor', 'admin']);
export const reviewStatusEnum = pgEnum('review_status', ['pending', 'approved', 'revised']);

// The backend stores identity and entitlement metadata only. Health data lives on-device.
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: userRoleEnum('role').default('user').notNull(),
  avatarInitials: varchar('avatar_initials', { length: 5 }),
  phone: varchar('phone', { length: 20 }),
  isPro: boolean('is_pro').default(false).notNull(),
  // ponytail: one active session per account; add a sessions table only for simultaneous devices.
  refreshToken: text('refresh_token'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const doctors = pgTable('doctors', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  specialty: varchar('specialty', { length: 100 }).notNull(),
  rating: numeric('rating', { precision: 3, scale: 1 }).default('5.0'),
  reviewCount: integer('review_count').default(0).notNull(),
  verifiedCount: integer('verified_count').default(0).notNull(),
  isAvailable: boolean('is_available').default(true).notNull(),
  bio: text('bio'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('doctors_user_unique').on(table.userId),
]);

// The only server-held health exception: one explicitly consented AI response for one doctor.
export const reviews = pgTable('reviews', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  doctorId: integer('doctor_id').references(() => doctors.id, { onDelete: 'cascade' }).notNull(),
  clientMessageId: integer('client_message_id').notNull(),
  patientQuestion: text('patient_question').notNull(),
  aiResponse: text('ai_response').notNull(),
  safetyLevel: varchar('safety_level', { length: 20 }).notNull(),
  patientNote: text('patient_note'),
  status: reviewStatusEnum('status').default('pending').notNull(),
  doctorNote: text('doctor_note'),
  consentedAt: timestamp('consented_at').defaultNow().notNull(),
  decidedAt: timestamp('decided_at'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('reviews_user_message_unique').on(table.userId, table.clientMessageId),
]);

export const usersRelations = relations(users, ({ one, many }) => ({
  doctor: one(doctors, { fields: [users.id], references: [doctors.userId] }),
  reviews: many(reviews),
}));

export const doctorsRelations = relations(doctors, ({ one, many }) => ({
  user: one(users, { fields: [doctors.userId], references: [users.id] }),
  reviews: many(reviews),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  user: one(users, { fields: [reviews.userId], references: [users.id] }),
  doctor: one(doctors, { fields: [reviews.doctorId], references: [doctors.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Doctor = typeof doctors.$inferSelect;
export type Review = typeof reviews.$inferSelect;
