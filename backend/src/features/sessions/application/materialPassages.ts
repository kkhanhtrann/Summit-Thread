import { MATERIAL_LIMITS, type ExtractedPassage } from '../contracts/material.contract';

// Split one paragraph into sentence-sized pieces that keep their trailing punctuation
function sentences(paragraph: string): string[] {
  return paragraph.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
}

// Cut an overlong run into fixed-size pieces as a last resort
function hardSplit(text: string, maxLength: number): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += maxLength) pieces.push(text.slice(start, start + maxLength).trim());
  return pieces.filter(Boolean);
}

// Split page text into bounded, citable passages without crossing page boundaries
// Prefer paragraph, then sentence, then hard breaks so every word is kept once in order
export function splitIntoPassages(
  pages: ExtractedPassage[],
  maxLength: number = MATERIAL_LIMITS.passageMaxLength
): ExtractedPassage[] {
  const passages: ExtractedPassage[] = [];
  for (const page of pages) {
    const paragraphs = page.text
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    let current = '';
    const flush = () => {
      if (current) passages.push({ pageNumber: page.pageNumber, text: current });
      current = '';
    };
    const append = (piece: string) => {
      if (!current) current = piece;
      else if (current.length + 1 + piece.length <= maxLength) current = `${current} ${piece}`;
      else {
        flush();
        current = piece;
      }
    };
    for (const paragraph of paragraphs) {
      const units = paragraph.length <= maxLength ? [paragraph] : sentences(paragraph);
      for (const unit of units) {
        if (unit.length <= maxLength) append(unit);
        else {
          flush();
          for (const piece of hardSplit(unit, maxLength)) append(piece);
        }
      }
    }
    flush();
  }
  return passages;
}
