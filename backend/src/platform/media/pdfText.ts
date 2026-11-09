import {
  MATERIAL_LIMITS,
  MaterialTooLargeError,
  MaterialUnreadableError,
  type ExtractedPassage
} from '../../features/sessions/public';

// Describe text extracted from one PDF before passage splitting
export interface ExtractedPdf {
  pageCount: number;
  pages: Array<ExtractedPassage & { pageNumber: number }>;
}

// Load the Node-compatible pdf.js build only when a PDF is actually processed
function loadPdfjs() {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

// Read text page by page, keeping line breaks between text runs on different lines
// Check the page count before reading content so oversized documents fail fast
export async function extractPdfText(
  bytes: Uint8Array,
  options: { maxPages?: number } = {}
): Promise<ExtractedPdf> {
  const maxPages = options.maxPages ?? MATERIAL_LIMITS.pdfMaxPages;
  const pdfjs = await loadPdfjs();
  // Copy the bytes because pdf.js transfers and detaches the buffer it receives
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    // Text extraction needs no glyph data, so silence font warnings instead of loading fonts
    verbosity: 0
  });
  try {
    let document;
    try {
      document = await task.promise;
    } catch {
      // Keep parser details out of errors because they can echo document content
      throw new MaterialUnreadableError();
    }
    if (document.numPages > maxPages) throw new MaterialTooLargeError();
    const pages: ExtractedPdf['pages'] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      let page;
      let content;
      try {
        page = await document.getPage(pageNumber);
        content = await page.getTextContent();
      } catch {
        // Map malformed pages to the unreadable error without echoing parser details
        throw new MaterialUnreadableError();
      }
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
        else if (item.str && !text.endsWith(' ')) text += ' ';
      }
      pages.push({ pageNumber, text: text.replace(/[ \t]+\n/g, '\n').trim() });
      page.cleanup();
    }
    return { pageCount: document.numPages, pages };
  } finally {
    await task.destroy();
  }
}
