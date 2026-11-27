import { getStorageMode } from './mode'
import { AnnotationSaveStateStore } from './annotationSaveState'
import { noteFontIdOf } from '../book/noteFontCatalog'
import { api, ApiError, bodyBytes, jsonBody, KEEPALIVE_BUDGET, sendKeepalive, toApiError } from '../api/http'
import {
    MARK_COLORS,
    NOTE_TEXT_COLORS,
    noteTextColorOf,
    annotationSignature,
    type Annotation,
    type MarkColor,
    type MarkKind
} from '../book/annotations'
import { noteTagsFromAnchor, noteWireAnchor } from '../book/noteTags'
import type { BookMeta } from '../book/types'
import type { StorageAdapter } from './adapter'
import { Outbox, type OutboxEntry } from './outbox'

/* ---- wire types (worker/API.md) ---- */

interface BookSummary {
  id: string
  title: string
  author: string | null
  language: string | null
  filename: string | null
  sizeBytes: number
  hasCover: boolean
  status: NonNullable<BookMeta['status']>
  chapterCount: number
  chunkCount: number
  indexedChunks: number
  progress: { percent?: number; location?: { leaf?: number } | null; updatedAt: number } | null
  createdAt: number
}

interface ServerAnnotation {
  id: string
  bookId: string
    kind: MarkKind
  color: string
  anchor: Record<string, unknown>
  text: string | null
  noteId: string | null
  createdAt: number
  updatedAt: number
}

interface ServerNote {
  id: string
  bookId: string
  text: string
  color: string
  x: number
  y: number
  annotationId: string | null
  anchor: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

const enc = encodeURIComponent
/** debounce for edits of something the server already has (typing in a note collapses into one PATCH) */
const FLUSH_MS = 350
/** debounce for creating an annotation / note: send almost immediately so a quick reload loses nothing */
const FLUSH_CREATE_MS = 40

function nearestColor(c: string): MarkColor {
  if (c in MARK_COLORS) return c as MarkColor
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(c)
  if (!m) return 'yellow'
  let h = m[1]
  if (h.length === 3) h = [...h].map((x) => x + x).join('')
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  let best: MarkColor = 'yellow'
  let bd = Infinity
  for (const [k, v] of Object.entries(MARK_COLORS)) {
    const t = [1, 3, 5].map((i) => parseInt(v.fill.slice(i, i + 2), 16))
    const d = t.reduce((s, x, i) => s + (x - rgb[i]) ** 2, 0)
    if (d < bd) {
      bd = d
      best = k as MarkColor
    }
  }
  return best
}

const noteIdFor = (annotationId: string) => 'n_' + annotationId

export function fromServerBook(b: BookSummary): BookMeta {
  const leaf = b.progress?.location?.leaf
  return {
    id: b.id,
    title: b.title,
    author: b.author ?? '',
    language: b.language ?? '',
    addedAt: b.createdAt,
    size: b.sizeBytes,
    filename: b.filename ?? undefined,
    coverDataUrl: b.hasCover ? `/api/books/${enc(b.id)}/cover` : undefined,
    lastLeaf: typeof leaf === 'number' ? leaf : undefined,
    lastPercent: b.progress?.percent,
      // progress.updatedAt is refreshed by every progress PUT, so it doubles as the last-read time.
      lastReadAt: b.progress?.updatedAt,
    status: b.status,
    indexPercent: b.chunkCount ? Math.round((b.indexedChunks / b.chunkCount) * 100) : undefined,
  }
}

export function toServerAnnotation(a: Annotation) {
  return {
    id: a.id,
    kind: a.kind,
    color: a.color,
    anchor: { chapter: a.locator.chapter, start: a.locator.start, end: a.locator.end, quote: a.quote.slice(0, 600) },
    text: a.quote,
  }
}

export function toServerNote(a: Annotation) {
  const n = a.note!
  return {
    id: noteIdFor(a.id),
    text: n.text,
    color: NOTE_TEXT_COLORS[noteTextColorOf(n.textColor)].ink,
    x: n.x,
    y: n.y,
    anchor: noteWireAnchor(n, a.locator),
    annotationId: a.id,
  }
}

export function fromServerAnnotation(a: ServerAnnotation, n?: ServerNote): Annotation | null {
  const an = a.anchor ?? {}
  const chapter = Number(an.chapter ?? an.spineIndex)
  const start = Number(an.start)
  const end = Number(an.end)
  if (![chapter, start, end].every(Number.isFinite) || end <= start) return null
  const tags = n ? noteTagsFromAnchor(n.anchor) : undefined
  // Legacy note.color held the source mark's colour, not a chosen text ink.
  const textColor = noteTextColorOf(n?.anchor?.textColor)
  const font = noteFontIdOf(n?.anchor?.font)
  return {
    id: a.id,
    bookId: a.bookId,
    locator: { chapter, start, end },
    quote: a.text ?? String(an.quote ?? ''),
    kind: a.kind,
    color: nearestColor(a.color),
    note: n ? { text: n.text, x: n.x, y: n.y, rot: Number(n.anchor?.rot ?? 0), ...(tags ? { tags } : {}), ...(textColor !== 'default' ? { textColor } : {}), ...(font !== 'inherit' ? { font } : {}) } : undefined,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }
}

interface Pending {
  a: Annotation
  timer: number
  v: number
  since: number
}

/**
 * HTTP implementation of StorageAdapter for the Cloudflare Worker backend (worker/API.md).
 *
 * - Auth is a same-origin cookie session; every request goes through `api()` with `credentials: 'include'`.
 * - The reader keeps a sticky note inside its Annotation, the backend has two collections; this adapter splits and
 *   re-joins them (note id = "n_" + annotation id, note.annotationId / annotation.noteId link both ways).
 * - Annotation writes are coalesced per id (typing in a note would otherwise PATCH on every key) and serialized.
 */
export class ApiAdapter implements StorageAdapter {
  onError?: (err: unknown) => void
  readonly saves = new AnnotationSaveStateStore()

  private knownAnn = new Set<string>()
  private knownNote = new Set<string>()
  private lastSent = new Map<string, string>()
  private lastStyle = new Map<string, string>()
  private pending = new Map<string, Pending>()
  private chains = new Map<string, Promise<void>>()
  private progressTimer = 0
  private progressPatch: { id: string; leaf?: number; percent?: number } | null = null

  private readonly listeners = new AbortController()
  private readonly outbox = new Outbox()
  /** outbox versions already handed to the browser as keepalive requests (avoid resending on pagehide + beforeunload) */
  private dispatched = new Map<string, number>()
  private replaying: Promise<void> | null = null

  constructor() {
    if (typeof window !== 'undefined') {
      const { signal } = this.listeners
      // pagehide alone is not reliable (and does not fire on every desktop close/reload path), so cover all of them.
      // These handlers are synchronous on purpose: only keepalive requests started during the event survive the unload.
      const unload = () => this.flushKeepalive()
      window.addEventListener('online', () => {
        if (getStorageMode() === 'api') void this.replay().catch(() => undefined)
      }, { signal })
      window.addEventListener('pagehide', unload, { signal })
      window.addEventListener('beforeunload', unload, { signal })
      document.addEventListener(
        'visibilitychange',
        () => {
          if (document.visibilityState === 'hidden') unload()
        },
        { signal },
      )
    }
  }

  dispose() {
    this.listeners.abort()
  }

  /* ----------------------------- books ----------------------------- */

  async listBooks() {
    const { books } = await api<{ books: BookSummary[] }>('/books')
    void this.replay().catch(() => undefined)
    return books.map(fromServerBook)
  }

  async getBookFile(id: string) {
    const res = await fetch(`/api/books/${enc(id)}/file`, { credentials: 'include' })
    if (res.status === 404) return null
    if (!res.ok) throw await toApiError(res)
    return res.blob()
  }

  async saveBook(meta: BookMeta, file: Blob) {
    const form = new FormData()
    form.append('file', file, meta.filename || meta.title + '.epub')
    form.append('title', meta.title)
    const { book } = await api<{ book: BookSummary }>('/books', { method: 'POST', body: form })
    const out = fromServerBook(book)
    return { ...out, coverDataUrl: out.coverDataUrl ?? meta.coverDataUrl }
  }

  async updateBook(id: string, patch: Partial<BookMeta>) {
    if (patch.title !== undefined || patch.author !== undefined) {
      await api(`/books/${enc(id)}`, { method: 'PATCH', body: jsonBody({ title: patch.title, author: patch.author }) })
    }
    if (patch.lastLeaf !== undefined || patch.lastPercent !== undefined) {
      this.progressPatch = { id, leaf: patch.lastLeaf ?? this.progressPatch?.leaf, percent: patch.lastPercent ?? this.progressPatch?.percent }
      window.clearTimeout(this.progressTimer)
      this.progressTimer = window.setTimeout(() => void this.flushProgress(), 700)
    }
  }

  private async flushProgress() {
    const p = this.progressPatch
    this.progressPatch = null
    if (!p) return
    const body: Record<string, unknown> = {}
    if (p.leaf !== undefined) body.location = { leaf: p.leaf }
    if (p.percent !== undefined) body.percent = Math.max(0, Math.min(100, p.percent))
    try {
      await api(`/books/${enc(p.id)}/progress`, { method: 'PUT', body: jsonBody(body) })
    } catch (e) {
      this.report(e)
    }
  }

  async deleteBook(id: string) {
    await api(`/books/${enc(id)}`, { method: 'DELETE' })
    await this.outbox.ready
    for (const [key, entry] of this.pending) {
      if (entry.a.bookId !== id) continue
      window.clearTimeout(entry.timer)
      this.pending.delete(key)
    }
    for (const entry of this.outbox.snapshot(id)) {
      this.outbox.remove(entry.id, entry.v)
      this.dispatched.delete(entry.id)
    }
    if (this.progressPatch?.id === id) {
      window.clearTimeout(this.progressTimer)
      this.progressPatch = null
    }
  }

  /* --------------------------- annotations --------------------------- */

  async listAnnotations(bookId: string) {
    await this.replay(bookId).catch(() => undefined)
    const [a, n] = await Promise.all([
      api<{ annotations: ServerAnnotation[] }>(`/books/${enc(bookId)}/annotations`),
      api<{ notes: ServerNote[] }>(`/books/${enc(bookId)}/notes`),
    ])
    const notes = new Map<string, ServerNote>()
    for (const note of n.notes) {
      this.knownNote.add(note.id)
      if (note.annotationId) notes.set(note.annotationId, note)
    }
    const out: Annotation[] = []
    for (const ann of a.annotations) {
      this.knownAnn.add(ann.id)
      const note = notes.get(ann.id) ?? (ann.noteId ? n.notes.find((x) => x.id === ann.noteId) : undefined)
      const mapped = fromServerAnnotation(ann, note)
      if (mapped) {
        out.push(mapped)
        this.lastSent.set(ann.id, this.signature(mapped))
        this.lastStyle.set(ann.id, mapped.kind + '|' + mapped.color)
      }
    }
    return this.overlayOutbox(bookId, out)
  }

  /** writes the server has not acknowledged yet (replay failed / still in flight) win over what the server returned */
  private overlayOutbox(bookId: string, list: Annotation[]) {
    const byId = new Map(list.map((x) => [x.id, x]))
    for (const e of this.outbox.snapshot(bookId)) {
      if (e.op === 'delete') byId.delete(e.id)
      else if (e.a) byId.set(e.id, e.a)
    }
    return [...byId.values()]
  }

  putAnnotation(a: Annotation): Promise<void> {
    const cur = this.pending.get(a.id)
    if (cur) window.clearTimeout(cur.timer)
    const v = this.outbox.nextVersion()
    this.outbox.put({ id: a.id, bookId: a.bookId, op: 'put', a, v })
    const creating = !this.knownAnn.has(a.id) || (!!a.note && !this.knownNote.has(noteIdFor(a.id)))
    const since = cur?.since ?? Date.now()
    // Flush continuous typing at least every 1.5 seconds; network delivery may take longer.
    const delay = Math.min(creating ? FLUSH_CREATE_MS : FLUSH_MS, Math.max(0, 1500 - (Date.now() - since)))
    const timer = window.setTimeout(() => void this.flushOne(a.id), delay)
    this.pending.set(a.id, { a, timer, v, since })
    this.saves.set(a.id, v, 'saving')
    return Promise.resolve()
  }

  async deleteAnnotation(id: string, bookId: string) {
    const p = this.pending.get(id)
    if (p) {
      window.clearTimeout(p.timer)
      this.pending.delete(id)
    }
    const v = this.outbox.nextVersion()
    this.outbox.put({ id, bookId, op: 'delete', v })
    try {
      await this.enqueue(id, () => this.performDelete(id, bookId, false))
      this.outbox.remove(id, v)
    } catch (e) {
      this.report(e)
    }
  }

  private async performDelete(id: string, bookId: string, force: boolean) {
    const nid = noteIdFor(id)
    if (force || this.knownNote.has(nid)) {
      await this.tolerate404(() => api(`/books/${enc(bookId)}/notes/${enc(nid)}`, { method: 'DELETE' }))
      this.knownNote.delete(nid)
    }
    await this.tolerate404(() => api(`/books/${enc(bookId)}/annotations/${enc(id)}`, { method: 'DELETE' }))
    this.knownAnn.delete(id)
    this.lastSent.delete(id)
  }

  /** Push everything that is still waiting in the debounce window. */
  async flush() {
    window.clearTimeout(this.progressTimer)
    await Promise.all([this.flushProgress(), ...[...this.pending.keys()].map((id) => this.flushOne(id))])
  }

  /** Done and manual retry flush only this note, including an interrupted earlier request. */
  async flushAnnotation(id: string) {
    await this.outbox.ready
    if (this.pending.has(id)) await this.flushOne(id)
    else if (this.chains.has(id)) await this.chains.get(id)?.catch(() => undefined)
    else {
      const entry = this.outbox.snapshot().find(e => e.id === id)
      if (!entry) return
      this.saves.set(id, entry.v, 'saving')
      try {
        await this.enqueue(id, () => this.replayEntry(entry))
        this.outbox.remove(id, entry.v)
        this.saves.set(id, entry.v, 'saved')
      } catch (error) {
        this.saves.set(id, entry.v, 'error')
        this.report(error)
      }
    }
  }

  private signature(a: Annotation) {
    return annotationSignature(a)
  }

  private async flushOne(id: string) {
    const p = this.pending.get(id)
    if (!p) return
    window.clearTimeout(p.timer)
    this.pending.delete(id)
    try {
      await this.enqueue(id, () => this.sync(p.a))
      this.outbox.remove(id, p.v)
      this.saves.set(id, p.v, 'saved')
    } catch (e) {
      this.saves.set(id, p.v, 'error')
      this.report(e)
    }
  }

  /**
   * Re-send writes that were recorded but never confirmed (reload / close before the debounce or the request finished).
   * Idempotent: creates tolerate 409 and then patch, so entries whose keepalive request did arrive replay harmlessly.
   * Entries the server rejects as not-ours (404 / 403) are dropped; auth or network failures keep them for the next load.
   */
  replay(bookId?: string): Promise<void> {
    if (!bookId && this.replaying) return this.replaying
    const run = async () => {
      await this.outbox.ready
      for (const e of this.outbox.snapshot(bookId)) {
        if (this.pending.has(e.id)) continue
        this.saves.set(e.id, e.v, 'saving')
        try {
          await this.enqueue(e.id, () => this.replayEntry(e))
          this.outbox.remove(e.id, e.v)
          this.saves.set(e.id, e.v, 'saved')
        } catch (err) {
          this.saves.set(e.id, e.v, 'error')
          if (err instanceof ApiError && (err.status === 404 || err.status === 403)) this.outbox.remove(e.id, e.v)
          else if (err instanceof ApiError && (err.status === 401 || err.status === 0)) return
          else this.report(err)
        }
      }
    }
    const p = run().finally(() => {
      if (!bookId) this.replaying = null
    })
    if (!bookId) this.replaying = p
    return p
  }

  private async replayEntry(e: OutboxEntry) {
    if (e.op === 'delete') return this.performDelete(e.id, e.bookId, true)
    if (e.a) {
      this.lastSent.delete(e.id)
      await this.sync(e.a)
    }
  }

  /**
   * Synchronous unload flush: hand every unconfirmed write to the browser as a keepalive request in the same tick, because
   * nothing awaited can run once the page is going away. Requests of one entry are independent (the Worker has no foreign keys
   * between annotations and notes), so they are sent in parallel. The outbox keeps the entries, the next load replays them
   * (idempotent), so a request the browser drops or a payload over the keepalive budget is still not lost.
   */
  flushKeepalive() {
    let budget = KEEPALIVE_BUDGET
    const queue: [string, string, string?][] = []
    const take = (reqs: [string, string, string?][]) => {
      const need = reqs.reduce((n, r) => n + (r[2] ? bodyBytes(r[2]) : 0) + 200, 0)
      if (need > budget) return false
      budget -= need
      queue.push(...reqs)
      return true
    }
    for (const e of this.outbox.snapshot()) {
      if (this.dispatched.get(e.id) === e.v) continue
      const reqs = e.op === 'delete' ? this.deleteRequests(e) : this.putRequests(e.a!)
      if (!reqs.length || take(reqs)) this.dispatched.set(e.id, e.v)
    }
    const p = this.progressPatch
    if (p) {
      const body: Record<string, unknown> = {}
      if (p.leaf !== undefined) body.location = { leaf: p.leaf }
      if (p.percent !== undefined) body.percent = Math.max(0, Math.min(100, p.percent))
      take([['PUT', `/books/${enc(p.id)}/progress`, jsonBody(body)]])
    }
    for (const [m, path, body] of queue) sendKeepalive(m, path, body)
  }

  private deleteRequests(e: OutboxEntry): [string, string, string?][] {
    const base = `/books/${enc(e.bookId)}`
    return [
      ['DELETE', `${base}/notes/${enc(noteIdFor(e.id))}`],
      ['DELETE', `${base}/annotations/${enc(e.id)}`],
    ]
  }

  private putRequests(a: Annotation): [string, string, string?][] {
    if (this.lastSent.get(a.id) === this.signature(a)) return []
    const base = `/books/${enc(a.bookId)}`
    const nid = noteIdFor(a.id)
    const reqs: [string, string, string?][] = []
    const style = a.kind + '|' + a.color
    if (!this.knownAnn.has(a.id)) {
      reqs.push(['POST', `${base}/annotations`, jsonBody({ ...toServerAnnotation(a), noteId: a.note ? nid : null })])
    } else {
      if (this.lastStyle.get(a.id) !== style) reqs.push(['PATCH', `${base}/annotations/${enc(a.id)}`, jsonBody({ kind: a.kind, color: a.color })])
      if (a.note && !this.knownNote.has(nid)) reqs.push(['PATCH', `${base}/annotations/${enc(a.id)}`, jsonBody({ noteId: nid })])
    }
    if (a.note) {
      const body = toServerNote(a)
      if (!this.knownNote.has(nid)) reqs.push(['POST', `${base}/notes`, jsonBody(body)])
      else {
        const { id: _id, annotationId: _aid, ...patch } = body
        void _id
        void _aid
        reqs.push(['PATCH', `${base}/notes/${enc(nid)}`, jsonBody(patch)])
      }
    } else if (this.knownNote.has(nid)) {
      reqs.push(['PATCH', `${base}/annotations/${enc(a.id)}`, jsonBody({ noteId: null })])
      reqs.push(['DELETE', `${base}/notes/${enc(nid)}`])
    }
    return reqs
  }

  private enqueue(id: string, job: () => Promise<void>) {
    const prev = this.chains.get(id) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(job)
    this.chains.set(id, next)
    return next.finally(() => {
      if (this.chains.get(id) === next) this.chains.delete(id)
    })
  }

  private async sync(a: Annotation) {
    const sig = this.signature(a)
    if (this.lastSent.get(a.id) === sig) return
    const base = `/books/${enc(a.bookId)}`
    const nid = noteIdFor(a.id)
    const style = a.kind + '|' + a.color

    if (!this.knownAnn.has(a.id)) {
      try {
        await api(`${base}/annotations`, { method: 'POST', body: jsonBody(toServerAnnotation(a)) })
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e
        // already created by an unload keepalive request or an earlier session: make sure style and note link are current
        await api(`${base}/annotations/${enc(a.id)}`, { method: 'PATCH', body: jsonBody({ kind: a.kind, color: a.color }) })
      }
      this.knownAnn.add(a.id)
      this.lastStyle.set(a.id, style)
    } else if (this.lastStyle.get(a.id) !== style) {
      await api(`${base}/annotations/${enc(a.id)}`, { method: 'PATCH', body: jsonBody({ kind: a.kind, color: a.color }) })
      this.lastStyle.set(a.id, style)
    }

    if (a.note) {
      const body = toServerNote(a)
      if (!this.knownNote.has(nid)) {
        try {
          await api(`${base}/notes`, { method: 'POST', body: jsonBody(body) })
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) throw e
          const { id: _id, annotationId: _aid, ...patch } = body
          void _id
          void _aid
          await api(`${base}/notes/${enc(nid)}`, { method: 'PATCH', body: jsonBody(patch) })
        }
        this.knownNote.add(nid)
        await api(`${base}/annotations/${enc(a.id)}`, { method: 'PATCH', body: jsonBody({ noteId: nid }) })
      } else {
        const { id: _id, annotationId: _aid, ...patch } = body
        void _id
        void _aid
        await api(`${base}/notes/${enc(nid)}`, { method: 'PATCH', body: jsonBody(patch) })
      }
    } else if (this.knownNote.has(nid)) {
      await api(`${base}/annotations/${enc(a.id)}`, { method: 'PATCH', body: jsonBody({ noteId: null }) })
      await this.tolerate404(() => api(`${base}/notes/${enc(nid)}`, { method: 'DELETE' }))
      this.knownNote.delete(nid)
    }
    this.lastSent.set(a.id, sig)
  }

  private async tolerate404(fn: () => Promise<unknown>) {
    try {
      await fn()
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e
    }
  }

  private report(e: unknown) {
    console.warn('[sync]', e)
    this.onError?.(e)
  }
}
