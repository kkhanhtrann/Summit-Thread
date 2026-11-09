import { createReadStream } from 'node:fs';
import {
  Router,
  type Request,
  type Response,
  type NextFunction
} from 'express';
import { finished } from 'node:stream/promises';
import { z } from 'zod';

import {
  roomCodeSchema,
  type SessionRecordingView
} from '../contracts/session.contract';
import { MAX_RECORDING_BYTES } from '../../../platform/media/localRecordingAssets';

// Keep presenter choices aligned with supported analysis windows
const ANALYSIS_WINDOW_MINUTES = new Set([1, 3, 5, 10]);

// Define recording operations exposed through the room HTTP boundary
export interface PreparedRecordingRouteService {
  upload(
    sessionId: string,
    mimeType: string,
    chunks: AsyncIterable<Uint8Array>,
    analysisWindowMinutes: number
  ): Promise<SessionRecordingView>;
  updatePlayback(
    sessionId: string,
    positionMs: number,
    isPlaying: boolean
  ): Promise<SessionRecordingView>;
  getMediaFile(
    sessionId: string
  ): Promise<{ path: string; size: number; mimeType: string }>;
}

// Validate updates from the presenter's media timeline
const playbackUpdateSchema = z
  .object({
    positionMs: z.number().int().nonnegative(),
    isPlaying: z.boolean()
  })
  .strict();

// Forward asynchronous route errors to the shared safe response middleware
function forwardError(
  handler: (
    request: Request,
    response: Response,
    next: NextFunction
  ) => Promise<void>
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

// Parse one browser byte range for media seeking and metadata reads
function parseByteRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start >= size ||
    requestedEnd < start
  )
    return null;
  return { start, end: Math.min(size - 1, requestedEnd) };
}

// Stream a protected media file with browser-compatible seeking headers
async function streamAsset(
  request: Request,
  response: Response,
  path: string,
  size: number,
  contentType: string
): Promise<void> {
  const range = parseByteRange(request.headers.range, size);
  if (range === null) {
    response.setHeader('Content-Range', `bytes */${size}`);
    response.status(416).end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  response.status(range ? 206 : 200);
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Content-Type', contentType);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Length', Math.max(0, end - start + 1));
  if (range)
    response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const source = createReadStream(path, { start, end });
  const fail = () => response.destroy();
  source.once('error', fail);
  source.pipe(response);
  try {
    await finished(response, { cleanup: true });
  } finally {
    source.off('error', fail);
    source.destroy();
  }
}

// Accept uploads, synchronize playback, and serve only released visual frames
export function createPreparedRecordingRouter(
  service: PreparedRecordingRouteService
): Router {
  const router = Router();
  router.param('sessionId', (req, res, next, code: string) => {
    const parsed = roomCodeSchema.safeParse(code);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter an eight-character room code' });
      return;
    }
    req.params.sessionId = parsed.data;
    next();
  });

  router.post(
    '/:sessionId/recording',
    forwardError(async (request, response) => {
      const sessionId = request.params.sessionId;
      const mimeType = request.headers['content-type'];
      if (typeof sessionId !== 'string') {
        response.status(400).json({ error: 'Session ID is invalid' });
        return;
      }
      if (typeof mimeType !== 'string') {
        response
          .status(415)
          .json({ error: 'Choose a supported audio or video file' });
        return;
      }
      const requestedWindow = request.headers['x-thread-update-minutes'];
      const analysisWindowMinutes =
        requestedWindow === undefined ? 5 : Number(requestedWindow);
      if (
        !Number.isInteger(analysisWindowMinutes) ||
        !ANALYSIS_WINDOW_MINUTES.has(analysisWindowMinutes)
      ) {
        response
          .status(400)
          .json({
            error: 'Choose a thread update interval of 1, 3, 5, or 10 minutes'
          });
        return;
      }
      const contentLength = Number(request.headers['content-length']);
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_RECORDING_BYTES
      ) {
        response
          .status(413)
          .json({ error: 'Choose a recording no larger than 300 MiB' });
        return;
      }
      const recording = await service.upload(
        sessionId.toUpperCase(),
        mimeType,
        request,
        analysisWindowMinutes
      );
      response.status(202).json({ recording });
    })
  );

  router.post(
    '/:sessionId/recording/playback',
    forwardError(async (request, response) => {
      const sessionId = request.params.sessionId;
      if (typeof sessionId !== 'string') {
        response.status(400).json({ error: 'Session ID is invalid' });
        return;
      }
      const parsed = playbackUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'Playback update is invalid' });
        return;
      }
      const recording = await service.updatePlayback(
        sessionId.toUpperCase(),
        parsed.data.positionMs,
        parsed.data.isPlaying
      );
      response.json({ recording });
    })
  );

  const serveMedia = forwardError(async (request, response) => {
    const sessionId = request.params.sessionId;
    if (typeof sessionId !== 'string') {
      response.status(400).end();
      return;
    }
    const asset = await service.getMediaFile(sessionId.toUpperCase());
    await streamAsset(
      request,
      response,
      asset.path,
      asset.size,
      asset.mimeType
    );
  });
  router.get('/:sessionId/recording/media', serveMedia);
  router.head('/:sessionId/recording/media', serveMedia);

  return router;
}
