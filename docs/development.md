# Local development

Use Node 24 (`.nvmrc`), npm, and Docker Compose v2. Install with `npm ci` and `npm run install:all`. Copy the two environment examples as shown in README, start services, and apply committed migrations with `npm run db:deploy`. Start both watchers with `npm run dev`.

## Isolated resources

Compose project: `summit-thread-foundation-local`. PostgreSQL listens on loopback 5435; Elasticsearch listens on loopback 9203. API listens on loopback 3110; web on 5185. Defaults in environment examples, server settings, Vite proxy, and Compose agree. Avoid overriding service ports without updating their client URLs.

`npm run services:down` stops only this Compose project and retains named volumes. `npm run db:deploy` applies committed Prisma migrations to the dedicated local database. Use `npm run db:migrate` when changing the Prisma schema during development; it creates or updates a migration, which must be committed with the schema change. `npm run db:check` verifies that the migration history matches the schema and requires the separate `SHADOW_DATABASE_URL` from `backend/.env`; create that dedicated shadow database before running it. `npm run db:reset` is explicitly destructive: it drops data in the database identified by backend/.env DATABASE_URL and recreates its schema. Verify that URL targets the dedicated local database before running it. Never use reset on another project's database.

## Commands and recovery

`npm run contracts:generate` regenerates browser HTTP types from backend/openapi.json. `npm run typecheck`, `npm run test:boundaries`, `npm test`, and `npm run build` are available separately; `npm run check` runs generation, types, tests, and builds. `npm --prefix backend start` starts the compiled backend. `npm run services:logs` shows database/search diagnostics.

GET `/api/health/live` checks the process only. GET `/api/health/ready` probes PostgreSQL and Elasticsearch and returns 503 with a safe status when dependencies fail. Restart unavailable services and retry the room connection. The frontend shows an explicit recovery action for API startup delay.

CI uses Node 24 and locked dependencies, starts dedicated Compose services, applies committed migrations, checks migration/schema drift, runs checks/builds and a runtime readiness probe, then stops its services even on failure. AI and telemetry credentials are not required in CI. Keep CI required on protected branches and retain team-controlled merging.

No fixtures or conference content are seeded. Uploaded sources and visual caches stay in ignored backend/.data/recordings. Run FFmpeg and FFprobe on PATH for visual analysis; source validation also has a pinned packaged probe. See the walkthrough for the integrated flow.

For rooms and uploaded playback, `npm run install:all` installs the pinned platform-specific `ffprobe` binary; keep npm optional dependencies enabled. Follow [rooms and playback](features/rooms-and-playback.md). Set the backend-only `GEMINI_API_KEY` for live source-audio transcription. Media remains playable without provider access. `npm run check` also exercises isolated PostgreSQL fixture schemas, so start services and apply the canonical schema first.

## Startup troubleshooting

If Vite reports port 5185 already in use, check whether this checkout already has `npm run dev` running. Keep one development process for this checkout; stop its old process before restarting, without stopping sibling projects.

After pulling schema changes, run `npm run db:deploy` before `npm run dev`. An older database created with `db:push` can have the original tables but no migration history; `migrate deploy` then reports P3005. Do not reset it to resolve this error. From `backend/`, compare that database against the schema at the original migration commit (`82e74d369f227ce80713e16e75d0574fd0eb26ed`) with `npx prisma migrate diff --from-config-datasource --to-schema <saved-original-schema.prisma> --exit-code`. Only after an exact match (exit code 0), baseline it there with `npx prisma migrate resolve --applied 20261109150000_initial_schema`, then run `npm run db:deploy` from the repository root. This records the existing schema and applies later migrations while retaining records. If the comparison differs, investigate the drift before baselining.

Trace export must retain the OpenTelemetry SDK span's prototype methods and getters when filtering exception events and status messages. Spreading a span into a plain object loses `spanContext()` and can crash export. The regression in `src/platform/telemetry/spanPrivacy.test.ts` exports a real SDK span to a loopback test collector and checks both serialization and removal of synthetic private errors; a plain-object privacy test alone cannot verify SDK compatibility.
