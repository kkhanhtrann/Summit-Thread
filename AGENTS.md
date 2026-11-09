# Summit Thread

Summit Thread is a real-time conference companion that makes presentations more accessible and easier to follow. Build around evolving topic threads, timestamped evidence, catch-up, and private questions. Keep transcript and topic landmarks distinct and easy to navigate.

## Structure and ownership

- Keep the backend a modular monolith. `backend/` owns HTTP contracts, business rules, persistence, search, providers, and operational instrumentation.
- Keep feature behavior under `src/features/<feature>/`, with HTTP, application, contract, and persistence modules as needed. Add modules when behavior exists rather than filling empty folders with dummy behavior.
- Keep HTTP handlers thin: validate input, delegate to application services, and map responses. Application services must not import Express; persistence implements explicit application ports.
- Compose middleware and routers in `backend/src/app.ts`; wire dependencies and manage startup/shutdown in `server.ts`. Initialize telemetry before importing instrumented dependencies.
- Cross-feature imports use the owning feature's `public.ts` entry point. Shared configuration, runtime clients, logging, media, and telemetry belong outside feature application code.
- `web/` owns presentation and interaction. Feature API/state adapters use shared transport and backend-generated API types. Browser code must not import Prisma, PostgreSQL, Elasticsearch clients, server AI SDKs, or credentials.
- Backend OpenAPI owns implemented HTTP behavior. Regenerate `web/src/lib/api/generated.ts` when contracts change; never edit generated types manually or advertise unimplemented routes as working.
- PostgreSQL owns durable released records, revisions, source clocks, and indexing jobs. Commit finalized caption release, sequence/revision advancement, and indexing work atomically. Elasticsearch is rebuildable and never the authority for released state.

## Product behavior and privacy

- Preserve source timestamps and stable room-scoped identifiers across captions, topic evidence, and visual moments. Keep interim speech and unreleased analysis outside durable attendee state, retrieval, and answers.
- Keep playback independent from continuous source-audio transcription, topic updates, and selected-frame analysis. Submit only completed elapsed video windows, including the final shorter window at source end.
- Analyze every finalized caption in the requested interval; preserve topic transition boundaries and supplied evidence rather than silently truncating the input.
- Keep AI providers and configurable models backend-only. Use the Vercel AI SDK Google provider for grounded answers/topic generation and Google's GenAI SDK for live speech and isolated visual windows. Validate provider output before releasing it.
- Use topic history for attendee navigation and keep raw transcript search off the primary reading surface. Preserve the reader's position during catch-up and provide a return-to-now action.
- Render actual backend state. Label recording playback, planned intake controls, authored replay fixtures, and synthetic test data accurately. Never fabricate a live conference or provider success.
- Keep private conversations scoped to the selected room/browser session. Public sharing requires an explicit attendee action and clear visibility wording.
- Never commit real environment files, credentials, media, participant content, or analysis caches. Keep demo recordings team-owned or consented and stored in ignored local storage.
- Telemetry contains operational metadata only. Exclude request bodies, captions, questions, answers, audio, frame pixels, credentials, and raw content-bearing provider errors. Scrub query values, URL credentials, and fragments before export.
- Support keyboard navigation, visible focus, screen readers, reduced motion, narrow screens, enlarged text, and spacing overrides.

## Code comments

- Start each exported function, class, type, interface, and substantial constant with a concise `//` comment explaining its responsibility or contract.
- Use short, verb-led `//` comments without full stops. Add a second line only when a complex invariant needs context.
- Explain non-obvious state ownership, queries, mutations, streaming, privacy boundaries, finalization/release ordering, retries, cancellation, and recovery invariants.
- Do not narrate straightforward assignments or comment every JSX element. Update comments when the behavior or contract changes.

## Quality and team workflow

- Use Node 24 and stable, pinned dependencies with committed application lockfiles. Avoid prerelease packages.
- Add focused behavior tests before implementing new runtime behavior. Cover failure/recovery and privacy boundaries; preserve meaningful tests and static import-boundary checks.
- Run `npm run check` before delivery. Keep CI required, inspect Gitar findings and auto-applied fixes, and keep merges under team control.
- Keep each assigned workflow vertical across backend-owned contracts/application/persistence and its web experience. Work within the assigned issue scope.
- Develop independent features against agreed contracts. Coordinate shared schema, OpenAPI, generated output, composition, and integration changes with the integration owner.
- Keep local ports, Compose projects, and volumes isolated from sibling projects. Never reset or remove unrelated databases or Docker resources; document destructive commands and their dedicated scope.
- Update setup, architecture, and feature documentation when commands, ownership, contracts, or data flow change. Record actual verification and remaining limits without inventing success claims.
