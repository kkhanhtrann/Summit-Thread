# Summit Thread review instructions

- Preserve the modular-monolith and vertical-feature boundaries in `docs/architecture.md`.
- The backend owns API contracts, business rules, durable writes, and search access. The web app must not connect directly to a database, Elasticsearch, or AI provider.
- Treat each presenter-created room as a real live session. Verify that only finalized source-audio captions committed to PostgreSQL appear in attendee views, private answers, or search.
- Keep the repository private and keep secrets, attendee identifiers, private questions, and transcript bodies out of source, logs, traces, and telemetry.
- Check that attendees can join by the presenter’s code or link and that presenters create a room before starting recording playback and source-audio capture. Presenter controls are local and are not authenticated access controls.
- Keep comments short and verb-led. Explain responsibilities and non-obvious invariants without narrating straightforward code.
- Check setup instructions against actual scripts and configuration. Call out commands that have not been exercised.
- Review live transcription and private answers for released-content scoping, credential handling, citations, and transcript privacy. Flag authentication, deployment, or extra infrastructure that falls outside the current roadmap.
