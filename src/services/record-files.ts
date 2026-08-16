import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads', 'records');

export async function ensureUploadDir() {
  await mkdir(UPLOAD_ROOT, { recursive: true });
}

export function resolveRecordFilePath(fileKey: string) {
  const safe = path.basename(fileKey);
  return path.join(UPLOAD_ROOT, safe);
}

export async function saveRecordPdf(input: {
  userId: number;
  fileName: string;
  base64: string;
}) {
  await ensureUploadDir();
  const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'document.pdf';
  const fileKey = `${input.userId}-${Date.now()}-${safeName}`;
  const fullPath = resolveRecordFilePath(fileKey);
  const bytes = Buffer.from(input.base64, 'base64');
  await Bun.write(fullPath, bytes);
  return {
    fileKey,
    fileUrl: `/api/v1/records/${fileKey}/download-by-key`,
    byteSize: bytes.byteLength,
  };
}
