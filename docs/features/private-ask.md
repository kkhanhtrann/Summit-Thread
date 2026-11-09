# Private Ask

## Purpose and attendee flow

Private Ask answers questions using only committed released speech from the selected room. Elasticsearch retrieves candidates; PostgreSQL supplies the actual evidence text and timestamps. Gemini generates a short answer through the backend Vercel AI SDK Google provider. Empty retrieval returns an explicit abstention. Missing, invented, or partly invalid citation IDs return a safe cited excerpt instead of unverified generated text.

The attendee room includes the private panel, and `/ask?session=ROOMCODE` opens its independent view. Suggested questions fill the composer; only Ask sends them. A failed question stays visible and can be retried without adding a second user turn. Citation buttons open the released passage at its timestamp. View in transcript focuses the matching caption in the room reader without seeking shared playback; the independent view shows its canonical released passage. Room changes clear the conversation, draft, selected evidence, failed requests and pending work. Conversation state lives only in the mounted browser page and disappears on reload; it is never stored server-side or shared with presenters.

## Configuration and startup

Use the README setup commands with Node 24 and dedicated Compose services. PostgreSQL is on 5435, Elasticsearch on 9203, API on 3110 and web on 5185 by default. Set `GEMINI_API_KEY` and, when needed, `GEMINI_TEXT_MODEL` only in ignored backend/.env. No browser AI key is used. Missing provider configuration does not block room playback or reading; Ask reports a recoverable unavailable state when it needs generation.

## HTTP contracts and limits

- `POST /api/sessions/{sessionId}/chat`: accepts a 2–500 character trimmed question, up to 8 history messages, and an optional released caption ID (1–160 characters). Each input history message accepts 1–4000 characters and is normalized to at most 1000; the model sees only the latest six messages.
- At most five evidence passages enter generation, each capped at 4000 characters. Retrieval uses the current question and up to three recent distinct user questions. The versioned index searches caption text plus available topic title/summary.
- `GET /api/sessions/{sessionId}/ask-context`: returns the room title, committed released captions and up to five available suggested questions. The independent view refreshes every five seconds; embedded attendees use their existing room snapshot.
- Private request bodies are limited to 32 KiB by the shared JSON parser. Responses use `Cache-Control: no-store`. Codes are normalized by browser navigation and validated as eight hexadecimal characters by the API.
- Invalid input returns 400; missing rooms return 404; unavailable search/generation returns a safe 503. Provider requests have a 30-second timeout and no automatic provider retry; the attendee chooses retry. No provider exception payload reaches the client or telemetry.

Backend OpenAPI owns the implemented HTTP schemas. Run `npm run contracts:generate` after contract changes; do not edit generated browser types.

## Ownership and integration

`private-chat` owns answer application/HTTP/contracts and the web conversation. `search` owns the Elasticsearch adapter and its public port. `sessions` owns released-content access, the durable indexing worker and its queue. Composition stays in app.ts/server.ts. The existing finalized-caption transaction writes the caption, release cursor/revision and SearchIndexJob together; search availability cannot roll that transaction back.

Indexing uses stable caption document IDs and only reads captions below their room's releasedCount cursor. The worker serializes drains, acknowledges only after a successful write (or safely skipping invalid/unreleased work), retains failed jobs, retries every 1.5 seconds, and awaits in-flight writes on shutdown. Restarting resumes durable jobs. Topic updates can enqueue separate uniquely identified index_caption jobs in the same topic transaction; the worker reloads the caption's current committed topic relation when processing them. The topic feature remains responsible for that transaction and for publishing available suggestions.

Every retrieval is filtered by room ID and the current PostgreSQL released-ID allowlist. The answer service intersects candidate IDs with its canonical PostgreSQL records and discards the index's passage text/timestamps. Stale-only, foreign-room and future-caption documents cannot become evidence. PostgreSQL remains authoritative; Elasticsearch can always be regenerated.

`PrivateChatPanel` is available through the web feature's public.ts. Its snapshot input needs only session metadata, released captions and suggestions; an optional onOpenCitation callback integrates with the owner's reader navigation without touching playback state. Product workflows outside private Ask remain owned by their feature issues.

## Search rebuild and recovery

```sh
npm --prefix backend run search:rebuild
```

This command requeues committed released captions in batches of 200, drains indexing and prints only enqueued/pending counts. It does not read recordings or call an AI provider. Existing caption IDs replace the intended documents, so reruns are safe. If Elasticsearch is unavailable, it exits nonzero and leaves durable jobs pending; restore the dedicated search service and rerun, or let the running worker retry. Rebuild does not delete an index or touch unrelated services. Orphan/stale documents remain excluded by the PostgreSQL allowlist.

## Verification

```sh
npm run check
npm --prefix backend run test:search:integration
```

CI starts dedicated services, applies the schema, runs the normal check plus real PostgreSQL/Elasticsearch integration tests, and cleans up its services. Fixtures use explicitly synthetic room titles/content and clean up only their own IDs. Integration checks cover release/outbox atomicity, released-cursor filtering, foreign/future/orphan exclusion, durable jobs after a real refused connection, a new worker draining after recovery, and rebuild from committed records. Unit/interaction checks cover canonical evidence, invalid citation fallback, history bounds, context/suggestion separation, duplicate-free retry, cancellation and room changes. Privacy regression checks remain in place.

A synthetic fixture is test evidence and must not be described as a real-recording run. Verification against a consented recording and actual provider responses is recorded separately from deterministic tests.

## Telemetry and observed evidence

Safe instrumentation records search/index spans, candidate/evidence counts, answer duration/outcome, citation counts and fixed failure categories. Never attach query text, indexed document bodies, questions, answers, conversation history or raw provider errors. Existing backend allowlists and browser URL filters remain active; browser session recording is disabled.

Runtime/provider and Gitar verification results will be recorded after checks finish. Append actual Dash0 diagnosis/fix/recovery observations as the feature is exercised; never invent sponsor activity or success claims.
