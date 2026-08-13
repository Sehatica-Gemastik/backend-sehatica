import { readFileSync } from 'fs';
import { join } from 'path';

type PtmModel = {
  algorithm: string;
  feature_set: 'lifestyle' | 'clinical';
  target: string;
  threshold: number;
  bias: number;
  weights: number[];
  feature_columns: string[];
  preprocessing: {
    numeric_features: string[];
    numeric_imputer_medians: Record<string, number>;
    numeric_scaler: {
      means: Record<string, number>;
      stds: Record<string, number>;
    };
    categorical_features: string[];
    categorical_one_hot: {
      fitted_categories: Record<string, string[]>;
      missing_bucket: string;
      unknown_bucket: string;
    };
    categorical_feature_to_category_to_feature_index: Record<string, Record<string, number>>;
  };
};

export type PtmTarget = 'diabetes' | 'hypertension' | 'heart_disease' | 'stroke';
export type PtmFeatureSet = 'lifestyle' | 'clinical';

export type RiskScore = {
  target: PtmTarget;
  probability: number;
  isAtRisk: boolean;
  threshold: number;
};

export type PtmRiskResult = {
  featureSet: PtmFeatureSet;
  overallScore: number;
  overallIsAtRisk: boolean;
  dataComplete: boolean;
  risks: RiskScore[];
};

const TARGETS: PtmTarget[] = ['diabetes', 'hypertension', 'heart_disease', 'stroke'];

const modelCache = new Map<string, PtmModel>();

function loadModel(featureSet: PtmFeatureSet, target: PtmTarget): PtmModel {
  const key = `${featureSet}/${target}`;
  const cached = modelCache.get(key);
  if (cached) return cached;

  const filePath = join(__dirname, 'models', featureSet, `${target}.json`);
  const model = JSON.parse(readFileSync(filePath, 'utf-8')) as PtmModel;
  modelCache.set(key, model);
  return model;
}

function sigmoid(x: number): number {
  const clamped = Math.max(-50, Math.min(50, x));
  return 1.0 / (1.0 + Math.exp(-clamped));
}

function preprocessAndPredict(model: PtmModel, rawFeatures: Record<string, number | null>): number {
  const { preprocessing, weights, bias, feature_columns } = model;
  const vector = new Array<number>(feature_columns.length).fill(0);

  for (const col of preprocessing.numeric_features) {
    const idx = feature_columns.indexOf(col);
    if (idx === -1) continue;

    let value = rawFeatures[col] ?? null;
    if (value === null || value === undefined || !Number.isFinite(value)) {
      value = preprocessing.numeric_imputer_medians[col] ?? 0;
    }

    const mean = preprocessing.numeric_scaler.means[col] ?? 0;
    const std = preprocessing.numeric_scaler.stds[col] ?? 1;
    vector[idx] = std > 0 ? (value - mean) / std : 0;
  }

  const { categorical_feature_to_category_to_feature_index, categorical_one_hot } = preprocessing;
  for (const col of preprocessing.categorical_features) {
    const rawValue = rawFeatures[col];
    const categoryStr = rawValue !== null && rawValue !== undefined
      ? String(rawValue)
      : categorical_one_hot.missing_bucket;

    const mapping = categorical_feature_to_category_to_feature_index[col];
    if (!mapping) continue;

    const idx = mapping[categoryStr] ?? mapping[categorical_one_hot.unknown_bucket];
    if (idx !== undefined) {
      vector[idx] = 1;
    }
  }

  let logit = bias;
  for (let i = 0; i < weights.length; i++) {
    logit += weights[i] * vector[i];
  }

  return sigmoid(logit);
}

export type PtmInputFeatures = {
  age: number;
  sex: number;
  race_ethnicity: number;
  education: number;
  income_poverty_ratio: number;

  calories_day1?: number | null;
  protein_g_day1?: number | null;
  carbohydrate_g_day1?: number | null;
  sugar_g_day1?: number | null;
  total_fat_g_day1?: number | null;
  saturated_fat_g_day1?: number | null;
  sodium_mg_day1?: number | null;
  fiber_g_day1?: number | null;
  cholesterol_mg_day1?: number | null;
  alcohol_g_day1?: number | null;

  vigorous_work?: number;
  vigorous_work_days?: number;
  vigorous_work_minutes?: number;
  moderate_work?: number;
  moderate_work_days?: number;
  moderate_work_minutes?: number;
  transport_walking_biking?: number;
  transport_days?: number;
  transport_minutes?: number;
  vigorous_recreation?: number;
  vigorous_recreation_days?: number;
  vigorous_recreation_minutes?: number;
  moderate_recreation?: number;
  moderate_recreation_days?: number;
  moderate_recreation_minutes?: number;
  sedentary_minutes?: number;

  vigorous_work_est_met?: number;
  moderate_work_est_met?: number;
  transport_walking_biking_est_met?: number;
  vigorous_recreation_est_met?: number;
  moderate_recreation_est_met?: number;
  work_total_minutes?: number;
  recreation_total_minutes?: number;
  vigorous_total_minutes?: number;
  moderate_total_minutes?: number;
  total_activity_minutes?: number;
  total_activity_est_met?: number;

  alcohol_ever?: number;
  alcohol_frequency?: number;
  alcohol_drinks_per_day?: number;
  alcohol_binge_frequency?: number;

  weight_kg?: number | null;
  height_cm?: number | null;
  bmi?: number | null;
  waist_cm?: number | null;
  systolic_bp?: number | null;
  diastolic_bp?: number | null;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPtmInputComplete(input: Partial<PtmInputFeatures>): boolean {
  if (!isFiniteNumber(input.age) || !isFiniteNumber(input.sex)) return false;
  if (!isFiniteNumber(input.race_ethnicity) || !isFiniteNumber(input.education)) return false;
  if (!isFiniteNumber(input.income_poverty_ratio)) return false;
  if (!isFiniteNumber(input.sedentary_minutes)) return false;
  if (!isFiniteNumber(input.vigorous_work)) return false;
  if (!isFiniteNumber(input.calories_day1) || input.calories_day1 < 0) return false;
  return true;
}

function emptyPtmRiskResult(featureSet: PtmFeatureSet = 'lifestyle'): PtmRiskResult {
  return {
    featureSet,
    overallScore: 0,
    overallIsAtRisk: false,
    dataComplete: false,
    risks: TARGETS.map((target) => ({
      target,
      probability: 0,
      isAtRisk: false,
      threshold: 0,
    })),
  };
}

function hasClinicData(input: PtmInputFeatures): boolean {
  return (
    input.weight_kg != null &&
    input.height_cm != null &&
    input.waist_cm != null
  );
}

const NUTRITION_KEYS = new Set([
  'calories_day1', 'protein_g_day1', 'carbohydrate_g_day1', 'sugar_g_day1',
  'total_fat_g_day1', 'saturated_fat_g_day1', 'sodium_mg_day1',
  'fiber_g_day1', 'cholesterol_mg_day1', 'alcohol_g_day1',
]);

function toRawMap(input: PtmInputFeatures): Record<string, number | null> {
  const map: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) {
      map[key] = null;
      continue;
    }
    const n = value as number;
    if (NUTRITION_KEYS.has(key) && n < 0) {
      map[key] = null;
      continue;
    }
    map[key] = n;
  }
  return map;
}

export function predictPtmRisk(input: Partial<PtmInputFeatures>): PtmRiskResult {
  const featureSet: PtmFeatureSet = hasClinicData(input as PtmInputFeatures) ? 'clinical' : 'lifestyle';

  if (!isPtmInputComplete(input)) {
    return emptyPtmRiskResult(featureSet);
  }

  const rawMap = toRawMap(input as PtmInputFeatures);

  const risks: RiskScore[] = TARGETS.map((target) => {
    const model = loadModel(featureSet, target);
    const probability = preprocessAndPredict(model, rawMap);
    return {
      target,
      probability: Math.round(probability * 1000) / 1000,
      isAtRisk: probability >= model.threshold,
      threshold: model.threshold,
    };
  });

  const avg = risks.reduce((sum, r) => sum + r.probability, 0) / risks.length;
  const overallScore = Math.round(avg * 1000) / 1000;

  return {
    featureSet,
    overallScore,
    overallIsAtRisk: risks.some((r) => r.isAtRisk),
    dataComplete: true,
    risks,
  };
}
