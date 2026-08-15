import { buildFallbackSummary } from './summary-input';

type RawQuestionnaire = Record<string, unknown>;

function num(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown) {
  return typeof value === 'string' ? value : '';
}

export type PortalDailyQuestionnaireLog = {
  date: string;
  completedAt: string;
  vigorousWork: number;
  vigorousWorkDays: number;
  vigorousWorkMinutes: number;
  moderateWork: number;
  moderateWorkDays: number;
  moderateWorkMinutes: number;
  transportWalkingBiking: number;
  transportDays: number;
  transportMinutes: number;
  vigorousRecreation: number;
  vigorousRecreationDays: number;
  vigorousRecreationMinutes: number;
  moderateRecreation: number;
  moderateRecreationDays: number;
  moderateRecreationMinutes: number;
  sedentaryMinutes: number;
  totalActivityMinutes: number;
  caloriesDay1: number;
  proteinGDay1: number;
  carbohydrateGDay1: number;
  sugarGDay1: number;
  totalFatGDay1: number;
  saturatedFatGDay1: number;
  sodiumMgDay1: number;
  fiberGDay1: number;
  cholesterolMgDay1: number;
  alcoholEver: number;
  alcoholFrequency: number | null;
  alcoholDrinksPerDay: number | null;
  alcoholBingeFrequency: number | null;
  mealsCount: number;
  aiSummary: string;
};

export function mapQuestionnairePayload(
  date: string,
  payload: RawQuestionnaire,
  aiSummary: string | null,
  completedAt: Date,
): PortalDailyQuestionnaireLog {
  const meals = Array.isArray(payload.meals) ? payload.meals : [];
  const sedentaryHours = num(payload.sedentary_hours ?? payload.sedentaryHours);
  const sedentaryMinutes = num(
    payload.sedentary_minutes ?? payload.sedentaryMinutes,
    sedentaryHours > 0 ? sedentaryHours * 60 : 0,
  );

  return {
    date,
    completedAt: completedAt.toISOString(),
    vigorousWork: num(payload.vigorous_work ?? payload.vigorousWork),
    vigorousWorkDays: num(payload.vigorous_work_days ?? payload.vigorousWorkDays),
    vigorousWorkMinutes: num(payload.vigorous_work_minutes ?? payload.vigorousWorkMinutes),
    moderateWork: num(payload.moderate_work ?? payload.moderateWork),
    moderateWorkDays: num(payload.moderate_work_days ?? payload.moderateWorkDays),
    moderateWorkMinutes: num(payload.moderate_work_minutes ?? payload.moderateWorkMinutes),
    transportWalkingBiking: num(payload.transport_walking_biking ?? payload.transportWalkingBiking),
    transportDays: num(payload.transport_days ?? payload.transportDays),
    transportMinutes: num(payload.transport_minutes ?? payload.transportMinutes),
    vigorousRecreation: num(payload.vigorous_recreation ?? payload.vigorousRecreation),
    vigorousRecreationDays: num(payload.vigorous_recreation_days ?? payload.vigorousRecreationDays),
    vigorousRecreationMinutes: num(payload.vigorous_recreation_minutes ?? payload.vigorousRecreationMinutes),
    moderateRecreation: num(payload.moderate_recreation ?? payload.moderateRecreation),
    moderateRecreationDays: num(payload.moderate_recreation_days ?? payload.moderateRecreationDays),
    moderateRecreationMinutes: num(payload.moderate_recreation_minutes ?? payload.moderateRecreationMinutes),
    sedentaryMinutes,
    totalActivityMinutes: num(payload.total_activity_minutes ?? payload.totalActivityMinutes),
    caloriesDay1: num(payload.calories_day1 ?? payload.caloriesDay1),
    proteinGDay1: num(payload.protein_g_day1 ?? payload.proteinGDay1),
    carbohydrateGDay1: num(payload.carbohydrate_g_day1 ?? payload.carbohydrateGDay1),
    sugarGDay1: num(payload.sugar_g_day1 ?? payload.sugarGDay1),
    totalFatGDay1: num(payload.total_fat_g_day1 ?? payload.totalFatGDay1),
    saturatedFatGDay1: num(payload.saturated_fat_g_day1 ?? payload.saturatedFatGDay1),
    sodiumMgDay1: num(payload.sodium_mg_day1 ?? payload.sodiumMgDay1),
    fiberGDay1: num(payload.fiber_g_day1 ?? payload.fiberGDay1),
    cholesterolMgDay1: num(payload.cholesterol_mg_day1 ?? payload.cholesterolMgDay1),
    alcoholEver: num(payload.alcohol_ever ?? payload.alcoholEver),
    alcoholFrequency: payload.alcohol_frequency != null || payload.alcoholFrequency != null
      ? num(payload.alcohol_frequency ?? payload.alcoholFrequency)
      : null,
    alcoholDrinksPerDay: payload.alcohol_drinks_per_day != null || payload.alcoholDrinksPerDay != null
      ? num(payload.alcohol_drinks_per_day ?? payload.alcoholDrinksPerDay)
      : null,
    alcoholBingeFrequency: payload.alcohol_binge_frequency != null || payload.alcoholBingeFrequency != null
      ? num(payload.alcohol_binge_frequency ?? payload.alcoholBingeFrequency)
      : null,
    mealsCount: meals.length,
    aiSummary: aiSummary ?? (str(payload.aiSummary) || 'Ringkasan AI belum tersedia untuk kuisioner harian ini.'),
  };
}

export function buildAiSummaryFromPayload(payload: RawQuestionnaire): string {
  return buildFallbackSummary(payload);
}
