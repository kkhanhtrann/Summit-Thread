# Web guidance

The web app is a Vite and React client of the backend API.

## Organization

- Keep page-level experiences under `src/features/<feature>/` with local components, API adapters, contracts, and state.
- Keep app bootstrap, shared HTTP transport, generated OpenAPI types, and reusable UI primitives outside product features.
- Generate `src/lib/api/generated.ts` from `../backend/openapi.json`; do not hand-edit generated output.
- Call APIs through the shared HTTP transport. Do not add raw `fetch` calls inside feature components.
- Never import Prisma, PostgreSQL, Elasticsearch, server SDKs, or AI-provider SDKs into the browser. Gemini credentials remain on the backend.
- Keep reading and presenter views separate. Presenter controls are local demo controls and must not look like protected admin access.

## Interface and accessibility

- Follow the reading-first context in `.impeccable.md` and the supplied HTML's workflows.
- Render only session data returned by the backend. Distinguish uploaded playback from the host's live camera feed and make the presenter-created room and attendee link clear
- Keep attendee media moving while the room thread updates on the presenter-selected interval
- Keep the reader still while attendees inspect earlier search results; provide a clear action to return to the newest caption.
- Support keyboard operation, visible focus, screen readers, reduced motion, narrow screens, enlarged text, and spacing overrides.
- Keep attendee questions and transcript content out of telemetry. Scrub search query text from browser request URLs before exporting telemetry.

## Comments and checks

- Keep comments short and verb-led, without full stops. Use a second line only when a complex invariant needs context.
- Start each exported function, class, type, interface, and substantial constant with a concise `//` comment that explains its responsibility or contract.
- Use `//` for source comments and explain non-obvious interaction, privacy, recovery, and streaming invariants. Do not comment every assignment or JSX element.
- Add behavior tests before implementing a new interaction. Keep tests focused on the user-visible contract.
