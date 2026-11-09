// Describe live speech and connection events sent to the presenter view
export type LiveSpeechEvent =
  | { type: 'ready' | 'finalized' | 'stopping' | 'stopped' }
  | { type: 'connection'; state: 'reconnecting' | 'ready' }
  | { type: 'interim'; text: string }
  | { type: 'error'; message: string; retryable?: boolean };

// Keep source audio attached to one room transcript without taking ownership of its tracks
export interface LiveCapture {
  setPosition(positionMs: number): void;
  stop(): Promise<void>;
}

// Build a same-origin live transcript route for the selected room
function websocketUrl(sessionId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/api/live/${encodeURIComponent(sessionId)}/transcription`;
}

// Convert normalized Web Audio samples into mono signed 16-bit PCM
export function encodePcm16(samples: Float32Array): ArrayBuffer {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

// Stream the selected source audio to the room’s live transcript
export async function connectLiveTranscription(
  sessionId: string,
  sourceStream: MediaStream,
  onEvent: (event: LiveSpeechEvent) => void,
  options: { initialPositionMs?: number; signal?: AbortSignal } = {}
): Promise<LiveCapture> {
  if (
    !sourceStream.getAudioTracks().some((track) => track.readyState === 'live')
  ) {
    throw new Error(
      'This source has no active audio track. Choose audio or video with sound.'
    );
  }

  let audioContext: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let silentOutput: GainNode | undefined;
  let socket: WebSocket | undefined;
  let startTimer: number | undefined;
  let reconnectTimer: number | undefined;
  let stopTimer: number | undefined;
  let positionMs = options.initialPositionMs ?? 0;
  let socketGeneration = 0;
  let readyGeneration = 0;
  let retries = 0;
  let audioActivated = false;
  let stopRequested = false;
  let terminalError = false;
  let stopPromise: Promise<void> | undefined;
  let stopAcknowledged: (() => void) | undefined;
  let bufferedAudioBytes = 0;
  const bufferedAudio: ArrayBuffer[] = [];
  const retryDelaysMs = [300, 600, 1_200, 2_400, 4_800] as const;
  const maxBufferedAudioBytes = 320_000;

  // Release only the transcription graph because the presenter owns the source stream
  let released: Promise<void> | undefined;
  const releaseAudioGraph = () =>
    (released ??= (async () => {
      processor?.disconnect();
      source?.disconnect();
      silentOutput?.disconnect();
      processor?.port.close();
      if (audioContext && audioContext.state !== 'closed')
        await audioContext.close();
    })());

  return await new Promise<LiveCapture>((resolve, reject) => {
    let started = false;
    const abort = () => {
      void capture.stop().finally(() => {
        if (!started) reject(new Error('Transcript capture was cancelled.'));
      });
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    // Preserve one actionable failure and stop retrying after a final server error
    const fail = (message: string) => {
      if (terminalError || stopRequested) return;
      terminalError = true;
      if (startTimer !== undefined) window.clearTimeout(startTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      onEvent({ type: 'error', message });
      if (!started) reject(new Error(message));
      void releaseAudioGraph();
      socket?.close();
    };

    // Keep at most ten seconds of source audio while the room connection recovers
    const queueAudio = (audio: ArrayBuffer) => {
      if (bufferedAudioBytes + audio.byteLength > maxBufferedAudioBytes) {
        fail(
          'The transcript is behind the talk. Pause and resume to reconnect.'
        );
        return;
      }
      bufferedAudio.push(audio.slice(0));
      bufferedAudioBytes += audio.byteLength;
    };

    // Send buffered frames in order after the latest room socket is ready
    const flushAudio = (target: WebSocket, generation: number) => {
      while (
        bufferedAudio.length &&
        target === socket &&
        target.readyState === WebSocket.OPEN &&
        readyGeneration === generation &&
        !stopRequested &&
        !terminalError
      ) {
        if (target.bufferedAmount > 64_000) return;
        const audio = bufferedAudio.shift()!;
        target.send(audio);
        bufferedAudioBytes -= audio.byteLength;
      }
    };

    // Forward source positions so each finalized line stays next to the spoken moment
    const sendPosition = (target: WebSocket, generation: number) => {
      if (
        target === socket &&
        target.readyState === WebSocket.OPEN &&
        readyGeneration === generation
      ) {
        target.send(JSON.stringify({ type: 'position', positionMs }));
      }
    };

    // Build one silent audio graph while the original player keeps its sound
    const activateAudio = async () => {
      if (audioActivated) return;
      source = audioContext!.createMediaStreamSource(sourceStream);
      processor = new AudioWorkletNode(
        audioContext!,
        'summit-thread-pcm-capture',
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1]
        }
      );
      silentOutput = audioContext!.createGain();
      silentOutput.gain.value = 0;
      processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (stopRequested || terminalError) return;
        const audio = encodePcm16(event.data);
        if (
          bufferedAudio.length ||
          !socket ||
          socket.readyState !== WebSocket.OPEN ||
          readyGeneration !== socketGeneration ||
          socket.bufferedAmount > 64_000
        ) {
          queueAudio(audio);
          if (socket) flushAudio(socket, socketGeneration);
          return;
        }
        socket.send(audio);
      };
      source.connect(processor);
      processor.connect(silentOutput);
      silentOutput.connect(audioContext!.destination);
      await audioContext!.resume();
      audioActivated = true;
    };

    // Retry short browser-to-server interruptions while preserving the media clock
    const scheduleReconnect = (generation: number) => {
      if (
        stopRequested ||
        terminalError ||
        generation !== socketGeneration ||
        reconnectTimer !== undefined
      )
        return;
      if (retries >= retryDelaysMs.length) {
        fail(
          'The transcript lost its connection. Pause and resume to try again.'
        );
        return;
      }
      onEvent({ type: 'connection', state: 'reconnecting' });
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        if (
          !stopRequested &&
          !terminalError &&
          generation === socketGeneration
        ) {
          if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
          openSocket();
        }
      }, retryDelaysMs[retries++]!);
    };

    // Open a bounded room socket and ignore late events from replaced connections
    const openSocket = () => {
      const generation = ++socketGeneration;
      readyGeneration = 0;
      const nextSocket = new WebSocket(websocketUrl(sessionId));
      nextSocket.binaryType = 'arraybuffer';
      socket = nextSocket;
      nextSocket.onmessage = (event) => {
        if (generation !== socketGeneration || terminalError) return;
        let message: {
          type?: string;
          text?: string;
          message?: string;
          state?: 'reconnecting' | 'ready';
          retryable?: boolean;
        };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch {
          fail(
            'The transcript couldn’t be updated. Pause and resume the talk to try again.'
          );
          return;
        }
        if (message.type === 'ready') {
          if (stopRequested) return;
          readyGeneration = generation;
          retries = 0;
          sendPosition(nextSocket, generation);
          if (!audioActivated) {
            void activateAudio()
              .then(() => {
                if (stopRequested || terminalError) return;
                started = true;
                if (startTimer !== undefined) window.clearTimeout(startTimer);
                onEvent({ type: 'ready' });
                resolve(capture);
              })
              .catch(() =>
                fail(
                  'We couldn’t read audio from the recording. Check the file and try again.'
                )
              );
          } else {
            onEvent({ type: 'connection', state: 'ready' });
            flushAudio(nextSocket, generation);
          }
        } else if (message.type === 'connection' && message.state) {
          onEvent({ type: 'connection', state: message.state });
          if (message.state === 'ready') flushAudio(nextSocket, generation);
        } else if (
          message.type === 'interim' &&
          typeof message.text === 'string'
        ) {
          onEvent({ type: 'interim', text: message.text });
        } else if (message.type === 'error') {
          if (message.retryable) scheduleReconnect(generation);
          else
            fail(
              message.message ||
                'Live words could not connect. Pause and resume to try again.'
            );
        } else if (
          message.type === 'finalized' ||
          message.type === 'stopping' ||
          message.type === 'stopped'
        ) {
          onEvent({ type: message.type });
          if (message.type === 'stopped') stopAcknowledged?.();
        }
      };
      nextSocket.onerror = () => scheduleReconnect(generation);
      nextSocket.onclose = () => {
        if (generation !== socketGeneration) return;
        readyGeneration = 0;
        stopAcknowledged?.();
        scheduleReconnect(generation);
      };
    };

    // Stop capture once and wait briefly for final words to reach the room
    const capture: LiveCapture = {
      setPosition(nextPositionMs) {
        if (
          !Number.isSafeInteger(nextPositionMs) ||
          nextPositionMs < 0 ||
          stopRequested
        )
          return;
        positionMs = nextPositionMs;
        if (socket && readyGeneration === socketGeneration)
          sendPosition(socket, socketGeneration);
      },
      stop() {
        if (stopPromise) return stopPromise;
        stopRequested = true;
        options.signal?.removeEventListener('abort', abort);
        if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
        if (startTimer !== undefined) window.clearTimeout(startTimer);
        stopPromise = (async () => {
          await releaseAudioGraph();
          if (
            !socket ||
            socket.readyState !== WebSocket.OPEN ||
            readyGeneration !== socketGeneration
          ) {
            socket?.close();
            return;
          }
          const acknowledgement = new Promise<void>((finish) => {
            stopAcknowledged = () => {
              if (stopTimer !== undefined) window.clearTimeout(stopTimer);
              finish();
            };
            stopTimer = window.setTimeout(finish, 4_000);
          });
          socket.send(JSON.stringify({ type: 'stop' }));
          await acknowledgement;
          stopAcknowledged = undefined;
          if (stopTimer !== undefined) window.clearTimeout(stopTimer);
          socket.close();
        })();
        return stopPromise;
      }
    };

    if (options.signal?.aborted) {
      fail('Transcript capture was cancelled.');
      return;
    }
    // Start the audio graph only after the backend confirms its provider session
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) {
      reject(new Error('Live words are not available in this browser.'));
      return;
    }
    try {
      audioContext = new AudioContextConstructor({ sampleRate: 16_000 });
    } catch {
      audioContext = new AudioContextConstructor();
    }
    void audioContext
      .resume()
      .catch(() => fail('This browser could not start audio processing.'));
    void audioContext.audioWorklet
      .addModule('/pcm-capture-processor.js')
      .then(() => {
        if (stopRequested || terminalError) return;
        startTimer = window.setTimeout(
          () =>
            fail(
              'The transcript couldn’t connect. Pause and resume the talk to try again.'
            ),
          20_000
        );
        openSocket();
      })
      .catch(() => fail('This browser can’t start the transcript.'));
  });
}
