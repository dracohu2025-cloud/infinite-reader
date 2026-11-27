# Backend contract used by the web client

**Source of truth: [`worker/API.md`](../worker/API.md)** (Cloudflare Worker, deployed at
`https://reader.example.workers.dev`). This file only records how the client uses it and the choices it makes where the
API leaves room. If the two ever disagree, the Worker wins and this file is stale.

## Transport

* Same-origin, **cookie session** (`__Host-ir_session` / `ir_session`), `credentials: 'include'`, no tokens.
* In `vite dev`, `/api/*` is proxied to the Worker (`API_PROXY`, default the deployed URL) and the `Origin` header is rewritten to the
  target's, because the Worker rejects cross-origin writes with `403 bad_origin`. In production the Worker serves `web/dist` itself.
* Errors use `{ error: { code, message, retryAfter? } }` (`src/api/http.ts` -> `ApiError`).

## Two interchangeable backends behind the adapter

`src/storage/index.ts` exports one `storage: StorageAdapter` that forwards to either implementation, switched at runtime:

| Mode | When | Persistence | Ask AI |
| --- | --- | --- | --- |
| `api` | `GET /api/auth/me` is 200 (or after login) | `ApiAdapter` -> Worker | `POST /api/ask` (real RAG answers) |
| `local` | signed out + "Continue offline", `VITE_BACKEND=local`, or no backend reachable (dev server without proxy, network down, non-JSON from `/api`) | `IndexedDbAdapter` | `MockAskClient` |

Boot sequence (`useReader.initSession`): `local` if forced -> `GET /api/auth/me` -> `200` api mode / `401` show sign-in (with
"Continue offline") / anything else local mode. Local books and notes are not migrated into an account; they stay in the browser.

## Auth (`src/api/auth.ts`, `src/ui/Login.tsx`)

`GET /auth/providers` decides which buttons show; email = `POST /auth/email/request` then `POST /auth/email/verify` (6-digit code, 30 s
resend cooldown honoured from `429 cooldown`/`retryAfter`); both login methods require an unchecked-by-default agreement to `/terms`. Email verification sends `terms: { accepted: true, version: TERMS_VERSION }`; Google starts with `POST /api/auth/google/start` and JSON `{ next, terms }`, then navigates to its returned `{ url }`. Failures come
back as `/?auth_error=<code>` and are shown on the sign-in card; `POST /auth/logout` on sign out.

## Books

| Client call   | Request                                                                                                                                                                                      |
|---------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `listBooks`   | `GET /books` -> `BookSummary[]` mapped to `BookMeta` (`hasCover` -> `/api/books/:id/cover`, `status`, indexing %, `progress.percent` -> `lastPercent`, `progress.updatedAt` -> `lastReadAt`) |
| `saveBook`    | `POST /books` multipart: `file` (original filename kept) + `title`. Returns `202` summary; **the server id replaces the client's**                                                           |
| `getBookFile` | `GET /books/:id/file` - the EPUB is still parsed and paginated in the browser                                                                                                                |
| `updateBook`  | `PATCH /books/:id` for title/author; reading position -> `PUT /books/:id/progress` `{ percent, location: { leaf } }` (debounced 700 ms)                                                      |
| `deleteBook`  | `DELETE /books/:id`                                                                                                                                                                          |

Library polls `GET /books` every 4 s while any book is not `ready`/`failed` and shows "Indexing for AI n%". A book can be read
immediately after upload; only Ask AI retrieval depends on indexing (the Worker falls back to selection + context).
Re-dropping a file already in the library is matched by `size + filename` so annotations are reused instead of uploading twice.

Shelf order is decided in the client (`src/book/libraryOrder.ts`): books with `lastReadAt` lead, most recently read
first,
followed by never-opened books newest addition first. Opening a book records the read time before the first page turn
(`saveReadingProgress`), so a book that is opened and left still moves to the front. The cloud read time is
`progress.updatedAt`, which every `PUT .../progress` refreshes; the local adapter stores `lastReadAt` on the book
record.
The spacious shelf layout shows a started book's `lastPercent` as a ring with its percentage; compact rows omit it.

## Highlights and inline notes

The reader models an inline note as part of its annotation (legacy position fields are retained but no longer rendered); the Worker has two collections. `ApiAdapter` splits and re-joins them:

* `Annotation` -> `POST/PATCH/DELETE /books/:id/annotations`: `{ id, kind, color, anchor, text }` where `color` is one of the named colours
  (`yellow|pink|green|blue|orange|violet`; foreign `#hex` colours are mapped to the nearest named one) and
  `anchor = { chapter, start, end, quote }` (chapter index in the client's parse + character offsets in the chapter plain text).
  The client's ids (12 chars) satisfy the 8-64 id rule, so creation is optimistic.
* `note` -> `/books/:id/notes`: id `n_<annotationId>`, `{ text, color, x, y, anchor: { chapter, start, end, rot, tags?, textColor? }, annotationId }`
  (`x`/`y` are desk coordinates relative to the book; `rot` radians and up to five `tags` live in the note anchor, and `tags` is omitted when empty). `annotation.noteId` is set after the note exists.
  `anchor.textColor` stores the independent note ink palette ID; it is omitted for the default ink. Note `color` carries its hex ink, while annotation `color` remains the source highlight/underline colour. Legacy notes without `anchor.textColor` retain default text ink, regardless of their old note `color` value. No database migration is needed.
* Reads: `GET .../annotations` + `GET .../notes`, joined by `annotationId`. Rows whose anchor lacks numeric `chapter/start/end`
  (made by another client) are ignored.
* Writes are coalesced per annotation and serialized (350 ms for edits, so typing in a note produces one `PATCH`; 40 ms for the
  first write of an annotation / note so a creation is sent almost at once). Failures raise a toast ("Could not sync a change").
* Durability: every write is first recorded in a write-ahead outbox (IndexedDB `infinite-reader-outbox`, mirrored synchronously to
  localStorage) and removed once the Worker accepted it. On `pagehide`, `beforeunload` and `visibilitychange` (hidden) all
  unconfirmed writes are sent synchronously as `fetch(..., { keepalive: true })` (same-origin, session cookie, same-origin `Origin`
  header as the Worker's CSRF check requires; total body budget 56 KB of the 64 KB keepalive limit; `sendBeacon` is POST-only so it
  is only the fallback for creates). Annotation and note creates are independent requests (no foreign keys), so they go out in
  parallel. On the next load (`listBooks` / `listAnnotations`) anything still in the outbox is replayed idempotently (`409` on a
  create is followed by a `PATCH`; `404/403` drops the entry) and overlaid on the server list if the replay cannot reach the
  Worker. Reading progress is flushed the same way (`PUT .../progress`).
  Regression: `web/scripts/check-note-reload.mjs`.

## Ask AI (`src/api/ask.ts`)

`POST /api/ask` with:

```json
{
  "bookId": "<server book id>",
  "question": "Explain this passage",
  "threadId": "default",
  "selection": { "text": "...", "chapterTitle": "CHAPTER I.", "anchor": { "chapter": 1, "start": 843, "end": 862 } },
  "context": { "before": "<=700 chars", "after": "<=700 chars", "chapterTitle": "CHAPTER I." }
}
```

The `text/event-stream` response is parsed by `event:` name: `meta` (citations), `delta` (appended to the answer, `**bold**`/`_italic_`
rendered), `done`, `error`; `reasoning` is ignored. Citation chips under the answer jump to `chapterIndex` + `charStart..charEnd`
in the page (best effort: the Worker's chapter indexing is its own parse of the EPUB, so offsets can differ from the client's;
out-of-range chapters are ignored). Pre-stream errors (`429`, `502 llm_error`, `503 llm_not_configured`) are shown in the panel.

## Not used yet

`PUT /books/:id/state` (viewport), `GET/DELETE /books/:id/chat` (history is only kept server-side as model context), `reindex`, `logout-all`,
`annotations?since=` incremental sync.

Terms are versioned in `shared/terms.ts`. Missing consent yields `403 terms_required`; stale versions yield `403 terms_updated`. Google stores the accepted version in its signed OAuth cookie and checks it at callback. `/auth/me` and authenticated account APIs reject sessions whose user has not accepted the current terms; the UI requests a fresh login with explicit consent. Logout remains available. No consent is inferred from existing sessions or migration.
