import {
  Router,
  type Request,
  type Response,
  type NextFunction
} from 'express';

import {
  createSessionSchema,
  roomCodeSchema,
  type CreateSessionRequest,
  type SessionEvent,
  type SessionSnapshot
} from '../contracts/session.contract';

// Define the session operations exposed through HTTP
export interface SessionRouteService {
  createSession(input: CreateSessionRequest): Promise<SessionSnapshot>;
  getSnapshot(sessionId: string): Promise<SessionSnapshot>;
  subscribe(
    sessionId: string,
    listener: (event: SessionEvent) => void
  ): () => void;
}

// Forward asynchronous route failures to the shared error middleware
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

// Serialize a revisioned update for the SSE stream
function writeEvent(
  response: Response,
  event: string,
  revision: number,
  payload: unknown
) {
  if (response.writableLength > 262144) {
    response.destroy();
    return;
  }
  response.write(
    `id: ${revision}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  );
}

// Compose room creation, snapshot, search, and live-update endpoints
export function createSessionRouter(service: SessionRouteService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });
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
    '/',
    forwardError(async (request, response) => {
      const parsedRequest = createSessionSchema.safeParse(request.body);
      if (!parsedRequest.success) {
        response
          .status(400)
          .json({
            error: 'A session title between 1 and 100 characters is required'
          });
        return;
      }

      response
        .status(201)
        .json(await service.createSession(parsedRequest.data));
    })
  );

  router.get('/:sessionId/events', (request, response, next) => {
    const pendingEvents: SessionEvent[] = [];
    let closed = false;
    let hasSnapshot = false;
    let unsubscribe: () => void = () => undefined;
    let heartbeat: NodeJS.Timeout | undefined;

    const close = () => {
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    };

    response.on('close', close);
    const sessionId = request.params.sessionId;
    if (typeof sessionId !== 'string') {
      response.status(400).json({ error: 'Session ID is invalid' });
      return;
    }
    // Subscribe before reading the snapshot so updates during the request are buffered
    unsubscribe = service.subscribe(sessionId, (event) => {
      if (!hasSnapshot) {
        if (pendingEvents.length >= 1000) {
          close();
          response.end();
          return;
        }
        pendingEvents.push(event);
        return;
      }
      writeEvent(response, event.type, event.revision, event);
    });

    void service
      .getSnapshot(sessionId)
      .then((snapshot) => {
        if (closed || response.destroyed) return;
        response.status(200);
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        response.setHeader('Cache-Control', 'no-cache, no-transform');
        response.setHeader('Connection', 'keep-alive');
        response.setHeader('X-Accel-Buffering', 'no');
        response.flushHeaders();
        writeEvent(response, 'snapshot', snapshot.session.revision, {
          type: 'snapshot',
          ...snapshot
        });
        hasSnapshot = true;
        // Skip buffered updates already represented by the initial snapshot revision
        for (const event of pendingEvents) {
          if (event.revision > snapshot.session.revision)
            writeEvent(response, event.type, event.revision, event);
        }
        heartbeat = setInterval(
          () => response.write(': keep-alive\n\n'),
          20_000
        );
      })
      .catch((error: unknown) => {
        close();
        if (response.headersSent) response.end();
        else next(error);
      });
  });

  router.get(
    '/:sessionId',
    forwardError(async (request, response) => {
      const sessionId = request.params.sessionId;
      if (typeof sessionId !== 'string') {
        response.status(400).json({ error: 'Session ID is invalid' });
        return;
      }
      response.json(await service.getSnapshot(sessionId));
    })
  );

  return router;
}
