import type {
  LiveSpeechProvider,
  LiveSpeechSession,
  LiveSpeechUpdate
} from '../../features/transcription/public';

// Provide backend-only Gemini credentials and the Live transcription model
export interface GeminiLiveTranscriptionConfiguration {
  apiKey: string;
  model: string;
}

// Connect the shared transcription boundary to Gemini Live
export function createGeminiLiveTranscriptionProvider(
  configuration: GeminiLiveTranscriptionConfiguration
): LiveSpeechProvider {
  return {
    async connect(
      onTranscript: (update: LiveSpeechUpdate) => void,
      onError: () => void,
      onConnectionState?: (state: 'reconnecting' | 'ready') => void
    ): Promise<LiveSpeechSession> {
      if (!configuration.apiKey.trim())
        throw new Error('Live speech credentials are not configured');
      const { GoogleGenAI, Modality } = await import('@google/genai');
      const client = new GoogleGenAI({ apiKey: configuration.apiKey });
      // Bound buffered speech while a resumed connection is being restored
      const maxQueuedAudioBytes = 512_000;
      // Invalidate callbacks as provider sessions are replaced
      let currentSession:
        | Awaited<ReturnType<typeof client.live.connect>>
        | undefined;
      let connectionId = 0;
      let closing = false;
      let ending = false;
      // Coalesce reconnects while preserving the latest resumable handle and pending audio
      let reconnecting = false;
      // Retain one terminal report and one provider reconnect promise at a time
      let terminalFailureReported = false;
      let resumptionHandle: string | undefined;
      let reconnectPromise: Promise<void> | undefined;
      let rotationTimer: ReturnType<typeof setTimeout> | undefined;
      let queuedAudioBytes = 0;
      const queuedAudio: Buffer[] = [];

      // Report only one terminal provider failure to the capture coordinator
      const reportFailure = () => {
        if (closing || terminalFailureReported) return;
        terminalFailureReported = true;
        onError();
      };

      // Send queued frames in order after the resumed session is ready
      const flushQueuedAudio = () => {
        while (
          queuedAudio.length &&
          currentSession &&
          !reconnecting &&
          !closing
        ) {
          const audio = queuedAudio[0]!;
          try {
            currentSession.sendRealtimeInput({
              audio: {
                data: audio.toString('base64'),
                mimeType: 'audio/pcm;rate=16000'
              }
            });
          } catch {
            void reconnect(resumptionHandle, 'send_failed');
            return;
          }
          queuedAudio.shift();
          queuedAudioBytes -= audio.length;
        }
      };

      // Keep one provider reconnect path for GoAway and unexpected socket closes
      const reconnect = (
        handle: string | undefined,
        _trigger:
          | 'go_away'
          | 'socket_error'
          | 'socket_close'
          | 'send_failed'
          | 'scheduled_rotation'
      ): Promise<void> => {
        if (closing || ending || reconnectPromise)
          return reconnectPromise ?? Promise.resolve();
        reconnecting = true;
        connectionId += 1;
        const previousSession = currentSession;
        currentSession = undefined;
        if (rotationTimer) clearTimeout(rotationTimer);
        onConnectionState?.('reconnecting');
        reconnectPromise = (async () => {
          previousSession?.close();
          let nextHandle = handle;
          // Retry with increasing delays before reporting a terminal interruption
          for (let attempt = 0; attempt < 5; attempt += 1) {
            if (closing || ending) return;
            if (attempt > 0)
              await new Promise((resolve) =>
                setTimeout(resolve, 250 * 2 ** (attempt - 1))
              );
            try {
              const resumedSession = await connectSession(nextHandle);
              if (closing) {
                resumedSession?.close();
                currentSession = undefined;
                return;
              }
              reconnecting = false;
              onConnectionState?.('ready');
              flushQueuedAudio();
              scheduleRotation();
              return;
            } catch {
              // Fall back to a fresh recognition session if the saved handle expired
              nextHandle = undefined;
            }
          }
          reconnecting = false;
          reportFailure();
        })().finally(() => {
          reconnectPromise = undefined;
        });
        return reconnectPromise;
      };

      // Rotate before the live transcription session reaches its ten minute limit
      const scheduleRotation = () => {
        if (rotationTimer) clearTimeout(rotationTimer);
        rotationTimer = setTimeout(
          () => void reconnect(resumptionHandle, 'scheduled_rotation'),
          8 * 60_000
        );
      };

      // Open the same transcription stream with an optional resumable state handle
      const connectSession = async (
        handle?: string
      ): Promise<
        Awaited<ReturnType<typeof client.live.connect>> | undefined
      > => {
        const thisConnectionId = ++connectionId;
        // Race setup against a close so a dropped handshake cannot stall retries
        let rejectBeforeSetup: ((error: Error) => void) | undefined;
        let ready = false;
        const closedBeforeSetup = new Promise<never>((_resolve, reject) => {
          rejectBeforeSetup = reject;
        });
        let setupTimer: ReturnType<typeof setTimeout> | undefined;
        const connection = client.live.connect({
          model: configuration.model,
          config: {
            responseModalities: [Modality.TEXT],
            inputAudioTranscription: { languageCodes: [] },
            sessionResumption: handle ? { handle } : {}
          },
          callbacks: {
            onmessage(message) {
              if (thisConnectionId !== connectionId || closing) return;
              if (message.setupComplete) ready = true;
              const content = message.serverContent;
              const interim = content?.interimInputTranscription?.text;
              const finalText = content?.inputTranscription?.text;
              if (message.sessionResumptionUpdate) {
                const update = message.sessionResumptionUpdate;
                resumptionHandle =
                  update.resumable && update.newHandle
                    ? update.newHandle
                    : undefined;
              }
              if (interim) onTranscript({ type: 'interim', text: interim });
              if (finalText) onTranscript({ type: 'final', text: finalText });
              if (message.goAway) void reconnect(resumptionHandle, 'go_away');
            },
            onerror() {
              if (thisConnectionId !== connectionId || closing) return;
              if (!ready)
                rejectBeforeSetup?.(
                  new Error('provider connection failed before setup')
                );
              else void reconnect(resumptionHandle, 'socket_error');
            },
            onclose() {
              if (thisConnectionId !== connectionId || closing) return;
              if (!ready)
                rejectBeforeSetup?.(
                  new Error('provider connection closed before setup')
                );
              else void reconnect(resumptionHandle, 'socket_close');
            }
          }
        });

        setupTimer = setTimeout(
          () =>
            rejectBeforeSetup?.(
              new Error('provider connection setup timed out')
            ),
          12_000
        );
        let session: Awaited<typeof connection>;
        try {
          session = await Promise.race([connection, closedBeforeSetup]);
        } catch (error) {
          if (thisConnectionId === connectionId) connectionId += 1;
          // Close a late session if the SDK resolves after the setup deadline
          void connection
            .then((lateSession) => lateSession.close())
            .catch(() => undefined);
          throw error;
        } finally {
          if (setupTimer) clearTimeout(setupTimer);
        }

        if (thisConnectionId !== connectionId || closing) {
          session.close();
          return undefined;
        }
        ready = true;
        currentSession = session;
        return session;
      };

      await connectSession();
      onConnectionState?.('ready');
      scheduleRotation();

      return {
        sendAudio(audio) {
          if (closing || terminalFailureReported) return;
          if (reconnecting || !currentSession) {
            if (queuedAudioBytes + audio.length > maxQueuedAudioBytes) {
              reportFailure();
              return;
            }
            queuedAudio.push(Buffer.from(audio));
            queuedAudioBytes += audio.length;
            return;
          }
          try {
            currentSession.sendRealtimeInput({
              audio: {
                data: audio.toString('base64'),
                mimeType: 'audio/pcm;rate=16000'
              }
            });
          } catch {
            // Keep the frame that revealed a stale provider socket for recovery
            if (queuedAudioBytes + audio.length > maxQueuedAudioBytes) {
              reportFailure();
              return;
            }
            queuedAudio.push(Buffer.from(audio));
            queuedAudioBytes += audio.length;
            void reconnect(resumptionHandle, 'send_failed');
          }
        },
        async finish() {
          ending = true;
          if (rotationTimer) clearTimeout(rotationTimer);
          await Promise.race([
            reconnectPromise?.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 1500))
          ]);
          currentSession?.sendRealtimeInput({ audioStreamEnd: true });
          // Allow the provider to flush a final recognition event before closing
          await new Promise((resolve) => setTimeout(resolve, 900));
        },
        async close() {
          closing = true;
          connectionId += 1;
          if (rotationTimer) clearTimeout(rotationTimer);
          currentSession?.close();
          currentSession = undefined;
        }
      };
    }
  };
}
