# Private Ask

## Purpose and attendee flow

Private Ask answers questions using only committed released speech from the selected room, plus any ready presenter materials (notes or PDFs). Citations are typed: `{ kind: 'caption' }` for spoken evidence and `{ kind: 'material' }` for presenter material, and answers never attribute material-only claims to the speaker; see the [talk materials guide](talk-materials.md). Elasticsearch retrieves candidates; PostgreSQL supplies the actual evidence text and timestamps. Gemini generates a short answer through the backend Vercel AI SDK Google provider. Empty retrieval returns an explicit abstention. Missing, invented, or partly invalid citation IDs return a safe cited excerpt instead of unverified generated text.

The attendee room includes a private Ask tab alongside Topics and Transcript, and `/ask?session=ROOMCODE` opens its independent view. Suggested questions fill the composer; only Ask sends them. A failed question stays visible and can be retried without adding a second user turn. Citation buttons open the released passage at its timestamp. View in transcript focuses the matching caption in the room reader without seeking shared playback; the independent view shows its canonical released passage. Room changes clear the conversation, draft, selected evidence, failed requests and pending work. Conversation state lives only in the mounted browser page and disappears on reload; it is never stored server-side or shared with presenters.

## Configuration and startup

Use the README setup commands with Node 24 and dedicated Compose services. PostgreSQL is on 5435, Elasticsearch on 9203, API on 3110 and web on 5185 by default. Set `GEMINI_API_KEY` and, when needed, `GEMINI_TEXT_MODEL` only in ignored backend/.env. No browser AI key is used. Missing provider configuration does not block room playback or reading; Ask reports a recoverable unavailable state when it needs generation.

## HTTP contracts and limits

- `POST /api/sessions/{sessionId}/chat`: accepts a 2–500 character trimmed question, up to 8 history messages, and an optional released caption ID (1–160 characters). Each input history message accepts 1–4000 characters and is normalized to at most 1000; the model sees only the latest six messages.
- At most five spoken passages and three presenter material passages enter generation, each capped at 4000 characters. If material search fails, Ask answers from speech alone. Retrieval uses the current question and up to three recent distinct user questions. The versioned index searches caption text plus available topic title/summary.
- `GET /api/sessions/{sessionId}/ask-context`: returns the room title, committed released captions and up to five available suggested questions. The independent view refreshes every five seconds; embedded attendees use their existing room snapshot.
- Private request bodies are limited to 32 KiB by the shared JSON parser. Responses use `Cache-Control: no-store`. Codes are normalized by browser navigation and validated as eight hexadecimal characters by the API.
- Invalid input returns 400; missing rooms return 404; unavailable search/generation returns a safe 503. Provider requests have a 30-second timeout and no automatic provider retry; the attendee chooses retry. No provider exception payload reaches the client or telemetry.

Backend OpenAPI owns the implemented HTTP schemas. Run `npm run contracts:generate` after contract changes; do not edit generated browser types.

## Ownership and integration

`private-chat` owns answer application/HTTP/contracts and the web conversation. `search` owns the Elasticsearch adapter and its public port. `sessions` owns released-content access, the durable indexing worker and its queue. Composition stays in app.ts/server.ts. The existing finalized-caption transaction writes the caption, release cursor/revision and SearchIndexJob together; search availability cannot roll that transaction back.

Indexing uses stable caption document IDs and only reads captions below their room's releasedCount cursor. The worker serializes drains, acknowledges only after a successful write (or safely skipping invalid/unreleased work), retains failed jobs, retries every 1.5 seconds, and awaits in-flight writes on shutdown. Restarting resumes durable jobs. Topic updates can enqueue separate uniquely identified index_caption jobs in the same topic transaction; the worker reloads the caption's current committed topic relation when processing them. The topic feature remains responsible for that transaction and for publishing available suggestions.

Every Ask loads canonical released captions once; all retrieval queries share that PostgreSQL snapshot and its released-ID allowlist. Every retrieval is filtered by room ID and that allowlist. The answer service intersects candidate IDs with its canonical PostgreSQL records and discards the index's passage text/timestamps. Stale-only, foreign-room and future-caption documents cannot become evidence. PostgreSQL remains authoritative; Elasticsearch can always be regenerated.

`PrivateChatPanel` is available through the web feature's public.ts. Its snapshot input needs only session metadata, released captions and suggestions; an optional onOpenCitation callback integrates with the owner's reader navigation without touching playback state. Product workflows outside private Ask remain owned by their feature issues.

## Search rebuild and recovery

```sh
npm --prefix backend run search:rebuild
```

This command requeues committed released captions, then ready presenter material passages, in batches of 200, drains indexing and prints only enqueued/pending counts. It does not read recordings or call an AI provider. Existing caption IDs replace the intended documents, so reruns are safe. If Elasticsearch is unavailable, it exits nonzero and leaves durable jobs pending; restore the dedicated search service and rerun, or let the running worker retry. Rebuild does not delete an index or touch unrelated services. Orphan/stale documents remain excluded by the PostgreSQL allowlist.

## Verification

```sh
npm run check
npm --prefix backend run test:search:integration
```

Run integration checks against an isolated empty PostgreSQL database with the schema applied, without a competing development index worker on that database. Set DATABASE_URL to that dedicated test database before running the integration command. CI starts dedicated services, applies the schema, runs the normal check plus real PostgreSQL/Elasticsearch integration tests, and cleans up its services. Fixtures use explicitly synthetic room titles/content and clean up only their own IDs. Integration checks cover release/outbox atomicity, released-cursor filtering, foreign/future/orphan exclusion, durable jobs after a real refused connection, a new worker draining after recovery, and rebuild from committed records. Unit/interaction checks cover canonical evidence, invalid citation fallback, history bounds, context/suggestion separation, duplicate-free retry, cancellation and room changes. Privacy regression checks remain in place.

On November 9, 2026, Brave verification used the team's selected public conference walkthrough recording uploaded through the presenter flow. Continuous transcription produced committed passages, and a real Gemini answer returned a working 01:28 citation. After rebasing onto the room/topic work, a released topic suggestion filled the composer without sending it; a separate Ask returned a real answer with 02:11 and 02:24 citations. Citation details displayed canonical released text. The reader's local citation navigation selects Transcript and leaves shared playback untouched; an integration test checks focus and the unchanged media position. The recording was paused after the check. Media, passage text, private questions and answers remain in ignored local storage/page state and are excluded from this guide.

Gitar identified refresh-driven focus theft and repeated transcript reads per question. Regression tests first reproduced both findings; the fixes focus only on a selected caption ID transition and share one canonical allowlist across retrieval queries. Unit checks also cover the restored Ask tab boundary and citation navigation. A competing development index worker caused timeout failures when integration tests used its database; rerunning the real PostgreSQL/Elasticsearch checks in an isolated temporary database passed. A sixth check also verifies topic-context retrieval and replacement of stale indexed topic text.

## Telemetry and observed evidence

Safe instrumentation records search/index spans, candidate/evidence counts, answer duration/outcome, citation counts and fixed failure categories. Never attach query text, indexed document bodies, questions, answers, conversation history or raw provider errors. Existing backend allowlists and browser URL filters remain active; browser session recording is disabled.

Dash0 Agent0 was inspected read-only through Brave on November 9, 2026. The 20:00–20:04:15 UTC window showed three successful caption-index jobs/writes. The follow-up window through 20:13:16 UTC showed three recording-backed chat POSTs, three caption-search spans and three successful Gemini HTTP calls, with zero error spans in those Ask traces. Each Ask reported five evidence sources; citation counts were 1, 2 and 2; answer durations were 2674, 2593 and 3365 ms, all with the fixed result answered. Metric-to-request matching is inferred from timing and process instances because the development backend restarted between requests.

Count-only inspection found no body/question/answer/transcript/speech attribute keys in the three Ask traces, no content keys in linked logs or browser events, and no unredacted HTTP query/fragment fields in the inspected calls. Search recorded query length only; SQL used placeholders/transaction commands and Elasticsearch parameters carried index names. These bounded observations are evidence for the inspected requests, not an exhaustive guarantee for every possible payload.

The development window also contained 38 browser 502s and three browser error events during eight backend restarts while dependencies, rebasing and checks were changing the running development process. None linked to the three successful Ask traces. Recovery was observed through a successful attendee retry without duplicate question entries and later HTTP 200 answers. The timing supports development-proxy downtime as the cause; it is an inference. No service failure category was emitted by these successful Asks, so live failure-category export remains unverified; deterministic service/recovery tests cover those branches.

Gitar reviewed the PR, identified the refresh focus and repeated-read findings above, and confirmed both fixes as resolved. Its private-content telemetry rule passed. The feature remains behind the required CI check and team-controlled merge.
