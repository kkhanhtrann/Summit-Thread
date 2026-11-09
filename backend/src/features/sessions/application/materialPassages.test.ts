import { describe, expect, it } from 'vitest';

import { splitIntoPassages } from './materialPassages';

describe('splitIntoPassages', () => {
  it('keeps short pages as single passages with their page numbers', () => {
    expect(splitIntoPassages([
      { pageNumber: 1, text: 'Fixture slide one: urban heat islands.' },
      { pageNumber: 2, text: 'Fixture slide two: cool roofs.' }
    ])).toEqual([
      { pageNumber: 1, text: 'Fixture slide one: urban heat islands.' },
      { pageNumber: 2, text: 'Fixture slide two: cool roofs.' }
    ]);
  });

  it('never merges text across pages', () => {
    const passages = splitIntoPassages([
      { pageNumber: 1, text: 'Fixture short page.' },
      { pageNumber: 2, text: 'Fixture next page.' }
    ], 1_200);
    expect(passages.map((passage) => passage.pageNumber)).toEqual([1, 2]);
  });

  it('skips pages without extractable text', () => {
    expect(splitIntoPassages([
      { pageNumber: 1, text: '   \n\t ' },
      { pageNumber: 2, text: 'Fixture text on page two.' }
    ])).toEqual([{ pageNumber: 2, text: 'Fixture text on page two.' }]);
  });

  it('breaks long text on paragraph and sentence boundaries within the limit', () => {
    const sentence = 'Fixture sentence about shaded streets and cooler sidewalks. ';
    const text = `${sentence.repeat(12).trim()}\n\n${sentence.repeat(12).trim()}`;
    const passages = splitIntoPassages([{ pageNumber: null, text }], 300);

    expect(passages.length).toBeGreaterThan(2);
    for (const passage of passages) {
      expect(passage.text.length).toBeLessThanOrEqual(300);
      expect(passage.text.endsWith('.')).toBe(true);
    }
    // Preserve every word in order without duplicating or dropping content
    expect(passages.map((passage) => passage.text).join(' ').replace(/\s+/g, ' '))
      .toBe(text.replace(/\s+/g, ' '));
  });

  it('hard-splits a single overlong word run so no passage exceeds the limit', () => {
    const passages = splitIntoPassages([{ pageNumber: 3, text: 'x'.repeat(650) }], 300);
    expect(passages.map((passage) => passage.text.length)).toEqual([300, 300, 50]);
    expect(passages.every((passage) => passage.pageNumber === 3)).toBe(true);
  });

  it('normalizes whitespace inside passages', () => {
    expect(splitIntoPassages([{ pageNumber: 1, text: 'Fixture   spaced\twords\r\nhere.' }]))
      .toEqual([{ pageNumber: 1, text: 'Fixture spaced words here.' }]);
  });
});
