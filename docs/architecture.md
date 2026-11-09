# Architecture and handoff

Two TypeScript applications target Node 24. Express composes the backend modular monolith; Vite/React renders the browser. PostgreSQL/Prisma owns durable state. Elasticsearch is backend-owned, rebuildable retrieval infrastructure. Keep credentials and AI provider SDKs on the backend.

## Ownership

`backend/src/app.ts` composes HTTP middleware and routes. `server.ts` wires clients and manages lifecycle; telemetry initializes through the Node preload before instrumented imports. Feature HTTP validates and delegates; application services depend on explicit ports, not Express. Persistence implements its owning feature's ports. Shared clients/configuration/instrumentation belong outside application services. Cross-feature imports use `public.ts`. Add feature modules when behavior exists; do not add dummy implementations.

The integration owner coordinates schema changes, app composition, OpenAPI and generated output. Each feature owner delivers its backend and web behavior vertically. Browser API/state adapters use `web/src/lib/api/http.ts`; pages own presentation. Static tests enforce browser provider/storage exclusion, application/Express separation, and feature entry points.

## Shared schema and contracts

`backend/prisma/schema.prisma` establishes rooms, released-caption sequences, revisions, source/playback state, topic threads/occurrences, selected visual metadata, and indexing jobs. It establishes storage structure, not working product endpoints. Caption writes, release cursor/revision updates, and indexing jobs must commit atomically in the feature implementation. Elasticsearch can be rebuilt from committed records and cannot release content.

`backend/src/features/sessions/contracts/session.contract.ts` defines initial room creation/snapshot, captions, topic evidence, source/playback/upload/window status and revisioned event shapes. `private-chat/contracts/privateChat.contract.ts` establishes private question/history/citation shapes; `search/contracts/captionSearch.ts` is the released-caption retrieval port. These are handoff contracts; coordinate limits and additions with feature owners. Backend OpenAPI describes implemented HTTP routes: health, plus the visual-moment image and live-clip routes (see `docs/features/visual-moments.md`). Extend it and regenerate `web/src/lib/api/generated.ts` when a feature adds working HTTP behavior. Document WebSocket message validation and finalization/flush ordering when transcription is implemented.

Room codes are eight characters; source timestamps and room-scoped stable identifiers govern evidence. Interim speech and unreleased analysis remain outside durable attendee state. SSE revisions must support snapshot refresh after gaps and reconcile concurrent events. Playback, continuous transcription, topic work and selected-frame work run independently. No attendee workflow waits for full media analysis.

ST-02 owns rooms/media/transcription; ST-03 owns thread identities, evidence and catch-up; ST-04 owns elapsed video windows and released original stills; ST-05 owns durable retrieval and private cited answers. Agree interface extensions before changing shared contracts. ST-06 integrates the resulting workflows and evidence. Deployment, login, TURN and Kubernetes are outside this local foundation.
