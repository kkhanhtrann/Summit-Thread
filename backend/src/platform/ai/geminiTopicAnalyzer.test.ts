import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep provider behavior deterministic and avoid paid calls
const mocks = vi.hoisted(() => ({ generateText: vi.fn(), createGeminiProviders: vi.fn() }));
vi.mock('ai', () => ({ Output: { object: vi.fn(({ schema }) => schema) }, generateText: mocks.generateText }));
vi.mock('./gemini', () => ({ createGeminiProviders: mocks.createGeminiProviders }));
import { createGeminiTopicAnalyzer } from './geminiTopicAnalyzer';
import type { TopicAnalysisInput, TopicAnalysisSegment } from './topicAnalysis';

// Supply a synthetic interval and actual released evidence for prior notes
const prior = { id: 'prior-caption', sequence: 0, timestampMs: 0, text: 'Trees shade the street.' };
const input: TopicAnalysisInput = {
  captions: Array.from({ length: 37 }, (_, index) => ({
    id: `caption-${index + 100}`, sequence: index + 100, timestampMs: (index + 100) * 1_000,
    text: `Synthetic released statement ${index}`
  })),
  currentThreadId: 'thread-active', currentOccurrenceSummary: 'Trees shade the street.',
  currentOccurrenceEvidenceCaptions: [prior],
  existingThreads: [{ id: 'thread-active', title: 'Street shade', summary: 'Trees shade the street.', evidenceCaptions: [prior] }]
};

// Describe a grounded continuation using both prior and current evidence
const segment: TopicAnalysisSegment = {
  startCaptionId: 'caption-100', decision: 'continue', threadId: 'thread-active', title: 'Street shade',
  summary: 'Trees shade the street and the released segment adds current context.',
  occurrenceSummary: 'The current visit adds released context about shade.',
  summaryEvidenceCaptionIds: ['prior-caption', 'caption-100'],
  occurrenceEvidenceCaptionIds: ['prior-caption', 'caption-100'], suggestedQuestions: []
};

describe('createGeminiTopicAnalyzer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createGeminiProviders.mockReturnValue({ textModel: {} });
    mocks.generateText.mockResolvedValue({ output: { segments: [segment] } });
  });

  it('sends all 37 captions and prior evidence in one interval request', async () => {
    await expect(createGeminiTopicAnalyzer()(input)).resolves.toEqual({ segments: [segment] });
    const request = mocks.generateText.mock.calls[0]![0];
    expect(JSON.parse(request.prompt)).toEqual(input);
    expect(request.maxOutputTokens).toBeGreaterThan(700);
    expect(request.maxRetries).toBe(0);
  });

  it('represents new A, new B, then return to A within one interval', async () => {
    const first = { ...segment, decision: 'new' as const, threadId: undefined,
      summaryEvidenceCaptionIds: ['caption-100'], occurrenceEvidenceCaptionIds: ['caption-100'] };
    const second = { ...first, startCaptionId: 'caption-120', summaryEvidenceCaptionIds: ['caption-120'], occurrenceEvidenceCaptionIds: ['caption-120'] };
    const third = { ...first, startCaptionId: 'caption-130', decision: 'return' as const, threadId: 'caption-100',
      summaryEvidenceCaptionIds: ['caption-101', 'caption-130'], occurrenceEvidenceCaptionIds: ['caption-130'] };
    mocks.generateText.mockResolvedValue({ output: { segments: [first, second, third] } });
    await expect(createGeminiTopicAnalyzer()(input)).resolves.toMatchObject({ segments: [first, second, third] });
  });

  it('rejects coverage that omits the first caption', async () => {
    mocks.generateText.mockResolvedValue({ output: { segments: [{ ...segment, startCaptionId: 'caption-101' }] } });
    await expect(createGeminiTopicAnalyzer()(input)).rejects.toThrow('cover the interval');
  });

  it('rejects duplicate or reversed segment boundaries', async () => {
    mocks.generateText.mockResolvedValue({ output: { segments: [segment, segment] } });
    await expect(createGeminiTopicAnalyzer()(input)).rejects.toThrow('cover the interval');
  });

  it('rejects evidence from another segment', async () => {
    const first = { ...segment, summaryEvidenceCaptionIds: ['caption-125'] };
    const next = { ...segment, startCaptionId: 'caption-120' };
    mocks.generateText.mockResolvedValue({ output: { segments: [first, next] } });
    await expect(createGeminiTopicAnalyzer()(input)).rejects.toThrow('Topic evidence');
  });

  it('rejects a return to an unknown topic', async () => {
    mocks.generateText.mockResolvedValue({ output: { segments: [{ ...segment, decision: 'return', threadId: 'unknown' }] } });
    await expect(createGeminiTopicAnalyzer()(input)).rejects.toThrow('Topic reference');
  });

  it('requires fresh occurrence evidence on a return', async () => {
    const other = { ...input.existingThreads[0]!, id: 'earlier-thread' };
    mocks.generateText.mockResolvedValue({ output: { segments: [{ ...segment, decision: 'return', threadId: 'earlier-thread' }] } });
    await expect(createGeminiTopicAnalyzer()({ ...input, existingThreads: [...input.existingThreads, other] })).rejects.toThrow('Topic evidence');
  });

  it('does not treat prior summary text as evidence when its caption is unavailable', async () => {
    await expect(createGeminiTopicAnalyzer()({ ...input,
      existingThreads: [{ ...input.existingThreads[0]!, evidenceCaptions: [] }]
    })).rejects.toThrow('Topic evidence');
  });
});
