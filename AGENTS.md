# Summit Thread

Backend owns HTTP contracts, persistence, search, and providers. Web uses generated API types and shared transport. Application services do not import Express. Cross-feature imports use public.ts. PostgreSQL owns released records; Elasticsearch is rebuildable. Keep live/interim and unreleased analysis outside durable attendee state.

Use Node 24 and pinned lockfiles. Run npm run check before delivery. Add behavior tests before new runtime behavior. Keep comments concise and responsibility-focused. Never commit real environment files, credentials, media, participant content, or analysis caches. Telemetry contains operational metadata only. Keep CI required and merges under team control. Do not implement later feature issues as part of the foundation.
