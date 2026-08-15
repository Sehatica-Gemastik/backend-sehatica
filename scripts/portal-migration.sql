-- Doctor portal tables (idempotent)
ALTER TABLE user_daily_compliance
  ADD COLUMN IF NOT EXISTS ptm_overall_score numeric(6, 4),
  ADD COLUMN IF NOT EXISTS ptm_scores_json text DEFAULT '{}' NOT NULL;

CREATE TABLE IF NOT EXISTS user_weekly_checkins (
  id serial PRIMARY KEY,
  user_id integer NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  weight_kg numeric(6, 2) NOT NULL,
  height_cm numeric(6, 2) NOT NULL,
  bmi numeric(5, 2) NOT NULL,
  waist_cm numeric(6, 2) NOT NULL,
  systolic_bp integer NOT NULL,
  diastolic_bp integer NOT NULL,
  completed_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS user_daily_questionnaires (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  questionnaire_date varchar(10) NOT NULL,
  payload_json text NOT NULL,
  ai_summary text,
  completed_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT user_daily_questionnaires_user_date UNIQUE (user_id, questionnaire_date)
);

CREATE TABLE IF NOT EXISTS doctor_appointments (
  id serial PRIMARY KEY,
  doctor_id integer NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  patient_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title varchar(255) NOT NULL,
  notes text DEFAULT '' NOT NULL,
  start_at timestamp NOT NULL,
  end_at timestamp NOT NULL,
  status varchar(32) DEFAULT 'scheduled' NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS doctor_appointments_doctor_idx ON doctor_appointments(doctor_id);
CREATE INDEX IF NOT EXISTS doctor_appointments_patient_idx ON doctor_appointments(patient_id);
