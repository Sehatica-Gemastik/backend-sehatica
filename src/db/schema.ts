import {
  pgTable,
  serial,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  numeric,
  pgEnum,
  uuid,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ── Enums ──────────────────────────────────────────────────────────────────
export const userRoleEnum = pgEnum('user_role', ['user', 'doctor', 'admin']);
export const recordTypeEnum = pgEnum('record_type', [
  'consultation',
  'image',
  'voice',
  'note',
]);
export const scheduleTypeEnum = pgEnum('schedule_type', [
  'food',
  'pill',
  'exercise',
  'water',
  'other',
]);
export const verifStatusEnum = pgEnum('verif_status', [
  'pending',
  'approved',
  'revised',
]);
export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant']);

// ── Users ──────────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: userRoleEnum('role').default('user').notNull(),
  avatarInitials: varchar('avatar_initials', { length: 5 }),
  phone: varchar('phone', { length: 20 }),
  dateOfBirth: varchar('date_of_birth', { length: 20 }),
  bloodType: varchar('blood_type', { length: 5 }),
  allergies: text('allergies'),
  conditions: text('conditions'), // e.g. Hipertensi, Diabetes
  isPro: boolean('is_pro').default(false).notNull(),
  refreshToken: text('refresh_token'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── Doctors ────────────────────────────────────────────────────────────────
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
});

// ── User-Doctor relationships (patient-doctor) ─────────────────────────────
export const userDoctors = pgTable('user_doctors', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  doctorId: integer('doctor_id')
    .references(() => doctors.id, { onDelete: 'cascade' })
    .notNull(),
  isPrimary: boolean('is_primary').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Medical Records ────────────────────────────────────────────────────────
export const medicalRecords = pgTable('medical_records', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  type: recordTypeEnum('type').notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content'), // text note or OCR result
  summary: text('summary'), // AI-generated summary
  fileUrl: text('file_url'), // for image/voice records
  fileKey: text('file_key'), // storage key
  tags: text('tags').array(), // e.g. ['Hipertensi', 'Jantung']
  doctorName: varchar('doctor_name', { length: 255 }),
  recordDate: varchar('record_date', { length: 50 }), // user-provided date string
  isAiSummarized: boolean('is_ai_summarized').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── Schedule Items ─────────────────────────────────────────────────────────
export const schedules = pgTable('schedules', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  type: scheduleTypeEnum('type').notNull(),
  label: varchar('label', { length: 255 }).notNull(),
  detail: varchar('detail', { length: 500 }),
  time: varchar('time', { length: 10 }).notNull(), // "07:00"
  done: boolean('done').default(false).notNull(),
  scheduleDate: varchar('schedule_date', { length: 20 }).notNull(), // "2026-08-04"
  isAiGenerated: boolean('is_ai_generated').default(false).notNull(),
  colorScheme: varchar('color_scheme', { length: 50 }), // e.g. "blue"
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Heally Chat Messages ───────────────────────────────────────────────────
export const chatMessages = pgTable('chat_messages', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  role: messageRoleEnum('role').notNull(),
  content: text('content').notNull(),
  needsVerif: boolean('needs_verif').default(false).notNull(),
  verifStatus: verifStatusEnum('verif_status'),
  verifDoctorId: integer('verif_doctor_id').references(() => doctors.id),
  verifNote: text('verif_note'),
  verifDoctorName: varchar('verif_doctor_name', { length: 255 }),
  fromWhatsApp: boolean('from_whatsapp').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Verification Requests ──────────────────────────────────────────────────
export const verifRequests = pgTable('verif_requests', {
  id: serial('id').primaryKey(),
  messageId: integer('message_id').references(() => chatMessages.id),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  doctorId: integer('doctor_id').references(() => doctors.id),
  userQuestion: text('user_question').notNull(),
  aiAnswer: text('ai_answer').notNull(),
  status: verifStatusEnum('status').default('pending').notNull(),
  doctorNote: text('doctor_note'),
  doctorName: varchar('doctor_name', { length: 255 }),
  reviewedAt: timestamp('reviewed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── Daily Insights ─────────────────────────────────────────────────────────
export const dailyInsights = pgTable('daily_insights', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  content: text('content').notNull(), // AI-generated insight JSON
  insightDate: varchar('insight_date', { length: 20 }).notNull(),
  isVerified: boolean('is_verified').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Relations ──────────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ many, one }) => ({
  doctor: one(doctors, { fields: [users.id], references: [doctors.userId] }),
  medicalRecords: many(medicalRecords),
  schedules: many(schedules),
  chatMessages: many(chatMessages),
  verifRequests: many(verifRequests),
  dailyInsights: many(dailyInsights),
  userDoctors: many(userDoctors),
}));

export const doctorsRelations = relations(doctors, ({ one, many }) => ({
  user: one(users, { fields: [doctors.userId], references: [users.id] }),
  verifRequests: many(verifRequests),
  userDoctors: many(userDoctors),
}));

export const medicalRecordsRelations = relations(medicalRecords, ({ one }) => ({
  user: one(users, { fields: [medicalRecords.userId], references: [users.id] }),
}));

export const schedulesRelations = relations(schedules, ({ one }) => ({
  user: one(users, { fields: [schedules.userId], references: [users.id] }),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  user: one(users, { fields: [chatMessages.userId], references: [users.id] }),
  verifDoctor: one(doctors, {
    fields: [chatMessages.verifDoctorId],
    references: [doctors.id],
  }),
}));

export const verifRequestsRelations = relations(verifRequests, ({ one }) => ({
  user: one(users, { fields: [verifRequests.userId], references: [users.id] }),
  doctor: one(doctors, {
    fields: [verifRequests.doctorId],
    references: [doctors.id],
  }),
  message: one(chatMessages, {
    fields: [verifRequests.messageId],
    references: [chatMessages.id],
  }),
}));

// ── Type Exports ───────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Doctor = typeof doctors.$inferSelect;
export type MedicalRecord = typeof medicalRecords.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type VerifRequest = typeof verifRequests.$inferSelect;
export type DailyInsight = typeof dailyInsights.$inferSelect;
