# Topic threads

The backend groups finalized, released speech into stable threads. Each visit to a thread has its own occurrence, source timestamp, note, and caption range. Transcript and topic history remain separate attendee views.

## Cadence and dynamic input

Source audio streams continuously to live transcription. One early topic may be requested after three finalized captions. Subsequent topic requests follow the presenter's selected 1/3/5/10 minute source interval; pause/end requests the finalized remainder.

Each request records the committed released-caption sequence endpoint. The analyzer receives every pending caption through that endpoint, regardless of caption count. There is no eight-caption or twelve-caption input limit. The current attempt endpoint stays fixed across retries; captions arriving later are queued for the next requested range. Only released speech can be supplied to AI.

## Topic boundaries and evidence

An interval result contains ordered contiguous segments. Each segment starts at a supplied caption ID, and its end is derived from the next segment. The first segment starts at the interval's first caption, so every caption is covered exactly once. New landmarks use the actual transition caption's source time.

A segment can start a topic, continue the active topic, or return to another topic. It can also reference a topic created earlier in the same result by that earlier segment's start caption ID. The backend assigns durable IDs and commits the entire plan atomically. Invalid later segments cannot leave earlier segments partially applied.

Prior thread and current-occurrence summaries are supplied alongside their actual released evidence captions. Thread-summary evidence and occurrence-note evidence are separate. Continuations may retain supplied prior evidence; returning visits require fresh occurrence evidence while their thread summary can preserve grounded earlier context. Rewritten notes replace their exact citation sets. Unsupported earlier claims must be removed.

## Scheduling and recovery

Postgres stores requested and active-attempt sequence endpoints, the applied cursor, failure count, and retry time. A due failed request remains eligible while the room is live. New interval requests can queue a later endpoint without expanding the active failed range. A successful request clears the attempt and makes any later requested range eligible immediately.

Provider requests disable SDK retries. The durable worker controls backoff. Quota exhaustion defers requests without skipping captions. Repeated non-quota failures can mark the fixed range skipped; captions remain readable and the snapshot exposes the skipped count. Elasticsearch indexing is queued from committed captions and topic assignments.

## Configuration and contracts

Keep `GEMINI_API_KEY` and `GEMINI_TEXT_MODEL` in `backend/.env`. Topic generation uses the backend's Vercel AI SDK Google provider. Its output budget scales with interval caption count. Internal analyzer contracts live under `backend/src/platform/ai`; public snapshots and SSE remain backend-owned OpenAPI contracts. No provider credentials or raw error bodies are exposed to the web client or telemetry.

## HTTP and event contracts

`GET /api/sessions/{sessionId}` returns the released snapshot: captions, threads with ordered occurrences, the active occurrence, suggestions, and the skipped-caption count. `GET /api/sessions/{sessionId}/events` is an SSE stream. It subscribes before reading the snapshot, sends that snapshot first, then forwards buffered and later events whose revision is newer. `topic_updated` carries a full snapshot so caption-to-topic relationships never arrive piecemeal. Clients refetch the snapshot after a revision gap or a stale topic payload.

## Reading and navigation

Attendees open `/rooms/{roomCode}`. The reader shows shared playback beside separate Topics and Transcript tabs. Topics lists threads by their latest visit, newest first, with the start of the talk at the bottom. Returning topics move to the top while keeping their complete visit history. The current topic is marked “Talking about now” during playback and “Current topic” while paused. A brief “Topic updated” status announces changed topic content, without firing for playback-clock updates; a dialog shows each visit, its note, and its evidence passages without seeking shared media. "View in transcript" selects that exact caption. Inspected topics, selected passages, and scroll position stay put as captions and topic revisions arrive. Return to now clears the inspected moment and follows the newest caption again.

The transcription gateway calls `refreshTopics` after flushing caption writes at each source-interval boundary and when capture stops; the backend turns that into a requested topic range. `getSnapshot` and every topic commit share one transaction reader, and topic writes take the same room row lock as caption release and playback.

While media plays, a countdown estimates the next topic boundary from the shared source clock and keeps ticking between presenter updates. Before the first topic, an animated waiting state appears; skipped analysis is reported as a count while the speech stays readable.

## Accessibility

Tabs follow the ARIA tab pattern with arrow, Home, and End keys. The topic dialog is modal, closes with Escape, and returns focus to the milestone that opened it. Text size controls scale the reading surface; layouts reflow at narrow widths and 200% text. Animation stops under reduced motion. Transcript additions are announced politely; the countdown is not announced.

## Fixture authoring

Keep test transcripts synthetic and visibly labeled, for example `Fixture line:` prefixes and `Fixture keynote` titles. Never copy participant speech into tests. Build interval fixtures from contiguous sequences with increasing timestamps, and include prior evidence captions whenever a test exercises cumulative summaries.

## Verification and limits

Run focused backend tests for `topicAnalysisWorker`, `prismaSession.repository`, `prismaTopicPlan.repository`, and `geminiTopicAnalyzer`, then backend typechecking and import-boundary checks. Synthetic fixtures must remain labeled as test data. A real-provider demo must confirm the topic cursor catches up to the requested endpoint while media continues.

Speech recognition may finalize text after an interval boundary. Waiting for queued caption writes does not force the provider to finalize unfinished recognition; late finalized captions remain eligible for a later request. The app is a local demo with no authentication or production stream-hosting guarantee. Local media, transcripts, captions, and credentials must remain outside source control.
