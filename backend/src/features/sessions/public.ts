export * from './contracts/session.contract';
export * from './contracts/visualMoment.contract';
// Expose presenter material contracts, limits and errors
export * from './contracts/material.contract';
export { RoomService } from './application/roomService';
export { RecordingService } from './application/recordingService';
// Expose visual-moment composition for app wiring and the room snapshot owner
export { VisualMomentService } from './application/visualMomentService';
export type { VisualEventPort, VisualMomentTelemetryPort } from './application/visualMomentService';
export { PrismaVisualMomentRepository } from './persistence/prismaVisualMoment.repository';
export { createVisualMomentRouter } from './http/visualMoments.routes';
export { ReleasedContentRepository } from './persistence/releasedContent.repository';
export { SessionIndexingWorker } from './application/sessionIndexingWorker';
export type { ReleasedRoomContent, IndexQueueRepository } from './contracts/releasedContent';

// Expose camera lifecycle and room signaling to server composition
export { CameraService } from './application/cameraService';
export { attachLiveMediaWebSocket } from './http/liveMediaWebSocket';
// Expose presenter material intake to app and server composition
export { MaterialService } from './application/materialService';
export type { MaterialRouteService, MaterialRepository } from './application/materialService';
export { PrismaMaterialRepository } from './persistence/prismaMaterial.repository';
export { createMaterialRouter } from './http/materials.routes';
// Expose presenter background lookup for topic analysis composition
export { createMaterialBackgroundProvider } from './application/materialBackground';
