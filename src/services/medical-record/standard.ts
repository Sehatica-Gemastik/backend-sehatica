export const MEDICAL_RECORD_SCHEMA_VERSION = 'sehatica-medical-record-v1';

export type MedicalDocumentKind =
  | 'prescription'
  | 'lab_result'
  | 'consultation_note'
  | 'medical_certificate'
  | 'imaging_report'
  | 'discharge_summary'
  | 'other_medical'
  | 'not_medical';

export type StandardRecordType = 'consultation' | 'image' | 'note';

export type MedicationEntry = {
  name: string;
  dose?: string | null;
  frequency?: string | null;
  duration?: string | null;
  notes?: string | null;
};

export type LabResultEntry = {
  test: string;
  value?: string | null;
  unit?: string | null;
  reference?: string | null;
  flag?: string | null;
};

export type VitalEntry = {
  name: string;
  value: string;
  unit?: string | null;
};

export type StandardMedicalRecord = {
  schemaVersion: typeof MEDICAL_RECORD_SCHEMA_VERSION;
  isMedicalDocument: boolean;
  documentKind: MedicalDocumentKind;
  confidence: number;
  rejectionReason?: string | null;
  title: string;
  summary: string;
  recordDate: string | null;
  recordType: StandardRecordType;
  tags: string[];
  doctorName: string | null;
  facilityName: string | null;
  sections: {
    chiefComplaint?: string | null;
    diagnosis?: string[];
    medications?: MedicationEntry[];
    labResults?: LabResultEntry[];
    vitals?: VitalEntry[];
    procedures?: string[];
    instructions?: string[];
    followUp?: string | null;
    rawExtractedText?: string | null;
  };
  parsingMeta: {
    provider: string;
    model: string;
    parsedAt: string;
  };
};

const KIND_TO_RECORD_TYPE: Record<MedicalDocumentKind, StandardRecordType> = {
  prescription: 'consultation',
  lab_result: 'image',
  consultation_note: 'consultation',
  medical_certificate: 'image',
  imaging_report: 'image',
  discharge_summary: 'consultation',
  other_medical: 'image',
  not_medical: 'note',
};

const KIND_LABELS: Record<MedicalDocumentKind, string> = {
  prescription: 'Resep',
  lab_result: 'Hasil Lab',
  consultation_note: 'Catatan Konsultasi',
  medical_certificate: 'Surat Keterangan Medis',
  imaging_report: 'Laporan Pencitraan',
  discharge_summary: 'Ringkasan Pulang',
  other_medical: 'Dokumen Medis',
  not_medical: 'Bukan Dokumen Medis',
};

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asNullableString(value: unknown): string | null {
  const text = asString(value);
  return text || null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function clampConfidence(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) return 0.5;
  return Math.min(1, Math.max(0, num));
}

function normalizeMedications(value: unknown): MedicationEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      name: asString((item as MedicationEntry).name, 'Obat'),
      dose: asNullableString((item as MedicationEntry).dose),
      frequency: asNullableString((item as MedicationEntry).frequency),
      duration: asNullableString((item as MedicationEntry).duration),
      notes: asNullableString((item as MedicationEntry).notes),
    }))
    .filter((item) => item.name.length > 0)
    .slice(0, 30);
}

function normalizeLabResults(value: unknown): LabResultEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      test: asString((item as LabResultEntry).test, 'Pemeriksaan'),
      value: asNullableString((item as LabResultEntry).value),
      unit: asNullableString((item as LabResultEntry).unit),
      reference: asNullableString((item as LabResultEntry).reference),
      flag: asNullableString((item as LabResultEntry).flag),
    }))
    .slice(0, 40);
}

function normalizeVitals(value: unknown): VitalEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      name: asString((item as VitalEntry).name, 'Vital'),
      value: asString((item as VitalEntry).value, '-'),
      unit: asNullableString((item as VitalEntry).unit),
    }))
    .slice(0, 20);
}

export function mapDocumentKindToRecordType(kind: MedicalDocumentKind): StandardRecordType {
  return KIND_TO_RECORD_TYPE[kind] ?? 'image';
}

export function documentKindLabel(kind: MedicalDocumentKind): string {
  return KIND_LABELS[kind] ?? 'Dokumen Medis';
}

export function normalizeStandardMedicalRecord(
  raw: unknown,
  meta: { provider: string; model: string }
): StandardMedicalRecord {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<StandardMedicalRecord>;
  const documentKind = (input.documentKind ?? 'other_medical') as MedicalDocumentKind;
  const isMedicalDocument = input.isMedicalDocument !== false && documentKind !== 'not_medical';

  const title =
    asString(input.title) ||
    (isMedicalDocument ? documentKindLabel(documentKind) : 'Bukan dokumen medis');

  const summary =
    asString(input.summary) ||
    (isMedicalDocument ? 'Dokumen medis berhasil diparse.' : asString(input.rejectionReason, 'Gambar bukan dokumen medis.'));

  const sectionsInput = (input.sections && typeof input.sections === 'object'
    ? input.sections
    : {}) as StandardMedicalRecord['sections'];

  return {
    schemaVersion: MEDICAL_RECORD_SCHEMA_VERSION,
    isMedicalDocument,
    documentKind,
    confidence: clampConfidence(input.confidence),
    rejectionReason: asNullableString(input.rejectionReason),
    title,
    summary,
    recordDate: asNullableString(input.recordDate),
    recordType: mapDocumentKindToRecordType(documentKind),
    tags: asStringArray(input.tags).slice(0, 8),
    doctorName: asNullableString(input.doctorName),
    facilityName: asNullableString(input.facilityName),
    sections: {
      chiefComplaint: asNullableString(sectionsInput.chiefComplaint),
      diagnosis: asStringArray(sectionsInput.diagnosis),
      medications: normalizeMedications(sectionsInput.medications),
      labResults: normalizeLabResults(sectionsInput.labResults),
      vitals: normalizeVitals(sectionsInput.vitals),
      procedures: asStringArray(sectionsInput.procedures),
      instructions: asStringArray(sectionsInput.instructions),
      followUp: asNullableString(sectionsInput.followUp),
      rawExtractedText: asNullableString(sectionsInput.rawExtractedText),
    },
    parsingMeta: {
      provider: meta.provider,
      model: meta.model,
      parsedAt: new Date().toISOString(),
    },
  };
}

export function serializeStandardMedicalRecord(record: StandardMedicalRecord): string {
  return JSON.stringify(record, null, 2);
}
