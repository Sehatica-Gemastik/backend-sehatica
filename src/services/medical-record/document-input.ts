import { extractText, getDocumentProxy } from 'unpdf';

export type VisionImageInput = {
  base64: string;
  mimeType: string;
};

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 24_000;

function normalizeMime(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
}

export function isPdfMime(mimeType: string): boolean {
  const m = normalizeMime(mimeType);
  return m === 'application/pdf' || m.endsWith('/pdf');
}

export function isImageMime(mimeType: string): boolean {
  const m = normalizeMime(mimeType);
  return m.startsWith('image/');
}

export function prepareImageForVision(
  fileBase64: string,
  mimeType: string
): VisionImageInput[] {
  const normalized = normalizeMime(mimeType);
  if (!isImageMime(normalized)) {
    throw new Error('Vision hanya untuk foto (JPG/PNG). PDF diparse sebagai teks.');
  }
  return [{
    base64: fileBase64,
    mimeType: normalized === 'image/jpg' ? 'image/jpeg' : normalized,
  }];
}

export async function extractPdfText(fileBase64: string): Promise<string> {
  const pdfBuffer = Buffer.from(fileBase64, 'base64');
  if (pdfBuffer.byteLength > MAX_PDF_BYTES) {
    throw new Error('Ukuran PDF maksimal 15 MB');
  }

  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = (Array.isArray(text) ? text.join('\n\n') : String(text ?? '')).trim();

  if (!merged) {
    throw new Error(
      'PDF scan tanpa teks terbaca. Unggah PDF digital atau foto dokumen via kamera.'
    );
  }

  if (merged.length > MAX_EXTRACTED_TEXT_CHARS) {
    return merged.slice(0, MAX_EXTRACTED_TEXT_CHARS);
  }

  return merged;
}

export function assertSupportedDocumentMime(mimeType: string): 'pdf' | 'image' {
  if (isPdfMime(mimeType)) return 'pdf';
  if (isImageMime(mimeType)) return 'image';
  throw new Error('Format tidak didukung. Unggah PDF atau foto (JPG/PNG).');
}
