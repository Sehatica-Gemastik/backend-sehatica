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
  feePerQna: numeric('fee_per_qna', { precision: 10, scale: 2 }).default('25000').notNull(),
  rating: numeric('rating', { precision: 3, scale: 1 }).default('5.0'),
  reviewCount: integer('review_count').default(0).notNull(),
  verifiedCount: integer('verified_count').default(0).notNull(),
  isAvailable: boolean('is_available').default(true).notNull(),
  bio: text('bio'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('doctors_user_unique').on(table.userId),
]);

// ChatGPT-style Chat Room Sessions synced to cloud (optional cloud metadata for doctor reviews)
export const chatSessions = pgTable('chat_sessions', {
  id: serial('id').primaryKey(),
  uuid: varchar('uuid', { length: 64 }).notNull().unique(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Explicitly consented AI response reviews with 3-Tier Scope (Bubble, Session, History)
export const reviews = pgTable('reviews', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  doctorId: integer('doctor_id').references(() => doctors.id, { onDelete: 'cascade' }),
  claimedDoctorId: integer('claimed_doctor_id').references(() => doctors.id, { onDelete: 'set null' }),
  sessionId: integer('session_id').references(() => chatSessions.id, { onDelete: 'set null' }),
  reviewScope: varchar('review_scope', { length: 20 }).default('bubble').notNull(), // 'bubble' | 'session' | 'history'
  reviewType: varchar('review_type', { length: 20 }).default('paid').notNull(), // 'paid' | 'voluntary'
  requestStatus: varchar('request_status', { length: 30 }).default('accepted').notNull(), // 'open_pool' | 'permission_requested' | 'accepted' | 'declined'
  isPaid: boolean('is_paid').default(false).notNull(),
  qnaCount: integer('qna_count').default(1).notNull(),
  fee: numeric('fee', { precision: 10, scale: 2 }).default('0'),
  clientMessageId: integer('client_message_id'),
  patientQuestion: text('patient_question'),
  aiResponse: text('ai_response'),
  safetyLevel: varchar('safety_level', { length: 20 }).default('general'),
  patientNote: text('patient_note'),
  status: reviewStatusEnum('status').default('pending').notNull(),
  doctorNote: text('doctor_note'),
  doctorSummaryNote: text('doctor_summary_note'),
  consentedAt: timestamp('consented_at').defaultNow().notNull(),
  decidedAt: timestamp('decided_at'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Granular per-bubble review annotations for multi-chat reviews
export const reviewItems = pgTable('review_items', {
  id: serial('id').primaryKey(),
  reviewId: integer('review_id').references(() => reviews.id, { onDelete: 'cascade' }).notNull(),
  clientMessageId: integer('client_message_id').notNull(),
  patientQuestion: text('patient_question').notNull(),
  aiResponse: text('ai_response').notNull(),
  safetyLevel: varchar('safety_level', { length: 20 }).default('general').notNull(),
  doctorItemNote: text('doctor_item_note'),
  itemStatus: varchar('item_status', { length: 20 }).default('pending').notNull(), // 'pending' | 'approved' | 'revised'
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  doctor: one(doctors, { fields: [users.id], references: [doctors.userId] }),
  reviews: many(reviews),
  chatSessions: many(chatSessions),
}));

export const doctorsRelations = relations(doctors, ({ one, many }) => ({
  user: one(users, { fields: [doctors.userId], references: [users.id] }),
  reviews: many(reviews),
  claimedReviews: many(reviews),
}));

export const chatSessionsRelations = relations(chatSessions, ({ one, many }) => ({
  user: one(users, { fields: [chatSessions.userId], references: [users.id] }),
  reviews: many(reviews),
}));

export const reviewsRelations = relations(reviews, ({ one, many }) => ({
  user: one(users, { fields: [reviews.userId], references: [users.id] }),
  doctor: one(doctors, { fields: [reviews.doctorId], references: [doctors.id] }),
  claimedDoctor: one(doctors, { fields: [reviews.claimedDoctorId], references: [doctors.id] }),
  chatSession: one(chatSessions, { fields: [reviews.sessionId], references: [chatSessions.id] }),
  items: many(reviewItems),
}));

export const reviewItemsRelations = relations(reviewItems, ({ one }) => ({
  review: one(reviews, { fields: [reviewItems.reviewId], references: [reviews.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Doctor = typeof doctors.$inferSelect;
export type ChatSession = typeof chatSessions.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type ReviewItem = typeof reviewItems.$inferSelect;
