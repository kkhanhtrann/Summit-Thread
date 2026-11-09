import { describe, expect, it, vi } from 'vitest';

// Open the document successfully, then fail on a page, which a synthetic PDF cannot reliably trigger
const pdfjs = vi.hoisted(() => ({
  getPage: vi.fn(),
  destroy: vi.fn(async () => undefined)
}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 2, getPage: pdfjs.getPage }),
    destroy: pdfjs.destroy
  })
}));

import { MaterialUnreadableError } from '../../features/sessions/public';
import { extractPdfText } from './pdfText';

describe('extractPdfText page failures', () => {
  it('reports a page that cannot be read as unreadable without exposing the parser error', async () => {
    pdfjs.getPage.mockRejectedValue(new Error('PRIVATE_DOCUMENT_TEXT'));

    const failure = await extractPdfText(new Uint8Array([1])).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MaterialUnreadableError);
    expect(String((failure as Error).message)).not.toContain('PRIVATE_DOCUMENT_TEXT');
    expect(pdfjs.destroy).toHaveBeenCalled();
  });

  it('reports text extraction failure on a page as unreadable', async () => {
    pdfjs.getPage.mockResolvedValue({ getTextContent: async () => { throw new Error('PRIVATE_DOCUMENT_TEXT'); }, cleanup: () => undefined });

    await expect(extractPdfText(new Uint8Array([1]))).rejects.toBeInstanceOf(MaterialUnreadableError);
  });
});
