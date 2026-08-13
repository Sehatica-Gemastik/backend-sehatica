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
  unique,
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
export const askStatusEnum = pgEnum('ask_status', [
  'pending',
  'delivered',
  'replied',
  'expired',
  'dismissed',
]);
export const chatMessageRoleEnum = pgEnum('chat_message_role', ['user', 'doctor']);
export const safetyLevelEnum = pgEnum('safety_level', ['general', 'review', 'urgent']);
export const reviewScopeEnum = pgEnum('review_scope', ['bubble', 'session', 'history']);
export const reviewTypeEnum = pgEnum('review_type', ['paid', 'voluntary']);
export const requestStatusEnum = pgEnum('request_status', [
  'open_pool',
  'permission_requested',
  'accepted',
  'declined',
]);
export const reviewStatusEnum = pgEnum('review_status', ['pending', 'approved', 'revised']);
export const itemStatusEnum = pgEnum('item_status', ['pending', 'approved', 'revised']);

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
  conditions: text('conditions'),
  isPro: boolean('is_pro').default(false).notNull(),
  refreshToken: text('refresh_token'),
  age: integer('age'),
  sex: integer('sex'),
  raceEthnicity: integer('race_ethnicity'),
  education: integer('education'),
  incomePovertyRatio: numeric('income_poverty_ratio', { precision: 4, scale: 2 }),
  identityCompletedAt: timestamp('identity_completed_at'),
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
  bio: text('bio'),
  feePerQna: numeric('fee_per_qna', { precision: 12, scale: 2 }).default('25000').notNull(),
  rating: numeric('rating', { precision: 3, scale: 2 }).default('0').notNull(),
  reviewCount: integer('review_count').default(0).notNull(),
  verifiedCount: integer('verified_count').default(0).notNull(),
  isAvailable: boolean('is_available').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── User-Doctor relationships ──────────────────────────────────────────────
export const userDoctors = pgTable('user_doctors', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  doctorId: integer('doctor_id')
    .references(() => doctors.id, { onDelete: 'cascade' })
    .notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Log of medical record transfers from patient to partner doctor */
export const recordTransfers = pgTable('record_transfers', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  doctorId: integer('doctor_id')
    .references(() => doctors.id, { onDelete: 'cascade' })
    .notNull(),
  localRecordId: integer('local_record_id'),
  recordTitle: varchar('record_title', { length: 255 }).notNull(),
  fileName: varchar('file_name', { length: 255 }),
  byteSize: integer('byte_size').default(0).notNull(),
  transferMethod: varchar('transfer_method', { length: 32 }).default('bluetooth').notNull(),
  status: varchar('status', { length: 32 }).default('completed').notNull(),
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
  content: text('content'),
  summary: text('summary'),
  fileUrl: text('file_url'),
  fileKey: text('file_key'),
  tags: text('tags').array(),
  doctorName: varchar('doctor_name', { length: 255 }),
  recordDate: varchar('record_date', { length: 50 }),
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
  time: varchar('time', { length: 10 }).notNull(),
  done: boolean('done').default(false).notNull(),
  scheduleDate: varchar('schedule_date', { length: 20 }).notNull(),
  isAiGenerated: boolean('is_ai_generated').default(false).notNull(),
  colorScheme: varchar('color_scheme', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Mobile-synced daily compliance for RDSA filtering */
export const userDailyCompliance = pgTable(
  'user_daily_compliance',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    complianceDate: varchar('compliance_date', { length: 10 }).notNull(),
    dailyLogCount: integer('daily_log_count').default(0).notNull(),
    ptmScreeningDone: boolean('ptm_screening_done').default(false).notNull(),
    ptmFactorsJson: text('ptm_factors_json').default('[]').notNull(),
    dailyLogsJson: text('daily_logs_json').default('[]').notNull(),
    scheduleSnapshotJson: text('schedule_snapshot_json').default('[]').notNull(),
    pendingScheduleIntent: boolean('pending_schedule_intent').default(false).notNull(),
    syncedAt: timestamp('synced_at').defaultNow().notNull(),
  },
  (table) => ({
    userDateUnique: unique('user_daily_compliance_user_date').on(
      table.userId,
      table.complianceDate
    ),
  })
);

// ── RDSA notification arms ───────────────────────────────────────────────────
export const notificationArms = pgTable('notification_arms', {
  id: serial('id').primaryKey(),
  armId: varchar('arm_id', { length: 64 }).notNull().unique(),
  intent: varchar('intent', { length: 64 }).notNull(),
  channels: text('channels').array().notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body').notNull(),
  tone: varchar('tone', { length: 32 }),
  locale: varchar('locale', { length: 8 }).default('id').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const notificationEvents = pgTable('notification_events', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  armId: varchar('arm_id', { length: 64 }).notNull(),
  askId: varchar('ask_id', { length: 64 }),
  sentAt: timestamp('sent_at').defaultNow().notNull(),
  reward: numeric('reward', { precision: 4, scale: 2 }),
  rewardRecordedAt: timestamp('reward_recorded_at'),
  contextJson: text('context_json'),
});

export const notificationArmStatistics = pgTable('notification_arm_statistics', {
  armId: varchar('arm_id', { length: 64 }).primaryKey(),
  selectedCount: integer('selected_count').default(0).notNull(),
  selectedRewardSum: numeric('selected_reward_sum', { precision: 12, scale: 4 })
    .default('0')
    .notNull(),
  eligibleNotSelectedCount: integer('eligible_not_selected_count').default(0).notNull(),
  eligibleNotSelectedRewardSum: numeric('eligible_not_selected_reward_sum', {
    precision: 12,
    scale: 4,
  })
    .default('0')
    .notNull(),
  muPlus: numeric('mu_plus', { precision: 8, scale: 6 }).default('0.5').notNull(),
  muMinus: numeric('mu_minus', { precision: 8, scale: 6 }).default('0.5').notNull(),
  baseScore: numeric('base_score', { precision: 8, scale: 6 }).default('0').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** RDSA smart notification ask (push payload, no chat thread) */
export const rdsaAsks = pgTable('rdsa_asks', {
  id: varchar('id', { length: 64 }).primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  armId: varchar('arm_id', { length: 64 }).notNull(),
  intent: varchar('intent', { length: 64 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body').notNull(),
  status: askStatusEnum('status').default('pending').notNull(),
  channels: text('channels').array().notNull(),
  reward: numeric('reward', { precision: 4, scale: 2 }),
  deliveredAt: timestamp('delivered_at'),
  repliedAt: timestamp('replied_at'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Doctor chat (patient ↔ partner doctor) ─────────────────────────────────
export const doctorChatMessages = pgTable('doctor_chat_messages', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  doctorId: integer('doctor_id')
    .references(() => doctors.id, { onDelete: 'cascade' })
    .notNull(),
  role: chatMessageRoleEnum('role').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Doctor reviews (web portal) ────────────────────────────────────────────
export const reviews = pgTable('reviews', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  doctorId: integer('doctor_id').references(() => doctors.id, { onDelete: 'set null' }),
  patientQuestion: text('patient_question').notNull(),
  aiResponse: text('ai_response').notNull(),
  safetyLevel: safetyLevelEnum('safety_level').default('general').notNull(),
  patientNote: text('patient_note'),
  reviewScope: reviewScopeEnum('review_scope').default('bubble').notNull(),
  reviewType: reviewTypeEnum('review_type').default('voluntary').notNull(),
  requestStatus: requestStatusEnum('request_status').default('open_pool').notNull(),
  isPaid: boolean('is_paid').default(false).notNull(),
  qnaCount: integer('qna_count').default(1).notNull(),
  fee: numeric('fee', { precision: 12, scale: 2 }).default('0').notNull(),
  status: reviewStatusEnum('status').default('pending').notNull(),
  doctorNote: text('doctor_note'),
  doctorSummaryNote: text('doctor_summary_note'),
  consentedAt: timestamp('consented_at').defaultNow().notNull(),
  decidedAt: timestamp('decided_at'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const reviewItems = pgTable('review_items', {
  id: serial('id').primaryKey(),
  reviewId: integer('review_id')
    .references(() => reviews.id, { onDelete: 'cascade' })
    .notNull(),
  clientMessageId: integer('client_message_id').notNull(),
  patientQuestion: text('patient_question').notNull(),
  aiResponse: text('ai_response').notNull(),
  safetyLevel: safetyLevelEnum('safety_level').default('general').notNull(),
  doctorItemNote: text('doctor_item_note'),
  itemStatus: itemStatusEnum('item_status').default('pending').notNull(),
});

// ── Daily Insights ─────────────────────────────────────────────────────────
export const dailyInsights = pgTable('daily_insights', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  content: text('content').notNull(),
  insightDate: varchar('insight_date', { length: 20 }).notNull(),
  isVerified: boolean('is_verified').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Relations ──────────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ many, one }) => ({
  doctor: one(doctors, { fields: [users.id], references: [doctors.userId] }),
  medicalRecords: many(medicalRecords),
  schedules: many(schedules),
  dailyInsights: many(dailyInsights),
  userDoctors: many(userDoctors),
  rdsaAsks: many(rdsaAsks),
  notificationEvents: many(notificationEvents),
  reviews: many(reviews),
}));

export const doctorsRelations = relations(doctors, ({ one, many }) => ({
  user: one(users, { fields: [doctors.userId], references: [users.id] }),
  userDoctors: many(userDoctors),
  chatMessages: many(doctorChatMessages),
  reviews: many(reviews),
}));

export const userDoctorsRelations = relations(userDoctors, ({ one }) => ({
  user: one(users, { fields: [userDoctors.userId], references: [users.id] }),
  doctor: one(doctors, { fields: [userDoctors.doctorId], references: [doctors.id] }),
}));

export const medicalRecordsRelations = relations(medicalRecords, ({ one }) => ({
  user: one(users, { fields: [medicalRecords.userId], references: [users.id] }),
}));

export const schedulesRelations = relations(schedules, ({ one }) => ({
  user: one(users, { fields: [schedules.userId], references: [users.id] }),
}));

export const rdsaAsksRelations = relations(rdsaAsks, ({ one }) => ({
  user: one(users, { fields: [rdsaAsks.userId], references: [users.id] }),
}));

export const doctorChatMessagesRelations = relations(doctorChatMessages, ({ one }) => ({
  user: one(users, { fields: [doctorChatMessages.userId], references: [users.id] }),
  doctor: one(doctors, { fields: [doctorChatMessages.doctorId], references: [doctors.id] }),
}));

export const reviewsRelations = relations(reviews, ({ one, many }) => ({
  user: one(users, { fields: [reviews.userId], references: [users.id] }),
  doctor: one(doctors, { fields: [reviews.doctorId], references: [doctors.id] }),
  items: many(reviewItems),
}));

export const reviewItemsRelations = relations(reviewItems, ({ one }) => ({
  review: one(reviews, { fields: [reviewItems.reviewId], references: [reviews.id] }),
}));

// ── Type Exports ───────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Doctor = typeof doctors.$inferSelect;
export type MedicalRecord = typeof medicalRecords.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type DailyInsight = typeof dailyInsights.$inferSelect;
export type NotificationArm = typeof notificationArms.$inferSelect;
export type RdsaAsk = typeof rdsaAsks.$inferSelect;
export type DoctorChatMessage = typeof doctorChatMessages.$inferSelect;
export type RecordTransfer = typeof recordTransfers.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type ReviewItem = typeof reviewItems.$inferSelect;
