# Visual moments

Attendees receive a small number of original stills from the room's video, each with its source timestamp, an alternative description, and links to the related released speech and topic. Review runs beside playback and speech: it never holds attendee media, never sees footage the audience has not reached, and never creates captions.

## User flow

1. The presenter plays an uploaded video or explicitly starts camera capture. Uploaded video uses elapsed source windows; camera capture submits completed isolated MediaRecorder clips.
2. When the shared playback clock passes the end of an interval, the backend reviews that interval alone and may pick one useful frame.
3. The still is released when playback reaches its source timestamp. It then appears in the reader's "On screen" list with its time, title and description.
4. An attendee can open the still in a dialog, then jump to "Read what was said" or "Open related topic". Neither action seeks the shared media or moves the attendee's reading position. The host reader handles both through callbacks.

## Prerequisites and configuration

- FFmpeg and FFprobe on the backend `PATH`. They extract clips and frames and read live-clip durations.
- `GEMINI_API_KEY` in `backend/.env` (backend only). Without it, every window fails with `not_configured` and, after bounded attempts, is recorded as skipped. Media, captions and topics keep working.
- `GEMINI_VISUAL_MODEL` selects the multimodal model (default `gemini-3.8-flash`). The provider is called through Google's GenAI SDK (`@google/genai`).
- Storage is `backend/.data/recordings/<ROOM>/`, the same root the upload store uses. It is ignored by git.

## Window cadence and cost

The cadence is the recording's `analysisWindowMinutes`. Window *n* covers `[analysisThroughMs, min(duration, analysisThroughMs + cadence))`. With a five-minute cadence, 0:00–5:00 is eligible at or after 5:00 and 5:00–10:00 at or after 10:00. The final, shorter window is eligible only once playback reaches the source end, including on the final paused or ended update.

Eligibility is checked against the latest committed playback position:

- before a run starts;
- before each clip is extracted;
- before the run moves on to the next window.

Catch-up after a jump processes every elapsed window in order, and never the unfinished one. Each room has at most one active uploaded-source review. Ticks that arrive during a review only schedule a re-check.

Cost grows with the number of windows: one clip upload and one model call per window, plus at most two retries. A shorter cadence gives earlier stills but more provider calls.

Audio-only uploads are never clipped or sent for visual review. Transcription, topics and private Ask are unaffected.

## Validation and source offsets

The provider receives only the extracted elapsed clip, never the full source file. It returns zero or one suggestion: `{ offsetMs, title, description }`.

- The adapter checks the structured output: at most one item, title ≤ 120 characters, description ≤ 280 characters.
- The application then checks that `0 ≤ offsetMs < window duration` (half-open, so a boundary frame belongs to the later window).
- It converts the offset to source time exactly once: `timestampMs = window.startMs + offsetMs`.

Out-of-range or malformed output counts as an `invalid_output` attempt. Moment IDs are `moment-NNNN`, taken from the window index, so retries can never mint a second ID for the same window.

## Extraction

For uploads, the still is decoded from the original source at the source timestamp. For live rooms, it is decoded from the completed captured clip at the clip offset.

- Frames are written as JPEG at the original resolution, with no scaling and no generated imagery.
- Output is written to a temporary file and renamed only once it is non-empty. Partial files are removed on failure.

## Local storage, retention and cleanup

| Path under `.data/recordings/<ROOM>/` | Contents | Lifetime |
| --- | --- | --- |
| `source` | Full uploaded source, written by the upload store | Room lifetime |
| `visual/clips/` | Temporary provider input clips | Removed after each attempt (uploads) or each submission (live) |
| `visual/windows/window-NNNN.json` | Pending candidate, attempt count, last failure category, source fingerprint | Room lifetime; the retry and skip cache |
| `visual/stills/moment-NNNN.jpg` | Original stills | Room lifetime |

Other cleanup and caching rules:

- Provider-side uploads are deleted after every attempt, whether it succeeds or fails.
- Cached windows record a source fingerprint (size and modification time). A replaced upload therefore never reuses stale results.
- Room deletion and source replacement belong to the media workflow, which should remove the room's `visual/` folder.

## Release rules

Pending candidates live only in local storage. They are never in attendee snapshots, search or answers. `PreparedRecording.visualMoments` in PostgreSQL holds released moments only, appended at the release boundary.

- A candidate is released when its window is committed and the shared playback position is at or past its timestamp. Completed live clips release right away, because the audience has already seen them live.
- Each release does a compare-and-set on `releasedVisualMomentCount`, rejects already-released IDs, and advances the room revision. Only then is `visual_moment_released` published.
- A backward seek releases nothing and never removes released history.
- Spoken context is the latest released caption at or up to 60 seconds before the still. Topic context comes from that caption's occurrence. When no caption or occurrence exists, the link is `null`; it is never inferred from the provider's label.

## Retry, skip and recovery

Each window gets up to three attempts, with growing delays. The attempt count is stored before each retry, so restarts cannot reset the bound.

When attempts run out, the window is committed as skipped: `visualReviewSkippedWindowCount` increments and review moves on. A window with no useful frame counts as reviewed, not skipped.

An unexpected storage or database failure leaves the cursor in place and sets `analysisState: failed`. The next playback update retries from the cached result, without another provider call and without a duplicate still.

Failure categories (fixed): `not_configured`, `provider_rejected`, `provider_timeout`, `provider_unavailable`, `rate_limited`, `invalid_output`, `clip_extraction_failed`, `frame_extraction_failed`, `storage_failed`.

## Contracts

HTTP (see `backend/openapi.json`):

- `GET /api/sessions/{sessionId}/visual-moments/{momentId}/image` returns JPEG bytes for a released moment in that room. Unknown, unreleased, wrong-room and malformed IDs share one 404 response, and the response never includes storage paths.
- `POST /api/sessions/{sessionId}/recording/live/windows/{index}` takes one completed live clip (`video/webm`, `video/mp4`, `video/quicktime`, at most 200 MB). It returns `202 { recording }`. Repeating a committed index is a no-op; a later index returns 409.

Event stream messages, published through the room event hub:

- `recording_updated { revision, recording }` is sent on every review-state or cursor change. `recording.analysisState`, `analysisThroughMs` and `visualReviewSkippedWindowCount` carry the partial-review diagnostics.
- `visual_moment_released { revision, moment }` is sent once per moment, after its release commits.

Clients merge moments by `id` (`mergeReleasedMoment`) and refresh from the snapshot after a revision gap. Snapshots carry the same released `visualMoments` via `VisualMomentService.listReleasedMoments`.

Integration points for the media workflow:

- call `VisualMomentService.handlePlaybackProgress(sessionId)` after each committed playback update;
- add `listReleasedMoments` to room snapshots;
- pass `createApp(..., { visualMoments })` when composing the app;
- call `waitForIdle()` on shutdown.

## Accessibility

- Each still uses its description as `alt` text and shows its time in a `<time>` element.
- The dialog is modal, keeps focus inside, closes on Escape, and returns focus to the control that opened it.
- When an image cannot load, the description is shown in its place.
- Review status uses `role="status"`.
- Layout uses relative units and wrapping grids for narrow screens and enlarged text. Nothing animates.

## Telemetry

The telemetry records carry only these fields:

- counts: windows reviewed/skipped, failed attempts, stills released, image requests by state;
- window durations;
- attempt numbers and source type;
- the fixed failure categories.

No pixels, descriptions, prompts, provider payloads, raw errors or storage paths are recorded.

## Verification

```sh
npm --prefix backend test
npm --prefix web test
npm run test:boundaries
npm run check
```

Behavior tests run on deterministic, clearly labeled fixtures. They cover:

- gating: no clip or provider call before an interval ends, exact boundaries, repeated ticks without look-ahead, elapsed-only catch-up, and the final short window on the ended update;
- validation and alignment: window offsets, out-of-range provider timestamps, zero-moment windows;
- execution: audio-only skip, ordered single-run execution, retry/skip bounds, extraction failures, cache reuse, source replacement, clock changes before extraction;
- release and access: release gating across seeks, image authorization and room isolation, live-clip ordering;
- the provider adapter's validation and cleanup;
- the web gallery's states, dialog focus and context links.

An FFmpeg frame-provenance test decodes a synthetic two-color video. It runs only when FFmpeg is installed.

## Known limits and verification status

- The November 9 real-recording run exposed truncated structured output: the 400-token generation ceiling was consumed by model reasoning (380 reasoning tokens, 6 answer tokens, MAX_TOKENS). A diagnostic rerun with an 8192-token ceiling returned STOP and one validated suggestion (712 reasoning tokens, 70 answer tokens). The subsequent integrated final window completed on its first attempt in 33680 ms, released one original still at source 11:02, and rendered that image and its description inside the topic dialog in Brave. Earlier windows remain accurately marked skipped. FFmpeg/FFprobe are installed.
- Issue #6 composes the visual service in server.ts, signals it after committed playback updates, restores released metadata in transactional room snapshots, and mounts the gallery in the attendee reader. Topic threads and private Ask are integrated.
- The Prisma repository has no database-backed test yet.
- Spoken context uses a fixed 60-second lookback. Late-finalized speech may attach on a later snapshot rather than in the release event.
- Retries within a window happen in-process. A restart mid-window resumes on the next playback update.
