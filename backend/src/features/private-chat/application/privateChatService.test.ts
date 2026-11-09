import { describe, expect, it, vi } from 'vitest';

import { PrivateChatService } from './privateChatService';

const releasedCaption = {
  id: 'live-session-caption-002',
  sequence: 2,
  timestampMs: 42_000,
  text: 'The shaded route gives people a cooler way to reach the bus stop.'
};

describe('PrivateChatService', () => {
  it('uses earlier conversation context to retrieve and cite released passages', async () => {
    const searchReleasedCaptions = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([releasedCaption]);
    const generateAnswer = vi.fn().mockResolvedValue({
      answer: 'A shaded route can make the walk to a bus stop cooler.',
      citationIds: [releasedCaption.id]
    });
    const service = new PrivateChatService({
      sessions: {
        getReleasedCaptions: vi.fn().mockResolvedValue([releasedCaption]),
        searchReleasedCaptions
      },
      generateAnswer
    });

    const result = await service.ask('live-session', {
      question: 'Why does that matter?',
      history: [
        { role: 'user', content: 'How can trees help people get to a bus stop?' },
        { role: 'assistant', content: 'The speaker described shaded routes.' }
      ]
    });

    expect(searchReleasedCaptions).toHaveBeenNthCalledWith(1, 'live-session', 'Why does that matter?', [releasedCaption.id]);
    expect(searchReleasedCaptions).toHaveBeenNthCalledWith(2, 'live-session', 'How can trees help people get to a bus stop?', [releasedCaption.id]);
    expect(result).toEqual({
      answer: 'A shaded route can make the walk to a bus stop cooler.',
      citations: [{
        kind: 'caption',
        captionId: releasedCaption.id,
        timestampMs: releasedCaption.timestampMs,
        text: releasedCaption.text
      }]
    });
    expect(generateAnswer).toHaveBeenCalledWith(expect.objectContaining({
      question: 'Why does that matter?',
      sources: [{ id: releasedCaption.id, kind: 'spoken', timestampMs: releasedCaption.timestampMs, text: releasedCaption.text }]
    }));
  });

  it('does not call Gemini when the released talk has no matching passage', async () => {
    const generateAnswer = vi.fn();
    const service = new PrivateChatService({
      sessions: {
        getReleasedCaptions: vi.fn().mockResolvedValue([]),
        searchReleasedCaptions: vi.fn().mockResolvedValue([])
      },
      generateAnswer
    });

    const result = await service.ask('live-session', { question: 'What is the speaker hiding?', history: [] });

    expect(result.answer).toMatch(/the talk hasn’t covered this yet/i);
    expect(result.citations).toEqual([]);
    expect(generateAnswer).not.toHaveBeenCalled();
  });

  it('returns a cited passage excerpt when Gemini omits citation IDs', async () => {
    const longCaption = { ...releasedCaption, text: 'A'.repeat(2_000) };
    const service = new PrivateChatService({
      sessions: {
        getReleasedCaptions: vi.fn().mockResolvedValue([longCaption]),
        searchReleasedCaptions: vi.fn().mockResolvedValue([longCaption])
      },
      generateAnswer: vi.fn().mockResolvedValue({ answer: 'The home surroundings shape heat exposure.', citationIds: [] })
    });

    const result = await service.ask('live-session', { question: 'How does shade help?', history: [] });

    expect(result.citations).toEqual([{ kind: 'caption', captionId: longCaption.id, timestampMs: longCaption.timestampMs, text: longCaption.text }]);
    expect(result.answer.length).toBeLessThanOrEqual(1_000);
    expect(result.answer).toContain('…');
  });
});

// Exercise trust boundaries with deliberately inconsistent search/provider data
 describe('Private Ask evidence boundaries', () => {
  it('uses committed passage text and timestamps instead of stale index payloads', async () => {
    const generateAnswer = vi.fn().mockResolvedValue({ answer: 'Grounded.', citationIds: [releasedCaption.id] });
    const service = new PrivateChatService({ sessions: {
      getReleasedCaptions: async () => [releasedCaption],
      searchReleasedCaptions: async () => [{ ...releasedCaption, text: 'STALE_INDEX_MARKER', timestampMs: 999999 }, { ...releasedCaption, id: 'other-room' }]
    }, generateAnswer });
    const answer = await service.ask('room', { question: 'What helps?', history: [] });
    expect(generateAnswer.mock.calls[0]?.[0].sources).toEqual([{ id: releasedCaption.id, kind: 'spoken', text: releasedCaption.text, timestampMs: releasedCaption.timestampMs }]);
    expect(answer.citations[0]?.text).toBe(releasedCaption.text);
    expect(JSON.stringify(answer)).not.toContain('STALE_INDEX_MARKER');
  });
  it('does not validate uncited generated text by automatically citing supplied context', async () => {
    const service = new PrivateChatService({ sessions: {
      getReleasedCaptions: async () => [releasedCaption], searchReleasedCaptions: async () => []
    }, generateAnswer: async () => ({ answer: 'UNVERIFIED_GENERATION_MARKER', citationIds: ['invented'] }) });
    const answer = await service.ask('room', { question: 'Why?', history: [], contextCaptionId: releasedCaption.id });
    expect(answer.answer).not.toContain('UNVERIFIED_GENERATION_MARKER');
    expect(answer.citations[0]).toMatchObject({ kind: 'caption', captionId: releasedCaption.id });
  });
  it('does not let one valid citation excuse an invented citation', async () => {
    const service = new PrivateChatService({ sessions: {
      getReleasedCaptions: async () => [releasedCaption], searchReleasedCaptions: async () => [releasedCaption]
    }, generateAnswer: async () => ({ answer: 'PARTLY_UNVERIFIED_MARKER', citationIds: [releasedCaption.id, 'invented'] }) });
    const answer = await service.ask('room', { question: 'Why?', history: [] });
    expect(answer.answer).not.toContain('PARTLY_UNVERIFIED_MARKER');
  });
});

describe('PrivateChatService presenter materials', () => {
  // Synthetic test fixture: a labeled presenter passage, not real material
  const slide = { id: 'm-1:3', materialTitle: 'Fixture slides', pageNumber: 4, text: 'Fixture slide: reflective roofs lower surface temperatures.' };

  // Compose the service with caption and material retrieval fakes
  function service(options: {
    captions?: typeof releasedCaption[];
    ready?: typeof slide[];
    materialHits?: typeof slide[];
    materialError?: boolean;
    citationIds?: string[];
  }) {
    const generateAnswer = vi.fn().mockResolvedValue({ answer: 'The slides note reflective roofs lower surface temperatures.', citationIds: options.citationIds ?? [] });
    const searchPassages = vi.fn(async () => {
      if (options.materialError) throw new Error('PRIVATE_SEARCH_MARKER');
      return options.materialHits ?? [];
    });
    const getReadyPassageIds = vi.fn(async () => (options.ready ?? []).map((passage) => passage.id));
    const getReadyPassagesByIds = vi.fn(async (_room: string, ids: string[]) => (options.ready ?? []).filter((passage) => ids.includes(passage.id)));
    const chat = new PrivateChatService({
      sessions: {
        getReleasedCaptions: vi.fn().mockResolvedValue(options.captions ?? []),
        searchReleasedCaptions: vi.fn().mockResolvedValue(options.captions ?? [])
      },
      materials: { getReadyPassageIds, getReadyPassagesByIds, searchPassages },
      generateAnswer
    });
    return { chat, generateAnswer, searchPassages, getReadyPassagesByIds };
  }

  it('loads passage text only for the search hits it keeps, not the whole room', async () => {
    const others = Array.from({ length: 50 }, (_, index) => ({ ...slide, id: `m-1:${index + 10}` }));
    const { chat, getReadyPassagesByIds } = service({ ready: [slide, ...others], materialHits: [slide], citationIds: [slide.id] });

    await chat.ask('AB12CD34', { question: 'What do reflective roofs do?', history: [] });

    expect(getReadyPassagesByIds).toHaveBeenCalledOnce();
    expect(getReadyPassagesByIds).toHaveBeenCalledWith('AB12CD34', [slide.id]);
  });

  it('answers from material alone with a typed material citation and a page label', async () => {
    const { chat, generateAnswer } = service({ ready: [slide], materialHits: [slide], citationIds: [slide.id] });

    const result = await chat.ask('AB12CD34', { question: 'What do reflective roofs do?', history: [] });

    expect(generateAnswer).toHaveBeenCalledWith(expect.objectContaining({
      sources: [{ id: slide.id, kind: 'material', label: 'Fixture slides, page 4', text: slide.text }]
    }));
    expect(result.citations).toEqual([{ kind: 'material', passageId: slide.id, materialTitle: 'Fixture slides', page: 4, text: slide.text }]);
  });

  it('keeps spoken and material citations distinct when both support the answer', async () => {
    const { chat } = service({ captions: [releasedCaption], ready: [slide], materialHits: [slide], citationIds: [releasedCaption.id, slide.id] });

    const result = await chat.ask('AB12CD34', { question: 'How do cities stay cooler?', history: [] });

    expect(result.citations.map((citation) => citation.kind)).toEqual(['caption', 'material']);
  });

  it('ignores material hits that are not ready passages of this room', async () => {
    const foreign = { ...slide, id: 'other-room:0' };
    const { chat, generateAnswer } = service({ ready: [slide], materialHits: [foreign], citationIds: [foreign.id] });

    const result = await chat.ask('AB12CD34', { question: 'What do reflective roofs do?', history: [] });

    expect(generateAnswer).not.toHaveBeenCalled();
    expect(result.citations).toEqual([]);
  });

  it('skips material search when the room has no ready material', async () => {
    const { chat, searchPassages } = service({ captions: [releasedCaption], citationIds: [releasedCaption.id] });
    await chat.ask('AB12CD34', { question: 'Why shade?', history: [] });
    expect(searchPassages).not.toHaveBeenCalled();
  });

  it('keeps answering from speech when material search fails', async () => {
    const { chat } = service({ captions: [releasedCaption], ready: [slide], materialError: true, citationIds: [releasedCaption.id] });

    const result = await chat.ask('AB12CD34', { question: 'Why shade?', history: [] });

    expect(result.citations).toEqual([{ kind: 'caption', captionId: releasedCaption.id, timestampMs: releasedCaption.timestampMs, text: releasedCaption.text }]);
  });

  it('labels a material fallback excerpt so it is never presented as speech', async () => {
    const { chat } = service({ ready: [slide], materialHits: [slide], citationIds: ['invented-id'] });

    const result = await chat.ask('AB12CD34', { question: 'What do reflective roofs do?', history: [] });

    expect(result.answer).toContain('presenter’s materials');
    expect(result.citations).toEqual([{ kind: 'material', passageId: slide.id, materialTitle: 'Fixture slides', page: 4, text: slide.text }]);
  });
});
