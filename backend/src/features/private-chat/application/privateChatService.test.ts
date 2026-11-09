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

    expect(searchReleasedCaptions).toHaveBeenNthCalledWith(1, 'live-session', 'Why does that matter?');
    expect(searchReleasedCaptions).toHaveBeenNthCalledWith(2, 'live-session', 'How can trees help people get to a bus stop?');
    expect(result).toEqual({
      answer: 'A shaded route can make the walk to a bus stop cooler.',
      citations: [{
        captionId: releasedCaption.id,
        timestampMs: releasedCaption.timestampMs,
        text: releasedCaption.text
      }]
    });
    expect(generateAnswer).toHaveBeenCalledWith(expect.objectContaining({
      question: 'Why does that matter?',
      sources: [{ id: releasedCaption.id, timestampMs: releasedCaption.timestampMs, text: releasedCaption.text }]
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

    expect(result.citations).toEqual([{ captionId: longCaption.id, timestampMs: longCaption.timestampMs, text: longCaption.text }]);
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
    expect(generateAnswer.mock.calls[0]?.[0].sources).toEqual([{ id: releasedCaption.id, text: releasedCaption.text, timestampMs: releasedCaption.timestampMs }]);
    expect(answer.citations[0]?.text).toBe(releasedCaption.text);
    expect(JSON.stringify(answer)).not.toContain('STALE_INDEX_MARKER');
  });
  it('does not validate uncited generated text by automatically citing supplied context', async () => {
    const service = new PrivateChatService({ sessions: {
      getReleasedCaptions: async () => [releasedCaption], searchReleasedCaptions: async () => []
    }, generateAnswer: async () => ({ answer: 'UNVERIFIED_GENERATION_MARKER', citationIds: ['invented'] }) });
    const answer = await service.ask('room', { question: 'Why?', history: [], contextCaptionId: releasedCaption.id });
    expect(answer.answer).not.toContain('UNVERIFIED_GENERATION_MARKER');
    expect(answer.citations[0]?.captionId).toBe(releasedCaption.id);
  });
  it('does not let one valid citation excuse an invented citation', async () => {
    const service = new PrivateChatService({ sessions: {
      getReleasedCaptions: async () => [releasedCaption], searchReleasedCaptions: async () => [releasedCaption]
    }, generateAnswer: async () => ({ answer: 'PARTLY_UNVERIFIED_MARKER', citationIds: [releasedCaption.id, 'invented'] }) });
    const answer = await service.ask('room', { question: 'Why?', history: [] });
    expect(answer.answer).not.toContain('PARTLY_UNVERIFIED_MARKER');
  });
});
