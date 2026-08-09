export type ReviewSubmission = {
  doctorId: number;
  clientMessageId: number;
  patientQuestion: string;
  aiResponse: string;
  safetyLevel: 'review' | 'urgent';
  patientNote: string | null;
};

export type ReviewDecision = {
  status: 'approved' | 'revised';
  note: string | null;
};

export function parseReviewSubmission(input: unknown): ReviewSubmission | string {
  if (!input || typeof input !== 'object') return 'Data review tidak valid';
  const value = input as Record<string, unknown>;
  const doctorId = Number(value.doctorId);
  const clientMessageId = Number(value.clientMessageId);
  const patientQuestion = typeof value.patientQuestion === 'string' ? value.patientQuestion.trim() : '';
  const aiResponse = typeof value.aiResponse === 'string' ? value.aiResponse.trim() : '';
  const patientNote = typeof value.patientNote === 'string' ? value.patientNote.trim() : '';

  if (!Number.isInteger(doctorId) || doctorId < 1) return 'Dokter tidak valid';
  if (!Number.isInteger(clientMessageId) || clientMessageId < 1) return 'Pesan tidak valid';
  if (!patientQuestion || patientQuestion.length > 2_000) return 'Pertanyaan pasien tidak valid';
  if (!aiResponse || aiResponse.length > 8_000) return 'Jawaban AI tidak valid';
  if (value.safetyLevel !== 'review' && value.safetyLevel !== 'urgent') return 'Level keamanan tidak valid';
  if (patientNote.length > 1_000) return 'Catatan pasien maksimal 1000 karakter';

  return {
    doctorId,
    clientMessageId,
    patientQuestion,
    aiResponse,
    safetyLevel: value.safetyLevel,
    patientNote: patientNote || null,
  };
}

export function parseReviewDecision(input: unknown): ReviewDecision | string {
  if (!input || typeof input !== 'object') return 'Keputusan tidak valid';
  const value = input as Record<string, unknown>;
  if (value.status !== 'approved' && value.status !== 'revised') return 'Status keputusan tidak valid';
  const note = typeof value.note === 'string' ? value.note.trim() : '';
  if (note.length > 2_000) return 'Catatan dokter maksimal 2000 karakter';
  if (value.status === 'revised' && !note) return 'Revisi wajib menyertakan catatan dokter';
  return { status: value.status, note: note || null };
}
