import { describe, expect, it } from 'vitest';

import { MaterialTooLargeError, MaterialUnreadableError } from '../../features/sessions/public';
import { extractPdfText } from './pdfText';
import { buildSyntheticPdf } from './syntheticPdf.fixture';

describe('extractPdfText', () => {
  it('returns text page by page with page numbers', async () => {
    const pdf = buildSyntheticPdf([['Fixture slide one', 'Urban heat islands'], ['Fixture slide two']]);

    await expect(extractPdfText(pdf)).resolves.toEqual({
      pageCount: 2,
      pages: [
        { pageNumber: 1, text: 'Fixture slide one\nUrban heat islands' },
        { pageNumber: 2, text: 'Fixture slide two' }
      ]
    });
  });

  it('reports empty text for pages without extractable text', async () => {
    const result = await extractPdfText(buildSyntheticPdf([[], []]));
    expect(result.pageCount).toBe(2);
    expect(result.pages.every((page) => page.text === '')).toBe(true);
  });

  it('rejects documents over the page limit before reading their text', async () => {
    await expect(extractPdfText(buildSyntheticPdf([['a'], ['b'], ['c']]), { maxPages: 2 }))
      .rejects.toBeInstanceOf(MaterialTooLargeError);
  });

  it('rejects bytes that are not a readable PDF', async () => {
    await expect(extractPdfText(new TextEncoder().encode('Fixture: not a PDF')))
      .rejects.toBeInstanceOf(MaterialUnreadableError);
  });
});
