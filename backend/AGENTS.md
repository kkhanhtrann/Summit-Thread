# Backend guidance

The backend is the source of truth for session state, released captions, search, and API contracts.

## Organization

- Keep product behavior under `src/features/<feature>/` with local `http/`, `application/`, `contracts/`, and `persistence/` modules as needed.
- Keep Express routes and controllers thin. Application services own behavior and must not import Express.
- Put shared configuration, Prisma, Elasticsearch, OpenAPI, and provider-neutral operational instrumentation outside product features.
- Compose feature routers and dependencies in `src/app.ts`; start and stop resources in `src/server.ts`.
- Cross-feature imports must use the target feature's `public.ts` entry point.
- Keep Prisma the canonical store. Elasticsearch indexes committed, released records and can be rebuilt from Postgres.
- Keep Gemini provider clients in shared backend platform code; use the Vercel AI SDK Google provider for answers and Google's GenAI SDK for isolated video-window transcription and visual understanding. Never hold attendee media playback while analysis runs
- Keep uploaded playback and live-camera media paths separate from analysis. Transcribe their source audio as it plays; analyze completed video windows for topic landmarks and visual moments, and keep pending windows retryable
- Require the backend-only `GEMINI_API_KEY` when a provider-backed feature runs. Never send transcript text, private questions, audio, frame pixels, or credentials to operational instrumentation.

## Reliability and privacy

- Persist each finalized live caption with a stable ID and sequence in one database transaction; enqueue indexing work in that transaction.
- Search only IDs returned from the persisted released-caption query. Never return interim recognition or future content.
- Pause live rooms after restart and make caption persistence and indexing retries repeat-safe.
- Treat Elasticsearch unavailability as an indexing/search problem; keep committed captions safe in Postgres.
- Do not log query strings, request bodies, transcript text, private questions, credentials, or raw error messages that may contain them.
- Attach only safe operational attributes to optional provider-neutral instrumentation. Add comments for state ownership, release ordering, retries, and privacy filters.

## Comments and checks

- Keep comments short and verb-led, without full stops. Use a second line only when a complex invariant needs context.
- Start each exported function, class, type, interface, and substantial constant with a concise `//` comment that explains its responsibility or contract.
- Use `//` for source comments and explain non-obvious state, privacy, query, mutation, retry, and streaming invariants. Do not narrate straightforward assignments.
- Add behavior tests before implementing a new behavior. Use dependency-injected ports where that keeps tests focused without replacing the actual product logic with mocks.
- Keep OpenAPI in this application and generate the web client types from it.
