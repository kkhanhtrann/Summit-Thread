import { Router, type NextFunction, type Request, type Response } from 'express';

import { privateChatRequestSchema, type PrivateChatRequest, type PrivateChatResponse } from '../contracts/privateChat.contract';

// Define the chat operation exposed to HTTP clients
export interface PrivateChatRouteService {
  ask(sessionId: string, request: PrivateChatRequest): Promise<PrivateChatResponse>;
}

// Forward asynchronous route errors to the shared error middleware
function forwardError(handler: (request: Request, response: Response, next: NextFunction) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

// Mount room-scoped private question requests
export function createPrivateChatRouter(service: PrivateChatRouteService): Router {
  const router = Router();

  router.post('/:sessionId/chat', forwardError(async (request, response) => {
    const parsedRequest = privateChatRequestSchema.safeParse(request.body);
    if (!parsedRequest.success) {
      response.status(400).json({ error: 'Enter a question between 2 and 500 characters' });
      return;
    }

    const sessionId = request.params.sessionId;
    if (typeof sessionId !== 'string' || !/^[A-F0-9]{8}$/.test(sessionId)) {
      response.status(400).json({ error: 'Session ID is invalid' });
      return;
    }

    response.json(await service.ask(sessionId, parsedRequest.data));
  }));

  return router;
}
