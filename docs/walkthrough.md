# Local walkthrough

## Prerequisites

Use Node 24, npm, Docker Compose v2, and FFmpeg/FFprobe on PATH. Follow README installation and environment-copy commands. Configure backend-only GEMINI_API_KEY and the optional Gemini model names in backend/.env. Configure separate ingest-only Dash0 tokens only when telemetry verification is needed. Never show environment files, account panels, private prompts, transcripts or media in public proof.

Select a team-owned or explicitly consented recording with clear speech and useful slides. Keep its permission record and media outside git. A publicly viewable recording alone is not proof of permission to republish it. Use a short one-minute cadence for a concise local rehearsal, or five minutes for the normal walkthrough. The full source is stored locally; visual providers receive only completed elapsed clips.

## Start and present

1. Run `npm run services:up`, then `npm run db:push` and `npm run dev`. Docker runs in the background; one terminal runs both app watchers. Open http://127.0.0.1:5185/presenter.
2. Create a room and copy its invitation. Open a second browser/window with the attendee link; leave presenter controls in the first. Streaming-platform intake remains Planned. Camera is an optional explicit capture action; use the uploaded recording for this walkthrough.
3. Upload the approved recording and select the cadence. Ready means source validation completed, not that the entire recording was analyzed. Start playback; enable attendee sound if autoplay is blocked.
4. Observe finalized words arriving while media advances. At least three finalized captions can seed an early topic. Later updates follow elapsed source-time boundaries; pausing flushes released speech. Interim speech is not attendee evidence.
5. Keep playback running across a complete video interval. Observe review status and, when useful, an original timestamped still in On screen. Zero stills is a valid provider result; skipped/failed review must be reported honestly.
6. Open an earlier topic, inspect evidence, follow a spoken timestamp, then Return to now. Shared playback must continue independently of reader navigation.
7. Select Ask. A suggestion fills the composer; only Ask sends it. Open a returned source-time citation and View in transcript. Verify the intended passage receives focus and the shared media does not seek.
8. Reload the attendee page and compare committed captions, topic identity, still IDs and room revision. Private conversation disappears on reload.

## Recovery rehearsal

Use only this checkout's dedicated Compose project and loopback ports (PostgreSQL 5435, Elasticsearch 9203, API 3110, web 5185). Never reset sibling services.

- API delay/restart: stop only this API process; the attendee must show reconnect/retry. Restart it; unfinished activity pauses, committed speech/source state remains. Resume through presenter controls.
- Search: `docker compose stop elasticsearch`, probe `/api/health/ready` (503), retain PostgreSQL caption counts, and attempt Ask. Released captions remain readable; indexing jobs remain pending. `docker compose start elasticsearch` restores the service. Wait for readiness 200 and the worker to drain, then retry an actual question and confirm retrieval succeeds. `npm --prefix backend run search:rebuild` regenerates retrieval from PostgreSQL without retranscription.
- Provider failure: use deterministic behavior tests to exercise malformed output, timeouts and bounded retries. Do not claim a real outage from a fixture. Media and released words must stay usable.
- `npm run services:down` retains volumes. **Destructive:** `npm run db:reset` erases the database named by DATABASE_URL. Inspect that destination privately and use it only for the dedicated disposable local database. Removing ignored media also destroys local recordings; no automatic broad cleanup is part of this runbook.

## Accessibility and privacy

Rehearse using Tab/Shift-Tab, arrow-key tabs, Enter and Escape. Check dialog focus/return, citation focus, 200% zoom, narrow windows, reduced motion and text-spacing overrides. Images require meaningful alternative descriptions and readable unavailable states. Confirm API/provider errors are safe and retry keeps one user turn.

Synthetic privacy markers belong in isolated tests only. Run `npm run check` and the isolated PostgreSQL/Elasticsearch integration suite described in the Ask guide. Inspect Dash0 by counts and operational categories; no raw conference content or credentials may appear in public evidence. Separate deterministic fixtures, real provider calls, UI observations and configured-but-unverified integrations.

## Record and review

Record the functioning application window only, with notifications/account tabs hidden. Keep the raw recording in ignored local storage. Any submitted cut must exclude participant content unless separately authorized; sanitized operational proof can show counts/status and omit source media/private conversations. Label cuts and time compression explicitly. Do not imply a five-minute interval ran in seconds. Verify the resulting video before sharing; recording instructions are not evidence that a video exists.

## Evidence and remaining work

See development-tools.md and feature guides for dated observations and PR links. Issue #5 verified real recording transcription, topics and cited Ask with Dash0 counts. Issue #6 connects elapsed visual review to playback, released snapshots and the gallery; the controlled search interruption and recovery were verified in Brave and Dash0. Real-provider visual output recovered after the token-budget fix. Integrated still release and display were verified in Brave, including Escape closing the dialog and returning focus to its opening topic. The complete recorded video artifact, full manual accessibility matrix and post-change telemetry export checks remain verification limits. Camera hardware was deliberately not activated at the user’s request. Authenticated Dash0 MCP reading remains unverified where the running tool session does not expose that connection; signed-in Agent0 UI is a separate verified path.
