import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeminiLiveTranscriptionProvider } from './geminiLiveTranscriptionProvider';
const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    live = { connect: mocks.connect };
  },
  Modality: { TEXT: 'TEXT' }
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('backend Gemini transcription adapter', () => {
  it('requires a backend credential before allocating a provider', async () => {
    const provider = createGeminiLiveTranscriptionProvider({
      apiKey: '',
      model: 'synthetic-model'
    });
    await expect(provider.connect(vi.fn(), vi.fn())).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('separates interim and final messages and drains finalization on stop', async () => {
    vi.useFakeTimers();
    let callbacks: { onmessage(value: unknown): void } | undefined;
    const sendRealtimeInput = vi.fn((value) => {
      if (value.audioStreamEnd)
        callbacks?.onmessage({
          serverContent: {
            inputTranscription: { text: 'Synthetic final on drain' }
          }
        });
    });
    const close = vi.fn();
    mocks.connect.mockImplementation(async (input) => {
      callbacks = input.callbacks;
      return { sendRealtimeInput, close };
    });
    const transcript = vi.fn();
    const error = vi.fn();
    const session = await createGeminiLiveTranscriptionProvider({
      apiKey: 'synthetic-key',
      model: 'synthetic-model'
    }).connect(transcript, error);
    expect(mocks.connect.mock.calls[0]?.[0]).toMatchObject({
      config: {
        responseModalities: ['TEXT'],
        inputAudioTranscription: { languageCodes: [] }
      }
    });
    callbacks?.onmessage({
      serverContent: {
        interimInputTranscription: { text: 'Synthetic interim' }
      }
    });
    callbacks?.onmessage({
      serverContent: { inputTranscription: { text: 'Synthetic final' } }
    });
    expect(transcript.mock.calls.map((call) => call[0].type)).toEqual([
      'interim',
      'final'
    ]);
    session.sendAudio(Buffer.alloc(3200));
    expect(sendRealtimeInput).toHaveBeenCalledWith({
      audio: {
        data: Buffer.alloc(3200).toString('base64'),
        mimeType: 'audio/pcm;rate=16000'
      }
    });
    const finishing = session.finish();
    await vi.advanceTimersByTimeAsync(2500);
    await finishing;
    expect(transcript).toHaveBeenLastCalledWith({
      type: 'final',
      text: 'Synthetic final on drain'
    });
    await session.close();
    callbacks?.onmessage({
      serverContent: { inputTranscription: { text: 'Synthetic stale final' } }
    });
    expect(transcript).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });
  it('bounds provider setup and closes connections that resolve after the deadline', async () => {
    vi.useFakeTimers();
    let late!: (session: unknown) => void;
    const close = vi.fn();
    mocks.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          late = resolve;
        })
    );
    const connecting = createGeminiLiveTranscriptionProvider({
      apiKey: 'synthetic-key',
      model: 'synthetic-model'
    }).connect(vi.fn(), vi.fn());
    const assertion = expect(connecting).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(12000);
    await assertion;
    late({ close });
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
  });
});
