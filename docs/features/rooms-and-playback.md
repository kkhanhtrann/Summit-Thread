# Rooms and recording playback

ST-02 gives a presenter a fresh room, an attendee invitation, validated uploaded media, shared playback, and progressively released source speech. PostgreSQL owns released words and playback metadata. Media never waits for topic, visual, search, or answer processing.

## Presenter and attendee flow

1. Open `/presenter`, enter a trimmed session name of 1–100 characters, and create a room. The backend generates an eight-character uppercase hexadecimal code; the initial room has no transcript, topic, or visual content.
2. Copy the invitation, or share the code. A second browser joins at `/` or opens `/rooms/{code}`. Codes are trimmed and normalized to uppercase. `/presenter/{code}` is the separate local demo control screen; it is not protected administrative access.
3. Choose **Choose a recording** and a thread update interval of 1, 3, 5, or 10 minutes (default 5). Upload progress changes to validation, then the native player appears. A failed upload can be retried in the same room. Once speech has been released, the recording cannot be replaced.
4. Use the presenter's player to play, pause, seek, resume, or end. Attendees follow the saved source clock. They may need to click **Enable playback** or **Play sound** to satisfy autoplay rules. Browser loading and unsupported formats have separate recovery messages.
5. The presenter captures audio from the playing file, never a microphone. With the backend provider connected, final speech appears progressively at source positions in both views. Interim recognition is transient and never enters a room snapshot, indexing job, or attendee event.
6. Attendees can scroll through earlier released words without being pulled to the newest line. **Return to newest caption** restores following. Leaving a room releases subscriptions, source audio, pending upload requests, capture work, and room state.

For a fresh room, **Go live with camera** requests camera and microphone permission and starts the existing camera publisher. Attendees receive WebRTC media independently from continuous speech and completed MediaRecorder-window uploads. **End session** flushes speech and queues the final shorter visual window before freezing the source clock. A room that already has an uploaded or ended camera source needs a fresh room for camera intake. Reloading the presenter or losing its signaling connection ends local capture; it does not silently reacquire devices or claim to reconnect. Stopped camera rooms cannot be revived by delayed heartbeats.

Camera signaling uses `/api/live-media/{code}?role=host|attendee`; only allowed browser origins and active camera rooms are accepted. Signals are bounded and room-scoped; media is peer-to-peer. Public camera deployments need authentication and suitable TURN infrastructure, neither supplied by this local demo. Streaming-platform intake remains **Planned**. Actual camera/microphone hardware testing was deliberately omitted at the user's request; deterministic lifecycle and signaling checks are separate evidence.

## Prerequisites and configuration

Use Node 24 and the pinned root, backend, and web lockfiles. Start the local PostgreSQL and Elasticsearch services and apply the schema:

```sh
npm ci
npm run install:all
npm run services:up
npm run db:push
npm run dev
```

The backend's pinned `@ffprobe-installer/ffprobe` dependency supplies a platform-specific validator for macOS, Linux, and Windows; keep npm optional dependencies enabled during installation. No system FFmpeg installation or `PATH` change is required. Validation has a 30-second tool deadline. The backend retains original source bytes rather than transcoding them. An unavailable validator returns HTTP 503 rather than reporting that the recording is invalid.

Configuration names: `DATABASE_URL`, `ELASTICSEARCH_URL`, `API_HOST`, `API_PORT`, `WEB_ORIGINS` (comma-separated exact browser origins), `GEMINI_API_KEY`, and `GEMINI_LIVE_TRANSCRIPTION_MODEL`. The default transcription model is `gemini-3.5-transcribe-live`. Only the backend receives provider credentials. Missing credentials leave room creation, uploads and playback usable; transcription reports a disconnected state and offers pause/resume recovery. Optional operational export uses the existing `DASH0_*` settings.

Presenter capture needs a secure context (HTTPS or localhost), media-element `captureStream`/`mozCaptureStream`, Web Audio, and AudioWorklet support. Use a current desktop Chrome or Firefox browser with a supported codec. Safari and mobile support varies. A format accepted by the backend may still be unplayable in a particular browser. Playback rate should remain at the native 1× setting. No camera or microphone permission is required. Media-element capture and provider setup can miss audio while the provider connects; seek back and resume to retry that passage.

Google's [Live transcription guide](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe) describes interim versus final recognition, 16 kHz PCM input, resumable sessions and provider limits. This implementation rotates provider sessions before their ten-minute limit and bounds reconnection work. Provider availability, quota, language accuracy and model access require real verification in the target account.

## Supported sources and retention

| MIME type                                    | Typical source            |
| -------------------------------------------- | ------------------------- |
| `audio/mpeg`                                 | MP3                       |
| `audio/mp4`                                  | M4A / MP4 audio           |
| `audio/wav`, `audio/x-wav`                   | WAV                       |
| `audio/webm`, `audio/ogg`, `audio/flac`      | WebM, Ogg, FLAC audio     |
| `video/mp4`, `video/webm`, `video/quicktime` | MP4, WebM, MOV with audio |

The maximum is **300 MiB** (314,572,800 bytes), enforced while streaming even without `Content-Length`. Files must be nonempty, decodable by ffprobe, contain audio (plus video for a video source), and have a finite positive duration no greater than 24 hours. Corrupt, oversized, missing-stream and invalid-duration sources fail safely. Interrupted/failed uploads remove partial or rejected bytes; a retry replaces any stale partial file.

Media lives in backend-relative `.data/recordings/{code}/`, ignored by Git, with private directory/file permissions. Original media is retained locally until explicitly removed; there is no automatic expiry or media-delete endpoint. Released records remain in PostgreSQL. Stop the local server before manually removing a room's local media. Missing files result in a safe media failure, not a public filesystem path. Never commit source media, real participant content, provider output, or environment files.

## HTTP contracts

Backend OpenAPI (`backend/openapi.json`) owns these routes; regenerate the web types with `npm run contracts:generate`.

| Method and route                                   | Contract                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/sessions`                               | `{title}` → `201 SessionSnapshot`                                                                                             |
| `GET /api/sessions/{code}`                         | Authoritative persisted snapshot and current revision                                                                         |
| `GET /api/sessions/{code}/events`                  | SSE snapshot followed by revisioned committed updates                                                                         |
| `POST /api/sessions/{code}/recording`              | Raw media body; `Content-Type` and optional `X-Thread-Update-Minutes` → `202 {recording}` after validation                    |
| `POST /api/sessions/{code}/recording/playback`     | `{positionMs,isPlaying}` → persisted recording; rejects positions outside source duration                                     |
| `GET`, `HEAD /api/sessions/{code}/recording/media` | Private no-store source, `Accept-Ranges: bytes`; full `200`, single/open/suffix byte-range `206`, invalid/unsatisfiable `416` |

Validation errors use fixed public messages: `400` invalid input/source, `404` missing room, `409` source not ready/replacement conflict, `413` oversized, `415` unsupported type, and `503` temporary infrastructure failure. Private paths, raw tool/provider errors and credentials are excluded.

Snapshots include room metadata, revision, released count, finalized captions, source state, and reserved released topic/visual fields. This slice returns empty topic/visual collections. A recording includes `playbackPositionMs`, `isPlaying`, `durationMs`, and ISO `playbackUpdatedAt`; attendees project the playing source forward from that timestamp and correct drift against persisted updates. The presenter reports approximately once per second and immediately after discontinuities. Paused/ended clocks do not advance. A disconnected presenter expires after 15 seconds without progress, checked every five seconds, and pauses at the last committed position. A server restart pauses unfinished rooms, marks interrupted uploads failed, and retains released speech, source metadata and release cursors.

SSE uses `id: {revision}`, named event types, and JSON data. Subscribe-before-snapshot ordering buffers concurrent updates and discards revisions already in the snapshot. On reconnect, the server sends a fresh snapshot rather than replaying an unbounded event log. The browser rejects stale revisions, refreshes gaps or stale full snapshots, buffers events during refresh, and replays contiguous newer revisions. Buffers are bounded; overflow falls back to authoritative state. Startup HTTP requests have ten-second deadlines and five automatic retries for temporary failures, followed by a manual retry action. Uploads have a two-minute request deadline.

## Transcription WebSocket and ordering

The presenter opens same-origin `ws(s)://{host}/api/live/{CODE}/transcription`. The backend validates the exact configured `Origin`, normalized route, room existence, ready/playing source, one active connection per room, and a bounded 8 KiB message payload before provider allocation.

- Binary messages contain mono, little-endian signed PCM16 at 16 kHz. AudioWorklet averages source channels, resamples device rates to 16 kHz, and emits 100 ms / 3,200-byte packets. The gateway accepts nonempty even-sized packets up to 6,400 bytes.
- Text control messages are strict JSON: `{type:"position",positionMs:integer}` and `{type:"stop"}`. Extra keys are rejected. Positions must remain inside the source duration, within five seconds of the persisted projected source clock, and move forward after the initial browser clock establishes the capture anchor. Initial setup may put that first clock slightly behind the server projection. Seeks replace the capture.
- Server statuses include `ready`, `connection` (`ready`/`reconnecting`), `interim`, `finalized`, `error`, and `stopped`. A status never substitutes for a caption commit. Interims remain transient and are not rendered in attendee state.
- Provider callbacks belong to one capture generation. Pause, loading, seek, end, room change, and disconnect stop the old capture. Pending setup is cancelled locally; late callbacks cannot attach to a replacement room/capture.
- Finalized text uses the latest validated **source** position rather than elapsed wall time. Timestamps describe a source position at finalization, not exact word timings. A backward seek starts a new source clock; previously released words remain available. Replaying a passage can produce a new legitimate final caption; repeated final messages within one capture are suppressed.
- Final writes serialize per capture. PostgreSQL locks the room, assigns a stable sequence, writes the caption, increments released count/revision and inserts a `SearchIndexJob` in the same transaction. Stable caption IDs make three bounded write attempts repeat-safe. Replayed acknowledgements can republish the existing committed record without another release or indexing job. No Elasticsearch availability is required for caption commitment.
- The browser stops audio processing, sends `stop`, and waits up to four seconds for the backend acknowledgement before persisting pause/seek state. The backend finishes provider recognition, drains finalized writes, and only then invokes the interval/stop refresh hook. This hook is the handoff for later topic processing; it does not run analysis in ST-02.
- Browser reconnects use five bounded delays and at most ten seconds of audio buffering. Backend provider reconnects use bounded setup/retry work and generation checks. A terminal failure reports actual disconnected state; media playback continues. Failed lines are never fabricated. After exhausted persistence attempts, pause/resume reconnects; uncommitted speech may require replay.

## Verification and known limits

```sh
npm run check
```

This runs static feature/import boundaries, generated-contract typechecks, behavior/API/interaction tests, isolated PostgreSQL transaction/restart checks and production builds. Database tests create and remove a private fixture schema; local services and the applied canonical schema must be available. Deterministic fixtures are explicitly synthetic and never exposed by production fixture endpoints.

Verified locally: creation and second-browser empty-room join; real ffprobe validation of a synthetic audio/video source; upload progress/readiness; media ranges; synchronized play/pause/resume/seek in two isolated Chrome contexts; desktop/mobile layouts; empty initial state; finalized/interim separation; idempotent concurrent transactions and rollback; origin/message/source-clock validation; stop/refresh ordering; stale callbacks; startup retries; room changes; reconnect catch-up; and private-error handling.

A user-authorized demo recording was verified on 2026-11-09 in two isolated Chrome contexts against live Gemini transcription. The 204,988,045-byte source passed ffprobe validation; finalized records appeared progressively (two initially, three after pause/seek/resume). The attendee reconnected after a network interruption and reconciled the persisted records with stable IDs, contiguous sequences and valid source timestamps. Playback was paused after verification. Only counts and operational results were recorded; the media and speech stay in ignored local storage/PostgreSQL and are not committed.

This check covers short passages of the 79-minute source, not the full recording or a provider session rotation. Long-session rotation under real network conditions, recognition accuracy across the whole recording, Firefox capture behavior, and mobile autoplay remain environment-dependent. Re-run the consented two-browser check when changing provider or browser settings.

This is a single-process local demo: room codes are not authentication, source heartbeat expiry is local, and SSE fan-out is process-local. Run one backend process. Search-index jobs are a durable handoff for ST-05; the integrated app composes indexing, search, topics, visual analysis and private answers. External-stream intake is not implemented. Keep CI required and leave merges to the team.

## Camera lifecycle contracts

- `POST /api/sessions/{code}/recording/live/start`: `{ analysisWindowMinutes: 1 | 3 | 5 | 10 }`; returns 201 with committed source state
- `POST /api/sessions/{code}/recording/live/stop`: returns the stopped source state
- Existing playback updates persist camera heartbeat/source time; non-monotonic or future clock jumps are rejected
- Completed live windows use the visual-moment route described in the visual guide; provider failure never fabricates a still
