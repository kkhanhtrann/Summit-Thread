# Local development

Use Node 24 (`.nvmrc`), npm, and Docker Compose v2. Install with `npm ci` and `npm run install:all`. Copy the two environment examples as shown in README, start services, and apply the schema with `npm run db:push`. Start both watchers with `npm run dev`.

## Isolated resources

Compose project: `summit-thread-foundation-local`. PostgreSQL listens on loopback 5435; Elasticsearch listens on loopback 9203. API listens on loopback 3110; web on 5185. Defaults in environment examples, server settings, Vite proxy, and Compose agree. Avoid overriding service ports without updating their client URLs.

`npm run services:down` stops only this Compose project and retains named volumes. `npm run db:push` applies the Prisma schema to the dedicated local database; this is the schema-driven development policy, with no migration deployment command. `npm run db:reset` is explicitly destructive: it drops data in the database identified by backend/.env DATABASE_URL and recreates its schema. Verify that URL targets the dedicated local database before running it. Never use reset on another project's database.

## Commands and recovery

`npm run contracts:generate` regenerates browser HTTP types from backend/openapi.json. `npm run typecheck`, `npm run test:boundaries`, `npm test`, and `npm run build` are available separately; `npm run check` runs generation, types, tests, and builds. `npm --prefix backend start` starts the compiled backend. `npm run services:logs` shows database/search diagnostics.

GET `/api/health/live` checks the process only. GET `/api/health/ready` probes PostgreSQL and Elasticsearch and returns 503 with a safe status when dependencies fail. Restart unavailable services and retry the room connection. The frontend shows an explicit recovery action for API startup delay.

CI uses Node 24 and locked dependencies, starts dedicated Compose services, applies the same schema, runs checks/builds and a runtime readiness probe, then stops its services even on failure. AI and telemetry credentials are not required in CI. Keep CI required on protected branches and retain team-controlled merging.

No fixtures or conference content are seeded. Uploaded sources and visual caches stay in ignored backend/.data/recordings. Run FFmpeg and FFprobe on PATH for visual analysis; source validation also has a pinned packaged probe. See the walkthrough for the integrated flow.

For rooms and uploaded playback, `npm run install:all` installs the pinned platform-specific `ffprobe` binary; keep npm optional dependencies enabled. Follow [rooms and playback](features/rooms-and-playback.md). Set the backend-only `GEMINI_API_KEY` for live source-audio transcription. Media remains playable without provider access. `npm run check` also exercises isolated PostgreSQL fixture schemas, so start services and apply the canonical schema first.
