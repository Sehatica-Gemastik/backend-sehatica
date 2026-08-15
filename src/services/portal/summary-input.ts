type RawPayload = Record<string, unknown>;

export type ActivityLevel = 'low' | 'moderate' | 'high';
export type DietTag = 'balanced' | 'high_sugar' | 'high_sodium' | 'high_calorie' | 'unknown';
export type AlcoholLevel = 'none' | 'occasionally' | 'regular';
export type RiskBand = 'low' | 'moderate' | 'high';

export type CompactHealthSummaryInput = {
  demographic: {
    age?: number;
    sex?: 'male' | 'female' | 'unknown';
  };
  lifestyle: {
    activity: ActivityLevel;
    sedentary_hours: number;
    diet: DietTag | DietTag[];
    alcohol: AlcoholLevel;
    smoking?: boolean;
  };
  anthropometric?: {
    bmi?: number;
    waist?: number;
    systolic_bp?: number;
    diastolic_bp?: number;
  };
  risk?: {
    diabetes?: RiskBand;
    hypertension?: RiskBand;
    heart_disease?: RiskBand;
    stroke?: RiskBand;
    overall?: RiskBand;
  };
};

export type CompactDailyDeltaInput = {
  today: {
    activity_minutes: number;
    sedentary_hours: number;
    calories?: number;
    sugar_g?: number;
    sodium_mg?: number;
  };
  previous: {
    activity_minutes: number;
    sedentary_hours: number;
    calories?: number;
    sugar_g?: number;
    sodium_mg?: number;
  };
};

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNum(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function activityLevel(minutes: number): ActivityLevel {
  if (minutes >= 60) return 'high';
  if (minutes >= 30) return 'moderate';
  return 'low';
}

export function riskBand(score: number): RiskBand {
  if (score >= 0.65) return 'high';
  if (score >= 0.4) return 'moderate';
  return 'low';
}

function mapSex(value: unknown): 'male' | 'female' | 'unknown' {
  const sex = num(value);
  if (sex === 1) return 'male';
  if (sex === 2) return 'female';
  return 'unknown';
}

function mapAlcohol(payload: RawPayload): AlcoholLevel {
  const ever = num(payload.alcohol_ever ?? payload.alcoholEver);
  if (ever === 0) return 'none';

  const freq = num(payload.alcohol_frequency ?? payload.alcoholFrequency, -1);
  if ([6, 7, 10, 0].includes(freq)) return 'occasionally';
  if ([1, 3, 4, 5].includes(freq)) return 'regular';
  return 'occasionally';
}

function mapDiet(payload: RawPayload): DietTag | DietTag[] {
  const calories = num(payload.calories_day1 ?? payload.caloriesDay1);
  const sugar = num(payload.sugar_g_day1 ?? payload.sugarGDay1);
  const sodium = num(payload.sodium_mg_day1 ?? payload.sodiumMgDay1);
  const tags: DietTag[] = [];

  if (calories <= 0 && sugar <= 0 && sodium <= 0) return 'unknown';
  if (sugar >= 50 || (calories > 0 && sugar / calories > 0.12)) tags.push('high_sugar');
  if (sodium >= 2300) tags.push('high_sodium');
  if (calories >= 2200) tags.push('high_calorie');
  if (tags.length === 0) return 'balanced';
  return tags.length === 1 ? tags[0] : tags;
}

function sedentaryHours(payload: RawPayload): number {
  const minutes = num(payload.sedentary_minutes ?? payload.sedentaryMinutes);
  if (minutes > 0) return Math.round((minutes / 60) * 10) / 10;
  const hours = num(payload.sedentary_hours ?? payload.sedentaryHours);
  return hours > 0 ? hours : 0;
}

function activityMinutes(payload: RawPayload): number {
  return num(payload.total_activity_minutes ?? payload.totalActivityMinutes);
}

export function buildCompactHealthInput(
  payload: RawPayload,
  context: {
    age?: number | null;
    sex?: number | null;
    weekly?: {
      bmi?: number;
      waist_cm?: number;
      systolic_bp?: number;
      diastolic_bp?: number;
    } | null;
    ptmScores?: {
      overall?: number;
      diabetes?: number;
      hypertension?: number;
      heart_disease?: number;
      stroke?: number;
    } | null;
  },
): CompactHealthSummaryInput {
  const activityMinutesValue = activityMinutes(payload);
  const input: CompactHealthSummaryInput = {
    demographic: {
      age: context.age ?? undefined,
      sex: mapSex(context.sex),
    },
    lifestyle: {
      activity: activityLevel(activityMinutesValue),
      sedentary_hours: sedentaryHours(payload),
      diet: mapDiet(payload),
      alcohol: mapAlcohol(payload),
      smoking: false,
    },
  };

  if (context.weekly) {
    input.anthropometric = {
      bmi: context.weekly.bmi,
      waist: context.weekly.waist_cm,
      systolic_bp: context.weekly.systolic_bp,
      diastolic_bp: context.weekly.diastolic_bp,
    };
  }

  if (context.ptmScores) {
    input.risk = {
      overall: context.ptmScores.overall != null ? riskBand(context.ptmScores.overall) : undefined,
      diabetes: context.ptmScores.diabetes != null ? riskBand(context.ptmScores.diabetes) : undefined,
      hypertension: context.ptmScores.hypertension != null
        ? riskBand(context.ptmScores.hypertension)
        : undefined,
      heart_disease: context.ptmScores.heart_disease != null
        ? riskBand(context.ptmScores.heart_disease)
        : undefined,
      stroke: context.ptmScores.stroke != null ? riskBand(context.ptmScores.stroke) : undefined,
    };
  }

  return input;
}

export function buildCompactDailyDelta(
  today: RawPayload,
  previous: RawPayload,
): CompactDailyDeltaInput {
  return {
    today: {
      activity_minutes: activityMinutes(today),
      sedentary_hours: sedentaryHours(today),
      calories: optionalNum(today.calories_day1 ?? today.caloriesDay1),
      sugar_g: optionalNum(today.sugar_g_day1 ?? today.sugarGDay1),
      sodium_mg: optionalNum(today.sodium_mg_day1 ?? today.sodiumMgDay1),
    },
    previous: {
      activity_minutes: activityMinutes(previous),
      sedentary_hours: sedentaryHours(previous),
      calories: optionalNum(previous.calories_day1 ?? previous.caloriesDay1),
      sugar_g: optionalNum(previous.sugar_g_day1 ?? previous.sugarGDay1),
      sodium_mg: optionalNum(previous.sodium_mg_day1 ?? previous.sodiumMgDay1),
    },
  };
}

export function buildFallbackSummary(payload: RawPayload): string {
  const activity = activityMinutes(payload);
  const sedentary = sedentaryHours(payload);
  const calories = num(payload.calories_day1 ?? payload.caloriesDay1);

  if (activity <= 0 && sedentary <= 0 && calories <= 0) {
    return 'Kuisioner harian tercatat. Isi LLM_API_KEY dan LLM_MODEL di backend untuk ringkasan AI.';
  }

  const parts: string[] = [];
  if (activity >= 60) parts.push('aktivitas cukup baik');
  else if (activity > 0) parts.push('aktivitas masih rendah');
  if (sedentary >= 8) parts.push('waktu duduk relatif tinggi');
  if (calories > 0) parts.push(`asupan kalori sekitar ${Math.round(calories)} kkal`);

  return `Ringkasan harian: ${parts.join(', ')}.`;
}

export function buildFallbackDailyDelta(delta: CompactDailyDeltaInput): string {
  const actDiff = delta.today.activity_minutes - delta.previous.activity_minutes;
  const sedDiff = delta.today.sedentary_hours - delta.previous.sedentary_hours;

  if (actDiff > 5) {
    return 'Aktivitas fisik hari ini sedikit lebih baik dari sebelumnya. Pertahankan pola ini.';
  }
  if (actDiff < -5) {
    return 'Aktivitas fisik hari ini menurun dibanding sebelumnya. Coba sisihkan waktu bergerak singkat.';
  }
  if (sedDiff > 1) {
    return 'Waktu duduk hari ini meningkat. Coba interupsi dengan jeda berdiri atau jalan singkat.';
  }
  return 'Pola harian relatif stabil dibanding hari sebelumnya.';
}
