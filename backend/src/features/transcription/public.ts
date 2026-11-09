// Expose backend speech ports for provider adapters and server composition
export * from './application/liveTranscriptionCoordinator';
export { attachLiveTranscriptionWebSocket } from './http/liveTranscriptionWebSocket';
