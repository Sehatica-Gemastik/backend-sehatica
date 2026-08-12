import { isDummyLlm, llmConfig } from '../../config/llm';
import { getLlmProvider, LlmAuthError, LlmRateLimitError } from '../llm/provider';
import { loadPrivacyProfile, sanitizeTextForLlm, shouldSanitizeForLlm } from '../llm/privacy';
import {
  normalizeStandardMedicalRecord,
  serializeStandardMedicalRecord,
  type StandardMedicalRecord,
} from './standard';
import {
  assertSupportedDocumentMime,
  extractPdfText,
  prepareImageForVision,
} from './document-input';

const JSON_SCHEMA_HINT = `Balas HANYA JSON valid sesuai schema:
{
  "isMedicalDocument": true,
  "documentKind": "prescription|lab_result|consultation_note|medical_certificate|imaging_report|discharge_summary|other_medical|not_medical",
  "confidence": 0.0,
  "rejectionReason": null,
  "title": "string",
  "summary": "string",
  "recordDate": "YYYY-MM-DD|null",
  "recordType": "consultation|image|note",
  "tags": ["..."],
  "doctorName": "string|null",
  "facilityName": "string|null",
  "sections": {
    "chiefComplaint": "string|null",
    "diagnosis": ["..."],
    "medications": [{"name":"","dose":"","frequency":"","duration":"","notes":""}],
    "labResults": [{"test":"","value":"","unit":"","reference":"","flag":""}],
    "vitals": [{"name":"","value":"","unit":""}],
    "procedures": ["..."],
    "instructions": ["..."],
    "followUp": "string|null",
    "rawExtractedText": "string|null"
  }
}`;

const SHARED_RULES = `ATURAN:
1. Jika BUKAN dokumen medis (selfie, struk non-medis, meme, dll) → isMedicalDocument=false, documentKind="not_medical", rejectionReason jelas.
2. Jika dokumen medis → isMedicalDocument=true, pilih documentKind yang paling cocok.
3. Ekstrak teks relevan ke sections.rawExtractedText (ringkas).
4. Jangan menebak diagnosis/obat yang tidak ada di dokumen.
5. Mask data identitas pasien (nama, NIK, alamat, telepon) → [disamarkan].
6. Bahasa Indonesia untuk title, summary, field teks.
7. recordDate format YYYY-MM-DD jika terdeteksi, else null.
8. recordType: consultation | image | note.
9. tags: 2-5 tag singkat.`;

const VISION_SYSTEM_PROMPT = `/no_think
Kamu parser dokumen medis Indonesia untuk aplikasi Sehatica.
Tugas: baca FOTO dokumen medis (resep, lab, surat dokter) dan kembalikan JSON standar rekam medis.
Balas LANGSUNG dengan JSON, tanpa penjelasan atau reasoning.

${SHARED_RULES}

${JSON_SCHEMA_HINT}`;

const TEXT_SYSTEM_PROMPT = `/no_think
Kamu parser dokumen medis Indonesia untuk aplikasi Sehatica.
Tugas: baca TEKS dari dokumen PDF rekam medis dan kembalikan JSON standar rekam medis.
Balas LANGSUNG dengan JSON, tanpa penjelasan atau reasoning.

${SHARED_RULES}

${JSON_SCHEMA_HINT}`;

function extractJsonObject(text: string): unknown {
  let cleaned = text.trim();

  // strip markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // find outermost { ... } block
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      console.error('[vision-parse] no JSON found in response:', text.slice(0, 500));
      throw new Error('Respons parser tidak berformat JSON');
    }
    const jsonStr = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // JSON truncated — try to repair by closing open brackets
      const repaired = repairTruncatedJson(jsonStr);
      if (repaired) return repaired;
      console.error('[vision-parse] JSON parse failed:', (e as Error).message, '\nraw:', jsonStr.slice(0, 500));
      throw new Error('Respons parser tidak berformat JSON');
    }
  }
}

function repairTruncatedJson(json: string): unknown | null {
  let attempt = json;
  // count unclosed brackets
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of attempt) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  // if inside a string, close it
  if (inString) attempt += '"';
  // close arrays then objects
  for (let i = 0; i < brackets; i++) attempt += ']';
  for (let i = 0; i < braces; i++) attempt += '}';
  try {
    return JSON.parse(attempt);
  } catch {
    return null;
  }
}

function dummyParseResult(seed: string): StandardMedicalRecord {
  if (seed.length < 40) {
    return normalizeStandardMedicalRecord(
      {
        isMedicalDocument: false,
        documentKind: 'not_medical',
        confidence: 0.9,
        rejectionReason: 'Mode dummy: dokumen tidak terdeteksi sebagai rekam medis.',
        title: 'Bukan dokumen medis',
        summary: 'Unggah PDF atau foto resep, hasil lab, surat medis.',
        recordDate: null,
        recordType: 'note',
        tags: [],
        doctorName: null,
        facilityName: null,
        sections: {},
      },
      { provider: 'dummy', model: 'dummy-parser' }
    );
  }

  return normalizeStandardMedicalRecord(
    {
      isMedicalDocument: true,
      documentKind: 'prescription',
      confidence: 0.75,
      title: 'Resep Obat (dummy)',
      summary: 'Contoh resep dengan obat antihipertensi.',
      recordDate: new Date().toISOString().slice(0, 10),
      recordType: 'consultation',
      tags: ['Resep', 'Obat'],
      doctorName: 'Dr. [disamarkan]',
      facilityName: 'Klinik [disamarkan]',
      sections: {
        medications: [{ name: 'Amlodipine', dose: '5 mg', frequency: '1x sehari', duration: '30 hari' }],
        instructions: ['Minum setelah makan', 'Kontrol ulang 2 minggu'],
        rawExtractedText: 'Dummy — set LLM_PROVIDER=groq + LLM_API_KEY untuk parsing nyata.',
      },
    },
    { provider: 'dummy', model: 'dummy-parser' }
  );
}

async function finalizeRecord(
  parsed: StandardMedicalRecord,
  userId: number | undefined
): Promise<StandardMedicalRecord> {
  if (!userId || !shouldSanitizeForLlm()) return parsed;

  const profile = await loadPrivacyProfile(userId);
  parsed.title = sanitizeTextForLlm(parsed.title, profile);
  parsed.summary = sanitizeTextForLlm(parsed.summary, profile);
  if (parsed.sections.rawExtractedText) {
    parsed.sections.rawExtractedText = sanitizeTextForLlm(parsed.sections.rawExtractedText, profile);
  }
  if (parsed.doctorName) parsed.doctorName = sanitizeTextForLlm(parsed.doctorName, profile);
  if (parsed.facilityName) parsed.facilityName = sanitizeTextForLlm(parsed.facilityName, profile);
  return parsed;
}

async function parseWithVision(
  userId: number | undefined,
  fileBase64: string,
  mimeType: string
): Promise<StandardMedicalRecord> {
  const images = prepareImageForVision(fileBase64, mimeType);
  let userPrompt =
    'Parse foto dokumen medis ini ke JSON standar. Jika bukan dokumen medis, set isMedicalDocument=false.';

  if (userId && shouldSanitizeForLlm()) {
    const profile = await loadPrivacyProfile(userId);
    userPrompt = sanitizeTextForLlm(userPrompt, profile);
  }

  const llm = getLlmProvider();
  if (!llm.generateVisionJson) {
    throw new Error('Provider vision belum dikonfigurasi');
  }

  const result = await llm.generateVisionJson(VISION_SYSTEM_PROMPT, userPrompt, images);
  console.log('[vision-parse] LLM vision response (first 800):', result.text.slice(0, 800));
  const parsed = normalizeStandardMedicalRecord(extractJsonObject(result.text), {
    provider: result.provider,
    model: result.model,
  });
  return finalizeRecord(parsed, userId);
}

async function parseWithPdfText(
  userId: number | undefined,
  fileBase64: string
): Promise<StandardMedicalRecord> {
  const extractedText = await extractPdfText(fileBase64);
  let userPrompt =
    `Parse teks dokumen PDF berikut ke JSON standar rekam medis.\n\n---\n${extractedText}\n---`;

  if (userId && shouldSanitizeForLlm()) {
    const profile = await loadPrivacyProfile(userId);
    userPrompt = sanitizeTextForLlm(userPrompt, profile);
  }

  const llm = getLlmProvider();
  if (!llm.generateStructuredJson) {
    throw new Error('Provider LLM belum mendukung parsing JSON');
  }

  const result = await llm.generateStructuredJson(TEXT_SYSTEM_PROMPT, userPrompt);
  console.log('[vision-parse] LLM text response (first 800):', result.text.slice(0, 800));
  const parsed = normalizeStandardMedicalRecord(extractJsonObject(result.text), {
    provider: result.provider,
    model: result.model,
  });
  return finalizeRecord(parsed, userId);
}

export async function parseMedicalDocumentVision(
  userId: number | undefined,
  fileBase64: string,
  mimeType = 'image/jpeg'
): Promise<StandardMedicalRecord> {
  if (isDummyLlm()) {
    return dummyParseResult(fileBase64.slice(0, 64));
  }

  if (llmConfig.provider !== 'groq') {
    throw new Error('Parsing rekam medis membutuhkan LLM_PROVIDER=groq');
  }

  const kind = assertSupportedDocumentMime(mimeType);

  try {
    if (kind === 'pdf') {
      return await parseWithPdfText(userId, fileBase64);
    }
    return await parseWithVision(userId, fileBase64, mimeType);
  } catch (err) {
    if (err instanceof LlmRateLimitError || err instanceof LlmAuthError) throw err;
    throw new Error(err instanceof Error ? err.message : 'Gagal memparse dokumen');
  }
}

export function standardRecordToLegacyOcr(record: StandardMedicalRecord) {
  return {
    extractedText: serializeStandardMedicalRecord(record),
    title: record.title,
    summary: record.summary,
    tags: record.tags,
    recordType: record.recordType,
    isMedicalDocument: record.isMedicalDocument,
    documentKind: record.documentKind,
    rejectionReason: record.rejectionReason,
    doctorName: record.doctorName,
    recordDate: record.recordDate,
  };
}
