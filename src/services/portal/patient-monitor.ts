import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  medicalRecords,
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

  const [weekly, complianceRows, questionnaires, records] = await Promise.all([
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
      limit: 40,
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

  // only files that arrived via bluetooth transfer or doctor portal upload
  const monitorRecords = records
    .filter((row) => {
      if (!row.fileKey) return false;
      const tags = row.tags ?? [];
      const summary = (row.summary ?? '').toLowerCase();
      return (
        tags.includes('Bluetooth')
        || tags.includes('Dokter')
        || summary.includes('bluetooth')
        || summary.includes('dokter')
      );
    })
    .map((row) => {
      const viaBluetooth = (row.tags ?? []).includes('Bluetooth')
        || (row.summary ?? '').toLowerCase().includes('bluetooth');
      const viaDoctor = (row.tags ?? []).includes('Dokter')
        || (row.summary ?? '').toLowerCase().includes('dokter');
      return {
        id: row.id,
        title: row.title,
        type: row.type,
        recordDate: row.recordDate,
        summary: viaBluetooth
          ? 'Diterima via Bluetooth'
          : viaDoctor
            ? 'Upload dokter'
            : (row.summary ?? 'Dokumen PDF'),
        source: 'record' as const,
        fileUrl: row.fileUrl
          ?? `/api/v1/portal/patients/${user.id}/records/${row.id}/file`,
        createdAt: row.createdAt.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

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

export async function revokePartnerPatient(doctorUserId: number, patientUserId: number) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) return false;

  const link = await db.query.userDoctors.findFirst({
    where: and(eq(userDoctors.doctorId, doctor.id), eq(userDoctors.userId, patientUserId)),
  });
  if (!link) return false;

  await db.delete(userDoctors).where(eq(userDoctors.id, link.id));
  return true;
}

export type CreatePatientRecordInput = {
  type?: 'consultation' | 'image' | 'voice' | 'note';
  title: string;
  content?: string | null;
  summary?: string | null;
  tags?: string[];
  doctorName?: string | null;
  recordDate?: string | null;
  fileName?: string | null;
  fileBase64?: string | null;
};

export async function createPatientRecord(
  doctorUserId: number,
  patientUserId: number,
  input: CreatePatientRecordInput,
) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) return null;

  const link = await db.query.userDoctors.findFirst({
    where: and(eq(userDoctors.doctorId, doctor.id), eq(userDoctors.userId, patientUserId)),
  });
  if (!link) return null;

  const fileBase64 = input.fileBase64
    ? String(input.fileBase64).replace(/^data:[^;]+;base64,/, '')
    : '';

  let fileKey: string | null = null;
  if (fileBase64) {
    const { saveRecordPdf } = await import('../record-files');
    const saved = await saveRecordPdf({
      userId: patientUserId,
      fileName: input.fileName ?? 'document.pdf',
      base64: fileBase64,
    });
    fileKey = saved.fileKey;
  }

  const [record] = await db
    .insert(medicalRecords)
    .values({
      userId: patientUserId,
      type: input.type ?? (fileKey ? 'image' : 'note'),
      title: input.title,
      content: input.content ?? null,
      summary: input.summary ?? (fileKey ? 'Upload dokter' : null),
      fileKey,
      fileUrl: null,
      tags: input.tags ?? (fileKey ? ['PDF', 'Dokter'] : []),
      doctorName: input.doctorName ?? doctor.user?.name ?? null,
      recordDate: input.recordDate ?? new Date().toISOString().slice(0, 10),
      isAiSummarized: false,
    })
    .returning();

  if (fileKey) {
    const fileUrl = `/api/v1/portal/patients/${patientUserId}/records/${record.id}/file`;
    await db
      .update(medicalRecords)
      .set({ fileUrl })
      .where(eq(medicalRecords.id, record.id));
    return { ...record, fileUrl };
  }

  return record;
}

export async function deletePatientRecord(
  doctorUserId: number,
  patientUserId: number,
  recordId: number,
) {
  const doctor = await getDoctorByUserId(doctorUserId);
  if (!doctor) return null;

  const link = await db.query.userDoctors.findFirst({
    where: and(eq(userDoctors.doctorId, doctor.id), eq(userDoctors.userId, patientUserId)),
  });
  if (!link) return null;

  const record = await db.query.medicalRecords.findFirst({
    where: and(eq(medicalRecords.id, recordId), eq(medicalRecords.userId, patientUserId)),
  });
  if (!record) return false;

  if (record.fileKey) {
    try {
      const { unlink } = await import('node:fs/promises');
      const { resolveRecordFilePath } = await import('../record-files');
      await unlink(resolveRecordFilePath(record.fileKey));
    } catch {
      // file may already be missing
    }
  }

  await db
    .delete(medicalRecords)
    .where(and(eq(medicalRecords.id, recordId), eq(medicalRecords.userId, patientUserId)));

  return true;
}

export async function getPatientNames(patientIds: number[]) {
  if (patientIds.length === 0) return new Map<number, string>();
  const rows = await db.query.users.findMany({
    where: inArray(users.id, patientIds),
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}
