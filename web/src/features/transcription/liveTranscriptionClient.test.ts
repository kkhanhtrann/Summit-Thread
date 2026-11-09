import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connectLiveTranscription,
  encodePcm16,
  type LiveSpeechEvent
} from './liveTranscriptionClient';

// Model the room socket without requesting a physical input device
class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instance: MockWebSocket;
  readyState = MockWebSocket.OPEN;
  bufferedAmount = 0;
  binaryType = 'blob';
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Array<string | ArrayBuffer> = [];

  constructor(readonly url: string) {
    MockWebSocket.instance = this;
  }

  send(payload: string | ArrayBuffer): void {
    this.sent.push(payload);
    if (typeof payload === 'string' && JSON.parse(payload).type === 'stop')
      this.receive({ type: 'stopped' });
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // Deliver one server message through the browser socket callback
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

// Keep fake audio contexts available for the supplied source stream
class MockAudioContext {
  static instance: MockAudioContext;
  readonly destination = {} as AudioDestinationNode;
  readonly audioWorklet = {
    addModule: vi.fn().mockResolvedValue(undefined)
  } as unknown as AudioWorklet;
  readonly source = {
    connect: vi.fn(),
    disconnect: vi.fn()
  } as unknown as MediaStreamAudioSourceNode;
  readonly gain = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn()
  } as unknown as GainNode;
  state = 'running';
  createMediaStreamSource = vi.fn(() => this.source);
  createGain = vi.fn(() => this.gain);
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn(async () => {
    this.state = 'closed';
  });

  constructor(_options?: AudioContextOptions) {
    MockAudioContext.instance = this;
  }
}

// Surface captured worklet packets so tests can verify PCM forwarding
class MockAudioWorkletNode {
  static instance: MockAudioWorkletNode;
  readonly port = {
    onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null,
    close: vi.fn()
  };
  connect = vi.fn();
  disconnect = vi.fn();

  constructor(
    _context: AudioContext,
    _name: string,
    _options: AudioWorkletNodeOptions
  ) {
    MockAudioWorkletNode.instance = this;
  }
}

let originalAudioContext: PropertyDescriptor | undefined;

beforeEach(() => {
  MockWebSocket.instance = undefined as unknown as MockWebSocket;
  originalAudioContext = Object.getOwnPropertyDescriptor(
    window,
    'AudioContext'
  );
  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    value: MockAudioContext
  });
  vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalAudioContext)
    Object.defineProperty(window, 'AudioContext', originalAudioContext);
  else Reflect.deleteProperty(window, 'AudioContext');
});

describe('live transcription audio encoding', () => {
  it('converts normalized samples into bounded signed 16-bit mono PCM', () => {
    const encoded = new Int16Array(
      encodePcm16(new Float32Array([-1, -0.5, 0, 0.5, 1, 2]))
    );

    expect([...encoded]).toEqual([-32_768, -16_384, 0, 16_383, 32_767, 32_767]);
  });

  it('streams the supplied media audio without taking ownership of its tracks', async () => {
    const stopTrack = vi.fn();
    const sourceStream = {
      getAudioTracks: () => [{ readyState: 'live', stop: stopTrack }]
    } as unknown as MediaStream;
    const events: LiveSpeechEvent[] = [];
    const capturePromise = connectLiveTranscription(
      'AB12CD34',
      sourceStream,
      (event) => events.push(event)
    );
    await vi.waitFor(() => expect(MockWebSocket.instance).toBeDefined());
    MockWebSocket.instance.receive({ type: 'ready' });
    const capture = await capturePromise;

    expect(
      MockAudioContext.instance.createMediaStreamSource
    ).toHaveBeenCalledWith(sourceStream);
    expect(events).toContainEqual({ type: 'ready' });
    MockAudioWorkletNode.instance.port.onmessage?.({
      data: new Float32Array(1_600)
    } as MessageEvent<Float32Array>);
    capture.setPosition(4_200);

    expect(
      MockWebSocket.instance.sent.some(
        (entry) => entry instanceof ArrayBuffer && entry.byteLength === 3_200
      )
    ).toBe(true);
    expect(MockWebSocket.instance.sent).toContain(
      '{"type":"position","positionMs":4200}'
    );
    await capture.stop();
    expect(stopTrack).not.toHaveBeenCalled();
    expect(MockAudioContext.instance.close).toHaveBeenCalledOnce();
  });
});

it('cancels pending setup, closes its audio context and ignores a late ready event', async () => {
  const controller = new AbortController();
  const stream = {
    getAudioTracks: () => [{ readyState: 'live' }]
  } as unknown as MediaStream;
  const connecting = connectLiveTranscription('DEADBEEF', stream, vi.fn(), {
    signal: controller.signal,
    initialPositionMs: 4200
  });
  const assertion = expect(connecting).rejects.toThrow('cancelled');
  await vi.waitFor(() =>
    expect(MockWebSocket.instance.url).toContain('DEADBEEF')
  );
  const socket = MockWebSocket.instance;
  controller.abort();
  await assertion;
  socket.receive({ type: 'ready' });
  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  expect(MockAudioContext.instance.close).toHaveBeenCalledOnce();
  expect(
    MockAudioContext.instance.createMediaStreamSource
  ).not.toHaveBeenCalled();
});
