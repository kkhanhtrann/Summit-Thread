# Talk materials

## Purpose and presenter flow

Presenters add context alongside their talk: pasted notes (an outline, abstract or script) or a PDF such as slides or a handout. Private Ask can then draw on that material alongside released speech, with citations that clearly separate the two. Topic generation uses relevant material as background vocabulary only. It never treats material as evidence of what was said.

On the presenter page, the **Talk materials** panel beside the invitation:

1. Pastes notes with a title, or uploads a PDF whose title comes from the file name. PDF uploads show byte progress.
2. Lists every material with its status:
   - **Ready:** with passage and page counts.
   - **No extractable text:** for example, a scanned PDF.
   - **Couldn't process:** the upload failed or was interrupted.
   - **Processing…**
3. Removes a material, which deletes its passages and their search documents.

Attendees don't browse materials directly. They see them only as labeled citations in Ask.

## Formats and limits

| Kind | Limits |
| --- | --- |
| Pasted notes | Title of 1–100 characters; text of 1–50,000 characters |
| PDF | Up to 25 MiB and 300 pages; must be a readable, text-based PDF |

- **Text extraction:** the backend reads each PDF page by page with `pdfjs-dist` (pinned, backend-only, never imported into the browser).
- **No OCR:** image-only pages produce no text. A PDF with no extractable text is stored as **empty**.
- **Text only:** extracted text is stored. PDF bytes are discarded after extraction.
- **Size checks:** oversized uploads are rejected from `Content-Length` before the body is read, and again while it streams. Page count is checked before any text is read.

## Persistence and indexing

PostgreSQL owns materials; Elasticsearch is a rebuildable copy.

- **Tables:** `TalkMaterial` holds the room, kind, title, status, page count and passage count. `MaterialPassage` holds the material, ordinal, page number and text.
- **Passages:** text is split into passages of up to 1,200 characters. Splits prefer paragraph boundaries, then sentence boundaries, then hard breaks. A passage never spans two pages, and every word is kept once, in order. Passage IDs are stable: `{materialId}:{ordinal}`.
- **Intake order:**
  1. Intake creates a `processing` row first.
  2. One transaction, under the room row lock, then commits every passage, one `index_material_passage` job per passage, and the final status (`ready`, or `empty` when there are no passages).
  3. A failure part way leaves no passages or jobs, and marks the material `failed`.
  4. Materials left `processing` by a restart are marked `failed` at startup.
- **Removal:** deleting a material cascades its passages and their pending index jobs. It also queues one `delete_material` job that keeps the material ID, so the search documents can still be removed.
- **Search index:** passages go into their own index, `summit-thread-materials-v1`, separate from caption documents, filtered by room.
- **Indexing worker:** the existing worker handles material jobs. It skips passages whose material is no longer ready, and room deletion clears both indexes. If Elasticsearch is down, materials still save and indexing retries.
- **Rebuild:** `npm --prefix backend run search:rebuild` requeues ready passages along with released captions.

## Private Ask

- **Retrieval:** Ask retrieves spoken captions exactly as before (up to five). It then adds up to three ready material passages for the same room. Material search results are intersected with passage IDs reloaded from PostgreSQL, and other rooms' passages are discarded.
- **Fallback:** if material search fails, Ask still answers from speech.
- **Prompt:** the answer model sees each source's kind (`spoken` or `material`) and a label such as "Fixture slides, page 4". It is told:
  - never to attribute material-only claims to the speaker
  - to say so when spoken and material passages disagree
- **Citations:** these are typed.

```ts
{ kind: 'caption', captionId, timestampMs, text }          // spoken evidence
{ kind: 'material', passageId, materialTitle, page, text } // presenter material
```

Every returned citation must match a retrieved source, or the response falls back to a quoted excerpt. A material fallback is labeled "from the presenter's materials". In the attendee UI, material citations read "From slides · Title, page N". Their details say "From the presenter's materials, not spoken in the talk" and offer no transcript link.

## Topic generation

- **What the analyzer gets:** for each interval, the worker searches ready passages using the interval's caption text. It supplies up to five passages, at most 4,000 characters in total, as `backgroundPassages`.
- **What the prompt allows:** they are for accurate terms and spellings only. The model must never cite them, never create or continue a topic from them, and never state what they say unless the captions do.
- **What validation enforces:** the existing validation accepts evidence and segment boundaries only from released caption IDs. A material ID used as evidence or as a segment start is rejected, and the batch retries or skips as before.
- **When background is unavailable:** analysis continues on speech alone.

## HTTP contracts

| Route | Purpose |
| --- | --- |
| `GET /api/sessions/{code}/materials` | List materials (without text) |
| `POST /api/sessions/{code}/materials` | Add notes; JSON `{ title, text }`, with a 256 KB body limit on this route only |
| `POST /api/sessions/{code}/materials/pdf` | Upload `application/pdf`; title in percent-encoded `X-Material-Title` |
| `DELETE /api/sessions/{code}/materials/{materialId}` | Remove a material |

Errors:

| Status | Meaning |
| --- | --- |
| 400 | Invalid title or text |
| 404 | Unknown room or material |
| 413 | PDF over 25 MiB or 300 pages |
| 415 | Not a PDF |
| 422 | Unreadable PDF |

The OpenAPI document defines these routes and the typed Ask citations; web types are generated from it.

## Privacy and telemetry

Materials are participant content. Logs, traces and metrics record only:

- material kind and outcome (`ready`, `empty`, `too_large`, `unreadable`, `failed`)
- passage counts
- search query length and allowed-ID counts
- background passage counts
- fixed error labels

Material text, titles, file names and PDF bytes are never recorded. Parser and search errors are replaced with fixed messages because they can echo content. Real materials are never committed; tests use synthetic, labeled fixtures. That includes a hand-built PDF from `platform/media/syntheticPdf.fixture.ts`.

## Verification

```sh
npm run typecheck
npm --prefix backend test   # includes PostgreSQL integration tests in an isolated schema
npm --prefix web test
SHADOW_DATABASE_URL=... npm run db:check
```

Behavior checks cover:

- **Intake:** passage splitting and page mapping; PDF extraction, the page limit and unreadable files; size, format and limit handling in routes.
- **Persistence:** the atomic commit with a forced rollback, empty and failed materials, deletion and job cleanup, room isolation, and restart recovery.
- **Indexing:** worker handling of material jobs.
- **Ask:** typed citations, material-only and mixed answers, fallback labels, and graceful search failure.
- **Topics:** rejection of material IDs as topic evidence, plus background bounds and failure tolerance.
- **Presenter panel:** status, upload, notes, removal and accessible names.

## Known limits

- No OCR, so scanned slides are reported as having no extractable text.
- Text extraction follows PDF content order, which may differ from visual reading order in complex layouts.
- No editing after upload; remove and re-add instead. No URL fetching and no attendee-facing material browsing.
- Material search uses keyword relevance, like caption search, not semantic embeddings.
