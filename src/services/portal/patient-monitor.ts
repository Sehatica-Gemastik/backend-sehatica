import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  medicalRecords,
  recordTransfers,
  userDailyCompliance,
  userDailyQuestionnaires,
  userDoctors,
  users,
  userWeeklyCheckins,
} from '../../db/schema';
import { getDoctorByUserId } from './doctor-context';
import { mapQuestionnairePayload } from './questionnaire-mapper';

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function clampScore(value: number, max = 1) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(max, value);
}

function hasPtmScore(row: {
  ptmOverallScore?: string | null;
  ptmScoresJson?: string | null;
} | null | undefined): boolean {
  if (!row) return false;
  if (row.ptmOverallScore != null && Number(row.ptmOverallScore) > 0) return true;
  const scores = parsePtmScores(row.ptmScoresJson);
  return (
    scores.overall > 0
    || scores.diabetes > 0
    || scores.hypertension > 0
    || scores.heart_disease > 0
    || scores.stroke > 0
  );
}

function parsePtmScores(json: string | null | undefined) {
  try {
    const parsed = JSON.parse(json ?? '{}') as Record<string, number>;
    return {
      overall: Number(parsed.overall ?? 0),
      diabetes: Number(parsed.diabetes ?? 0),
      hypertension: Number(parsed.hypertension ?? 0),
      heart_disease: Number(parsed.heart_disease ?? 0),
      stroke: Number(parsed.stroke ?? 0),
    };
  } catch {
    return { overall: 0, diabetes: 0, hypertension: 0, heart_disease: 0, stroke: 0 };
  }
}

export async function listPartnerPatients(doctorUserId: number) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) return [];

  const links = await db.query.userDoctors.findMany({
    where: eq(userDoctors.doctorId, doctor.id),
    with: { user: true },
    orderBy: [desc(userDoctors.createdAt)],
  });

  const patients = await Promise.all(
    links.map(async (link) => {
      const user = link.user;
      if (!user) return null;

      const complianceRows = await db.query.userDailyCompliance.findMany({
        where: eq(userDailyCompliance.userId, user.id),
        orderBy: [desc(userDailyCompliance.complianceDate)],
      });
      const latestCompliance = complianceRows.find((row) => hasPtmScore(row));

      const scores = parsePtmScores(latestCompliance?.ptmScoresJson);
      const overall = latestCompliance
        ? Number(latestCompliance.ptmOverallScore ?? scores.overall ?? 0)
        : 0;

      return {
        id: user.id,
        name: user.name,
        avatarInitials: user.avatarInitials ?? user.name.slice(0, 2).toUpperCase(),
        age: user.age,
        lastSyncAt: latestCompliance?.syncedAt?.toISOString() ?? null,
        overallRiskScore: overall,
      };
    }),
  );

  return patients.filter((patient): patient is NonNullable<typeof patient> => patient != null);
}

export async function getPatientMonitorDetail(doctorUserId: number, patientUserId: number) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) return null;

  const link = await db.query.userDoctors.findFirst({
    where: and(eq(userDoctors.doctorId, doctor.id), eq(userDoctors.userId, patientUserId)),
    with: { user: true },
  });
  if (!link?.user) return null;

  const user = link.user;
  const fromDate = daysAgo(364);

  const [weekly, complianceRows, questionnaires, records, transfers] = await Promise.all([
    db.query.userWeeklyCheckins.findFirst({ where: eq(userWeeklyCheckins.userId, user.id) }),
    db.query.userDailyCompliance.findMany({
      where: and(
        eq(userDailyCompliance.userId, user.id),
        gte(userDailyCompliance.complianceDate, fromDate),
      ),
      orderBy: [userDailyCompliance.complianceDate],
    }),
    db.query.userDailyQuestionnaires.findMany({
      where: and(
        eq(userDailyQuestionnaires.userId, user.id),
        gte(userDailyQuestionnaires.questionnaireDate, fromDate),
      ),
    }),
    db.query.medicalRecords.findMany({
      where: eq(medicalRecords.userId, user.id),
      orderBy: [desc(medicalRecords.createdAt)],
      limit: 20,
    }),
    db.query.recordTransfers.findMany({
      where: and(
        eq(recordTransfers.userId, user.id),
        eq(recordTransfers.doctorId, doctor.id),
      ),
      orderBy: [desc(recordTransfers.createdAt)],
      limit: 20,
    }),
  ]);

  const questionnaireByDate = new Map(
    questionnaires.map((row) => [row.questionnaireDate, row]),
  );
  const complianceByDate = new Map(
    complianceRows.map((row) => [row.complianceDate, row]),
  );

  const questionnaireDays = Array.from({ length: 365 }, (_, index) => {
    const offset = 364 - index;
    const date = daysAgo(offset);
    const questionnaire = questionnaireByDate.get(date);
    const compliance = complianceByDate.get(date);
    const filled = Boolean(questionnaire) || Boolean(compliance?.ptmScreeningDone);
    const logCount = questionnaire ? 3 : Math.min(4, Math.max(1, compliance?.dailyLogCount ?? 0));
    const intensity = filled ? (logCount as 1 | 2 | 3 | 4) : 0;

    return { date, filled, intensity: intensity as 0 | 1 | 2 | 3 | 4 };
  });

  const latestCompliance = [...complianceRows].reverse().find((row) => hasPtmScore(row));
  const latestScores = parsePtmScores(latestCompliance?.ptmScoresJson);
  const latestOverall = latestCompliance
    ? Number(latestCompliance.ptmOverallScore ?? latestScores.overall ?? 0)
    : 0;

  const ptmTrend = Array.from({ length: 365 }, (_, index) => {
    const offset = 364 - index;
    const date = daysAgo(offset);
    const row = complianceByDate.get(date);
    if (!hasPtmScore(row)) {
      return {
        date,
        overall: 0,
        diabetes: 0,
        hypertension: 0,
        heart_disease: 0,
        stroke: 0,
      };
    }

    const scores = parsePtmScores(row!.ptmScoresJson);
    const overall = Number(row!.ptmOverallScore ?? scores.overall ?? 0);

    return {
      date,
      overall: clampScore(overall),
      diabetes: clampScore(scores.diabetes),
      hypertension: clampScore(scores.hypertension),
      heart_disease: clampScore(scores.heart_disease),
      stroke: clampScore(scores.stroke),
    };
  });

  const monitorRecords = [
    ...transfers.map((row) => ({
      id: row.id,
      title: row.recordTitle,
      type: 'transfer',
      recordDate: row.createdAt.toISOString().slice(0, 10),
      summary: `Transfer ${row.transferMethod} · ${row.fileName ?? 'dokumen'}`,
      source: 'transfer' as const,
      createdAt: row.createdAt.toISOString(),
    })),
    ...records.map((row) => ({
      id: row.id + 100000,
      title: row.title,
      type: row.type,
      recordDate: row.recordDate,
      summary: row.summary,
      source: 'record' as const,
      createdAt: row.createdAt.toISOString(),
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const dailyLogs: Record<string, ReturnType<typeof mapQuestionnairePayload>> = {};
  for (const row of questionnaires) {
    try {
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      dailyLogs[row.questionnaireDate] = mapQuestionnairePayload(
        row.questionnaireDate,
        payload,
        row.aiSummary,
        row.completedAt,
      );
    } catch {
      // skip invalid json
    }
  }

  return {
    id: user.id,
    name: user.name,
    avatarInitials: user.avatarInitials ?? user.name.slice(0, 2).toUpperCase(),
    age: user.age,
    lastSyncAt: latestCompliance?.syncedAt?.toISOString() ?? null,
    overallRiskScore: latestOverall,
    identity: user.identityCompletedAt
      ? {
          age: user.age ?? 0,
          sex: user.sex ?? 0,
          raceEthnicity: user.raceEthnicity ?? 0,
          education: user.education ?? 0,
          incomePovertyRatio: Number(user.incomePovertyRatio ?? 0),
          completedAt: user.identityCompletedAt.toISOString(),
        }
      : {
          age: user.age ?? 0,
          sex: user.sex ?? 0,
          raceEthnicity: user.raceEthnicity ?? 0,
          education: user.education ?? 0,
          incomePovertyRatio: Number(user.incomePovertyRatio ?? 0),
          completedAt: user.createdAt.toISOString(),
        },
    weekly: weekly
      ? {
          weightKg: Number(weekly.weightKg),
          heightCm: Number(weekly.heightCm),
          bmi: Number(weekly.bmi),
          waistCm: Number(weekly.waistCm),
          systolicBp: weekly.systolicBp,
          diastolicBp: weekly.diastolicBp,
          completedAt: weekly.completedAt.toISOString(),
        }
      : null,
    dailyLogs,
    ptmTrend,
    latestOverallScore: latestOverall,
    records: monitorRecords,
    questionnaireDays,
  };
}

export async function getDailyQuestionnaireLog(
  doctorUserId: number,
  patientUserId: number,
  date: string,
) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) return null;

  const link = await db.query.userDoctors.findFirst({
    where: and(eq(userDoctors.doctorId, doctor.id), eq(userDoctors.userId, patientUserId)),
  });
  if (!link) return null;

  const row = await db.query.userDailyQuestionnaires.findFirst({
    where: and(
      eq(userDailyQuestionnaires.userId, patientUserId),
      eq(userDailyQuestionnaires.questionnaireDate, date),
    ),
  });
  if (!row) return null;

  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  return mapQuestionnairePayload(date, payload, row.aiSummary, row.completedAt);
}

export async function getLatestAiSummary(doctorUserId: number, patientUserId: number) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) return null;

  const link = await db.query.userDoctors.findFirst({
    where: and(eq(userDoctors.doctorId, doctor.id), eq(userDoctors.userId, patientUserId)),
  });
  if (!link) return null;

  const row = await db.query.userDailyQuestionnaires.findFirst({
    where: eq(userDailyQuestionnaires.userId, patientUserId),
    orderBy: [desc(userDailyQuestionnaires.questionnaireDate)],
  });
  if (!row?.aiSummary) return null;

  return { date: row.questionnaireDate, summary: row.aiSummary };
}

export async function getPatientNames(patientIds: number[]) {
  if (patientIds.length === 0) return new Map<number, string>();
  const rows = await db.query.users.findMany({
    where: inArray(users.id, patientIds),
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}
