import { flushAnnotation } from '../storage'
import { phonePositionKey, restoreReadingPosition } from '../book/readingPosition'
import {mergeReadTimes, orderLibrary, touchLibrary} from '../book/libraryOrder'
import { t } from '../i18n/runtime.ts'
import { DEFAULT_NOTE_FONT, noteFontIdOf, type NoteFontId } from '../book/noteFontCatalog'
import { readerFontIdOf, quoteFontIdOf, type ReaderFontId, type QuoteFontId } from '../book/fontCatalog'
import { create } from 'zustand'
import { ApiError } from '../api/http'
import { authApi, type User } from '../api/auth'
import {
    JUDOU_DEFAULT_SYMBOL,
    MARK_COLORS,
    resolveJudou,
    noteLayoutSignature,
    noteTextColorOf,
    uid,
    type Annotation,
    type Locator,
    type MarkColor,
    type MarkKind,
    type NoteTextColor
} from '../book/annotations'
import { sanitizeNoteTags } from '../book/noteTags'
import type { BookMeta, ParsedBook } from '../book/types'
import type { ReaderScene } from '../engine/scene'
import { deskIdOf, endpaperIdOf, loadPrefs, savePrefs, TILT_MAX, TILT_MIN, type DeskId, type EndpaperId } from '../settings'
import { BOOK_UNAVAILABLE, bookIdFromPath } from '../route/bookPath'
import { runHistoryNav } from '../route/historyLock'
import { flushStorage, getAnnotationSaveState, getStorageMode, onSyncError, setStorageMode, storage } from '../storage'

export type Session =
  | { status: 'checking' }
  | { status: 'anon' }
  | { status: 'user'; user: User }
  | { status: 'local' }

export interface CurrentBook {
  meta: BookMeta
  parsed: ParsedBook
}

type Panel = 'none' | 'library' | 'toc'

/** hold: a deep link is still resolving. keep: a lookup failed and the id should stay for a retry. */
export type UrlLock = 'none' | 'hold' | 'keep'

interface Popover {
  kind: 'selection' | 'mark'
  rect: { left: number; top: number; width: number; height: number }
  locator?: Locator
  text?: string
  id?: string
}

interface ReaderState {
  scene: ReaderScene | null
  library: BookMeta[]
  current: CurrentBook | null
  loading: { progress: number; label: string } | null
  error: string | null
  annotations: Annotation[]
  panel: Panel
  popover: Popover | null
  editingNote: { id: string; rect: { left: number; top: number; width: number; height: number } } | null
  ask: { kind: 'book' } | { kind: 'passage'; locator: Locator; text: string; rect: Popover['rect'] } | null
  open: boolean
  turned: number
  leafCount: number
  phoneControls: boolean
  zoom: number
  tilt: number
  desk: DeskId
  readerFont: ReaderFontId
  quoteFont: QuoteFontId
  endpaper: EndpaperId
  turnHintSeen: boolean
  tiltHintSeen: boolean
  lastColor: MarkColor
  lastKind: MarkKind
  toast: string | null
  session: Session
  providers: { email: boolean; google: boolean }
  showLogin: boolean
  authError: string | null
  /** While a /book/<id> link is resolving, or after a transient miss, don't strip it from the address. */
  urlLock: UrlLock

  initSession(): Promise<void>
  /** Open the book named in the address, or the ?sample= book, once the session can read it. */
  resolveRoute(): Promise<void>
  /** Open a stored book by the id already in the address. Unknown ids stay on the shelf. */
  openFromRoute(id: string): Promise<void>
  /** Drop the loaded book and show the shelf. Cover-close does not call this. */
  returnToShelf(): void
  loggedIn(user: User): Promise<void>
  logout(): Promise<void>
  goOffline(): void
  setShowLogin(v: boolean): Promise<void>
  setScene(s: ReaderScene | null): void
  saveReadingProgress(): Promise<void>
  setTilt(rad: number, animate?: boolean): void
  setReaderFont(id: ReaderFontId): Promise<void>
  setQuoteFont(id: QuoteFontId): Promise<void>
  setReadingFonts(reader: ReaderFontId, quote: QuoteFontId): Promise<void>
  setDesk(id: DeskId): void
  setEndpaper(id: EndpaperId): void
  /** the scene moved the tilt itself (drag, glide, T): mirror it into the store, persist once settled */
  syncTilt(rad: number, persist: boolean): void
  dismissTurnHint(): void
  dismissTiltHint(): void
  refreshLibrary(): Promise<'ok' | 'anon' | 'error'>
  openBlob(blob: Blob, name?: string, knownId?: string, opts?: { sample?: boolean }): Promise<void>
  openSample(name?: string): Promise<void>
  openFromLibrary(id: string, opts?: { quiet?: boolean }): Promise<void>
  removeBook(id: string): Promise<void>
  setPanel(p: Panel): void
  setPopover(p: Popover | null): void
  mark(kind: MarkKind, color: MarkColor, withNote?: boolean): Promise<void>

  toggleJudou(locator: Locator): Promise<void>
  restyle(id: string, patch: Partial<Pick<Annotation, 'kind' | 'color'>>): Promise<void>
  removeMark(id: string): Promise<void>
  updateNoteText(id: string, text: string): Promise<void>
  updateNoteTextColor(id: string, color: NoteTextColor): Promise<void>
  updateNoteFont(id: string, font: NoteFontId): Promise<void>
  updateNoteTags(id: string, tags: string[]): Promise<void>
  reflowNotes(focusNoteId?: string): Promise<void>
  editNote(id: string, anchor?: Popover['rect']): Promise<void>
  finishNoteEditing(keepNoteInView?: boolean): void
  moveNote(id: string, x: number, y: number, rot: number): void
  addNoteToMark(id: string): Promise<void>
  removeNote(id: string): Promise<void>
  startAsk(): void
  openAsk(): void
  closeAsk(): void
  say(msg: string): void
  goToToc(chapter: number, block?: number): void
}

let toastTimer = 0
let libraryTimer = 0
let localJudouWrite = Promise.resolve()
let noteLayoutVersion = 0
const noteFontSelections = new Map<string, symbol>()
/** Read times recorded in this page session, merged over a refresh that may not see them yet. */
const sessionReadAt = new Map<string, number>()

function recordRead(books: BookMeta[], id: string, at: number) {
    sessionReadAt.set(id, Math.max(sessionReadAt.get(id) ?? 0, at))
    return touchLibrary(books, id, at)
}

function bookAndNoteText(parsed: ParsedBook, annotations: Annotation[]) {
  return '笔记·续写下你的想法Note continued Write your thoughts' + parsed.meta.title + parsed.meta.author + parsed.chapters.map((ch) => ch.blocks.map((b) => b.text).join('')).join('') +
    annotations.map((a) => a.note ? a.note.text + (a.note.tags ?? []).join('') : '').join('')
}

function pendingBookLoading() {
  return bookIdFromPath(location.pathname) ? { progress: 0, label: t("Opening") } : null
}

function releaseUrlLock() {
  if (useReader.getState().urlLock === 'hold') useReader.setState({ urlLock: 'none' })
}

function showUnavailable() {
  runHistoryNav(() => {
    const st = useReader.getState()
    st.scene?.clearBook()
    useReader.setState({
      current: null,
      annotations: [],
      open: false,
      loading: null,
      panel: 'none',
      popover: null,
      ask: null,
      editingNote: null,
      error: BOOK_UNAVAILABLE,
      urlLock: 'none',
    })
    if (bookIdFromPath(location.pathname)) history.replaceState({ bookId: null, open: false }, '', '/shelf')
    st.say(BOOK_UNAVAILABLE)
  })
}

function waitForScene() {
  if (useReader.getState().scene) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error(t("Could not open the book"))), 30_000)
    const finish = (error?: Error) => {
      window.clearTimeout(timer)
      unsub()
      if (error) reject(error)
      else resolve()
    }
    const unsub = useReader.subscribe((s) => {
      if (s.scene) finish()
      else if (s.error) finish(new Error(s.error))
    })
    const state = useReader.getState()
    if (state.scene) finish()
    else if (state.error) finish(new Error(state.error))
  })
}

/** A new EPUB may be uploaded only for a signed-in API session. */
export function canImportBook() {
  return useReader.getState().session.status === 'user' && getStorageMode() === 'api'
}

onSyncError((err) => {
  const offline = err instanceof ApiError && err.status === 0
  const unavailable = err instanceof ApiError && err.status >= 500
  useReader.getState().say(offline ? t("Offline - changes will not sync") : unavailable ? t("Cloud sync is temporarily unavailable. Changes have not reached the server.") : t("Could not sync a change"))
})

export const useReader = create<ReaderState>((set, get) => ({
  scene: null,
  library: [],
  current: null,
  loading: null,
  error: null,
  annotations: [],
  panel: 'none',
  popover: null,
  editingNote: null,
  ask: null,
  open: false,
  turned: 0,
  leafCount: 0,
  phoneControls: false,
  zoom: 1,
  tilt: loadPrefs().tilt,
  desk: loadPrefs().desk,
  readerFont: loadPrefs().readerFont,
  quoteFont: loadPrefs().quoteFont,
  endpaper: loadPrefs().endpaper,
  turnHintSeen: loadPrefs().turnHintSeen,
  tiltHintSeen: loadPrefs().tiltHintSeen,
  lastColor: 'yellow',
  lastKind: 'highlight',
  toast: null,
  session: { status: 'checking' },
  providers: { email: true, google: false },
  showLogin: false,
  authError: null,
  urlLock: 'hold',

  async initSession() {
    set({ urlLock: 'hold' })
    const params = new URLSearchParams(location.search)
    const authError = params.get('auth_error')
    if (authError) {
      set({ authError, showLogin: true })
      history.replaceState(null, '', location.pathname === '/' ? '/shelf' : location.pathname)
    }
    try {
      if (import.meta.env.VITE_BACKEND === 'local') {
        setStorageMode('local')
        set({ session: { status: 'local' }, loading: pendingBookLoading() })
        await get().refreshLibrary()
        await get().resolveRoute()
        return
      }
      try {
        const user = await authApi.me(AbortSignal.timeout(8000))
        await get().loggedIn(user)
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.code === 'terms_required')) {
          if (err.code === 'terms_required') set({ authError: 'terms_required', showLogin: true })
          // Only an already-visible sign-in form needs provider configuration.
          if (get().showLogin) void authApi.providers().then(providers => set({ providers })).catch(() => undefined)
          setStorageMode('local')
          const id = bookIdFromPath(location.pathname)
          // A sample or local book already in this browser reopens. A server id that is not here
          // stays on the address and lands on sign-in, without requesting the file.
          if (id) {
            const listed = await get().refreshLibrary()
            if (listed === 'ok' && get().library.some((b) => b.id === id)) {
              set({ session: { status: 'local' }, loading: { progress: 0, label: t("Opening") } })
              await get().resolveRoute()
              return
            }
            // A server id that is not on this device keeps the address and asks for sign-in.
            set({ session: { status: 'anon' }, library: [] })
            void authApi.providers().then(providers => set({ providers })).catch(() => undefined)
            return
          }
          // `/shelf` is the shelf. Signed-out visitors see books already in this browser.
          await get().refreshLibrary()
          set({ session: { status: 'local' } })
          await get().resolveRoute()
        } else {
          setStorageMode('local')
          set({ session: { status: 'local' }, loading: pendingBookLoading() })
          await get().refreshLibrary()
          await get().resolveRoute()
        }
      }
    } finally {
      releaseUrlLock()
    }
  },

  async resolveRoute() {
    if (get().session.status === 'anon' || get().session.status === 'checking') return
    const id = bookIdFromPath(location.pathname)
    if (id) {
      await get().openFromRoute(id)
      return
    }
    const sample = new URLSearchParams(location.search).get('sample')
    if (sample !== null) await get().openSample(sample || undefined)
  },

  async openFromRoute(id) {
    const session = get().session
    if (session.status === 'checking' || session.status === 'anon') return
    if (get().current?.meta.id === id && get().open) return
    if (get().current?.meta.id === id) {
      get().scene?.setOpen(true)
      return
    }
    const held = get().urlLock === 'hold'
    if (!held) set({ urlLock: 'hold' })
    if (!get().loading) set({ loading: { progress: 0, label: t("Opening") } })
    try {
      const listed = await get().refreshLibrary()
      if (get().session.status === 'anon' || get().session.status === 'checking' || listed === 'anon') return
      if (listed !== 'ok') {
        set({ urlLock: 'keep', loading: null })
        get().say(t("Could not open the book"))
        return
      }
      // Only ids already in this library are opened. Another account's id is not requested.
      if (!get().library.some((b) => b.id === id)) {
        showUnavailable()
        return
      }
      await get().openFromLibrary(id, { quiet: true })
      if (get().session.status === 'anon' || get().session.status === 'checking') return
      if (get().current?.meta.id !== id || !get().open) showUnavailable()
    } finally {
      if (!held) releaseUrlLock()
    }
  },

  returnToShelf() {
    get().scene?.clearBook()
    set({
      current: null,
      annotations: [],
      open: false,
      loading: null,
      panel: 'none',
      popover: null,
      ask: null,
      editingNote: null,
      error: null,
      urlLock: 'none',
    })
  },

  async loggedIn(user) {
    setStorageMode('api')
    get().scene?.clearBook()
    set({
      urlLock: 'hold',
      session: { status: 'user', user },
      showLogin: false,
      authError: null,
      current: null,
      annotations: [],
      open: false,
      library: [],
      loading: pendingBookLoading(),
    })
    try {
      await get().refreshLibrary()
      await get().resolveRoute()
    } finally {
      releaseUrlLock()
    }
  },

  async logout() {
    await flushStorage().catch(() => undefined)
    await authApi.logout().catch(() => undefined)
      sessionReadAt.clear()
    get().scene?.clearBook()
    const providers = await authApi.providers().catch(() => ({ email: true, google: false }))
    setStorageMode('local')
    // The book id stays in the address so the next sign-in can reopen it.
    set({ session: { status: 'anon' }, providers, current: null, annotations: [], open: false, library: [], panel: 'none', popover: null, ask: null, editingNote: null, urlLock: 'none', loading: null })
  },

  goOffline() {
    setStorageMode('local')
      sessionReadAt.clear()
    get().scene?.clearBook()
    set({ urlLock: 'hold', session: { status: 'local' }, showLogin: false, current: null, annotations: [], open: false, loading: pendingBookLoading() })
    void (async () => {
      try {
        await get().refreshLibrary()
        await get().resolveRoute()
      } finally {
        releaseUrlLock()
      }
    })()
  },

  async setShowLogin(v) {
    set({ showLogin: v })
    if (v) set({ providers: await authApi.providers().catch(() => ({ email: false, google: false })) })
  },

  setScene: (scene) => {
    set({ scene })
    scene?.setTilt(get().tilt, false)
    scene?.setDesk(get().desk)
    scene?.setEndpaper(get().endpaper)
  },
  async saveReadingProgress() {
    const { current, scene, session } = get()
    if (!current || !scene) return
    const progress = scene.savedProgress
    const page = scene.pagination?.pages[scene.visiblePages.right]
    if (scene.phone && page) {
      const scope = session.status === 'user' ? session.user.id : 'local'
      try {
        localStorage.setItem(phonePositionKey(scope, current.meta.id), JSON.stringify({ leaf: progress.lastLeaf,
          chapter: page.chapter, start: page.start, title: page.special === 'title' }))
      } catch { /* Reading still works when browser storage is unavailable. */ }
    }
      // Opening or turning a page leads the shelf with this book and keeps its ring current.
      const lastReadAt = Date.now()
      set({
          library: recordRead(get().library, current.meta.id, lastReadAt).map((book) =>
              book.id === current.meta.id ? {
                  ...book,
                  lastLeaf: progress.lastLeaf,
                  lastPercent: progress.lastPercent
              } : book)
      })
      await storage.updateBook(current.meta.id, {...progress, lastReadAt})
  },
  async setReaderFont(value) { await get().setReadingFonts(value, get().quoteFont) },
  async setQuoteFont(value) { await get().setReadingFonts(get().readerFont, value) },
  async setReadingFonts(value, quoteValue) {
    const readerFont = readerFontIdOf(value)
    const quoteFont = quoteFontIdOf(quoteValue)
    if ((readerFont === get().readerFont && quoteFont === get().quoteFont) || get().loading) return
    const { current, scene } = get()
    if (!current || !scene?.pagination) {
      set({ readerFont, quoteFont }); savePrefs({ readerFont, quoteFont }); return
    }
    set({ editingNote: null })
    ++noteLayoutVersion
    const config = scene.readingLayout(scene.pagination.config)
    scene.clearSelection()
    scene.suspendInteraction(true)
    set({ loading: { progress: 0.1, label: t("正在加载阅读字体…") }, popover: null })
    try {
      const [{ ensureBookFonts, readerFontFamily, quoteFontFamily }, { paginate }] = await Promise.all([import('../book/fonts'), import('../book/layout')])
      const text = bookAndNoteText(current.parsed, get().annotations) + current.meta.title + current.meta.author
      const fonts = await ensureBookFonts(readerFont, text, get().annotations, { id: quoteFont, book: current.parsed })
      if (get().current !== current || get().scene !== scene) return
      const pag = await paginate(current.parsed, { ...config, family: readerFontFamily(readerFont), quoteFamily: quoteFontFamily(quoteFont) },
        (p) => { if (get().current === current) set({ loading: { progress: 0.25 + p * 0.7, label: t("正在重新排版…") } }) }, get().annotations)
      if (get().current !== current || get().scene !== scene) return
      pag.fonts = fonts
      scene.reflow(pag)
      const turned = scene.turnedLeaves
      set({ readerFont, quoteFont, turned, leafCount: scene.leafCount })
      savePrefs({ readerFont, quoteFont })
      await get().saveReadingProgress()
    } catch (error) {
      get().say(error instanceof Error ? error.message : t("字体加载失败，请重试。"))
    } finally {
      if (get().current === current && get().scene === scene) {
        scene.suspendInteraction(false)
        set({ loading: null })
      }
    }
  },
  setDesk: (id) => {
    const desk = deskIdOf(id)
    set({ desk })
    savePrefs({ desk })
    get().scene?.setDesk(desk)
  },
  setEndpaper: (id) => {
    const endpaper = endpaperIdOf(id)
    set({ endpaper })
    savePrefs({ endpaper })
    get().scene?.setEndpaper(endpaper)
  },
  setTilt: (rad, animate = true) => {
    const tilt = Math.min(TILT_MAX, Math.max(TILT_MIN, rad))
    set({ tilt })
    savePrefs({ tilt })
    get().scene?.setTilt(tilt, animate)
  },
  syncTilt: (rad, persist) => {
    const tilt = Math.min(TILT_MAX, Math.max(TILT_MIN, rad))
    set({ tilt })
    if (persist) savePrefs({ tilt })
  },
  dismissTiltHint: () => {
    if (get().tiltHintSeen) return
    set({ tiltHintSeen: true })
    savePrefs({ tiltHintSeen: true })
  },
  dismissTurnHint: () => {
    if (get().turnHintSeen) return
    set({ turnHintSeen: true })
    savePrefs({ turnHintSeen: true })
  },

  async refreshLibrary() {
    try {
        const library = orderLibrary(mergeReadTimes(await storage.listBooks(), sessionReadAt))
      set({ library })
      window.clearTimeout(libraryTimer)
      if (library.some((b) => b.status && b.status !== 'ready' && b.status !== 'failed')) libraryTimer = window.setTimeout(() => void get().refreshLibrary(), 4000)
      return 'ok' as const
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        set({ session: { status: 'anon' }, library: [] })
        return 'anon' as const
      }
      return 'error' as const
    }
  },

  async openBlob(blob, name, knownId, opts) {
    // Samples and books already stored are not uploads. Anything else must not be saved while signed out.
    if (!knownId && !opts?.sample && !canImportBook()) {
      await get().setShowLogin(true)
      return
    }
    set({ loading: { progress: 0, label: t("Opening") }, error: null, panel: 'none', popover: null, ask: null, editingNote: null })
    try {
      const { prepareBook } = await import('../book/loader')
      const prepared = await prepareBook(blob, undefined, (p, label) => {
        if (!get().error) set({ loading: { progress: p, label } })
      })
      // A concurrently loading reader module may have failed while fonts were downloading.
      if (get().error) throw new Error(get().error!)
      // identify by title+author+size so re-dropping the same file reuses annotations
      const idSeed = `${prepared.parsed.meta.title}|${prepared.parsed.meta.author}|${blob.size}`
      let h = 5381
      for (let i = 0; i < idSeed.length; i++) h = ((h << 5) + h + idSeed.charCodeAt(i)) >>> 0
      const hashId = 'bk_' + h.toString(36)
      const known = await storage.listBooks()
      const existing = known.find((b) => b.id === (knownId ?? hashId)) ?? (name ? known.find((b) => b.size === blob.size && b.filename === name) : undefined)
      let meta: BookMeta
      if (existing) meta = existing
      else {
        set({ loading: { progress: 1, label: t("Saving") } })
        meta = await storage.saveBook(
          {
            id: hashId,
            title: prepared.parsed.meta.title || name || t("Untitled"),
            author: prepared.parsed.meta.author,
            language: prepared.parsed.meta.language,
            addedAt: Date.now(),
            coverDataUrl: prepared.coverDataUrl,
            lastLeaf: 0,
            size: blob.size,
            filename: name,
          },
          blob,
        )
      }
      const id = meta.id
      const annotations = await storage.listAnnotations(id)
      if (annotations.some((a) => a.note)) {
        const [{ ensureBookFonts }, { paginate }] = await Promise.all([import('../book/fonts'), import('../book/layout')])
        const fonts = await ensureBookFonts(get().readerFont, bookAndNoteText(prepared.parsed, annotations), annotations, { id: get().quoteFont, book: prepared.parsed })
        prepared.loaded.pag = await paginate(prepared.parsed, prepared.loaded.pag.config, undefined, annotations)
        prepared.loaded.pag.fonts = fonts
      }
      let turned = meta.lastLeaf ?? 0
      await waitForScene()
      const scene = get().scene
      if (!scene) throw new Error(t("Could not open the book"))
      if (scene.phone) {
        const [{ paginate }, { reflowTarget }] = await Promise.all([import('../book/layout'), import('../engine/reflowTarget')])
        const desktop = prepared.loaded.pag
        const pag = await paginate(prepared.parsed, scene.readingLayout(desktop.config), undefined, annotations)
        pag.fonts = desktop.fonts
        turned = reflowTarget(desktop, pag, [2 * turned - 1, 2 * turned])
        const session = get().session
        const scope = session.status === 'user' ? session.user.id : 'local'
        try {
          const saved = JSON.parse(localStorage.getItem(phonePositionKey(scope, id)) ?? 'null')
          turned = restoreReadingPosition(saved, meta.lastLeaf ?? 0, pag) ?? turned
        } catch { /* Ignore missing, stale or malformed device-local progress. */ }
        prepared.loaded = { ...prepared.loaded, progressPag: desktop, pag }
      }
      scene?.setAnnotations(annotations)
      // Choosing a book opens it, so the address can carry this book's existing id.
      scene?.loadBook({ ...prepared.loaded, id, turned }, true)
      set({
        current: { meta, parsed: prepared.parsed },
        annotations,
        turned: scene?.turnedLeaves ?? turned,
        loading: null,
        leafCount: scene?.leafCount ?? 0,
        open: true,
        phoneControls: false,
        urlLock: 'none',
        error: null,
      })
        // Opening counts as reading, so a book that is never turned still leads the shelf.
        void get().saveReadingProgress().catch(() => undefined)
      await get().refreshLibrary()
    } catch (err) {
      console.error(err)
      const msg = err instanceof ApiError && err.status === 401 ? t("Your session expired. Please sign in again.") : err instanceof Error ? err.message : String(err)
      set({ loading: null, error: msg })
      get().say(msg)
      if (err instanceof ApiError && err.status === 401) set({ session: { status: 'anon' } })
    }
  },

  async openSample(name = 'alice') {
    set({ loading: { progress: 0, label: t("Loading book") }, error: null })
    const file = name === 'zh' ? 'zh-sample.epub' : 'alice.epub'
    try {
      const res = await fetch('/samples/' + file)
      if (!res.ok) throw new Error(t("Could not open the book"))
      await get().openBlob(await res.blob(), file, undefined, { sample: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : t("Could not open the book")
      set({ loading: null, error: message })
      get().say(message)
    }
  },

  async openFromLibrary(id, opts) {
    // File retrieval is part of opening: show feedback before waiting for R2/IndexedDB.
    const downloading = { progress: 0, label: t("Loading book") }
    set({ loading: downloading, error: null, panel: 'none', popover: null, ask: null, editingNote: null })
    try {
      const blob = await storage.getBookFile(id)
      if (blob) await get().openBlob(blob, undefined, id)
      else if (!opts?.quiet) get().say(t("Book file not found"))
    } catch (err) {
      if (!opts?.quiet) get().say(err instanceof Error ? err.message : t("Could not open the book"))
      if (err instanceof ApiError && err.status === 401) set({ session: { status: 'anon' } })
    } finally {
      // openBlob owns parsing progress; only clear the download state this call created.
      if (get().loading === downloading) set({ loading: null })
    }
  },

  async removeBook(id) {
      sessionReadAt.delete(id)
    await storage.deleteBook(id)
    set({ library: get().library.filter((book) => book.id !== id) })
    if (get().current?.meta.id === id) {
      get().scene?.clearBook()
      set({ current: null, annotations: [], open: false })
    }
    await get().refreshLibrary()
  },

  setPanel: (panel) => {
    if (panel !== 'none') get().finishNoteEditing(false)
    set({ panel, popover: null })
  },
  setPopover: (popover) => set({ popover }),

  async mark(kind, color, withNote) {
    const { popover, current, scene } = get()
    if (!popover || !popover.locator || !current) return
    const now = Date.now()
    // merge into an existing identical range instead of stacking
    const a: Annotation = {
      id: uid(),
      bookId: current.meta.id,
      locator: popover.locator,
      quote: popover.text ?? '',
      kind,
      color,
      createdAt: now,
      updatedAt: now,
    }
    if (withNote && scene) {
      a.note = { text: '', font: DEFAULT_NOTE_FONT, x: 0, y: 0, rot: 0 }
    }
    const annotations = [...get().annotations, a]
    set({ annotations, lastColor: color, lastKind: kind, popover: null })
    scene?.clearSelection()
    scene?.setAnnotations(annotations)
    // Opening the editor must not wait for persistence or repaginate the book.
    if (withNote && get().current === current) void get().editNote(a.id, popover.rect)
    await storage.putAnnotation(a)
  },

  async toggleJudou(locator) {
    const { current, scene, lastColor } = get()
    if (!current) return
    const toggle = async () => {
      if (get().current !== current) return
      const target = resolveJudou(current.parsed.chapters[locator.chapter], locator, get().annotations)
      if (!target) return
      if (locator.start !== locator.end) scene?.clearSelection()
      set({ popover: null })
      if (target.existing) return get().removeMark(target.existing.id)
      const now = Date.now()
      const mark: Annotation = {
        id: uid(), bookId: current.meta.id, locator: target.locator, quote: target.quote,
        kind: 'judou', color: lastColor, symbol: JUDOU_DEFAULT_SYMBOL, createdAt: now, updatedAt: now,
      }
      const saving = storage.putAnnotation(mark)
      if (getStorageMode() === 'local') {
        await saving
        if (get().current !== current) return
        if (getAnnotationSaveState(mark.id) === 'error') {
          get().say(t("保存失败，请重试"))
          return
        }
      }
      const annotations = [...get().annotations, mark]
      set({ annotations })
      get().scene?.setAnnotations(annotations)
      return saving
    }
    if (getStorageMode() === 'api') return toggle()
    // Apply rapid local toggles in order so the second press sees the first committed mark.
    localJudouWrite = localJudouWrite.then(toggle, toggle)
    return localJudouWrite
  },

  async restyle(id, patch) {
    const annotations = get().annotations.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a))
    set({ annotations, lastColor: patch.color ?? get().lastColor, lastKind: patch.kind ?? get().lastKind })
    get().scene?.setAnnotations(annotations)
    const a = annotations.find((x) => x.id === id)
    if (a) await storage.putAnnotation(a)
  },

  async removeMark(id) {
    const { current } = get()
    if (!current) return
    const deletion = storage.deleteAnnotation(id, current.meta.id)
    // Cloud deletes are already in the durable outbox. Local deletes need the IndexedDB commit.
    if (getStorageMode() === 'local') {
      try { await deletion } catch {
        if (get().current === current) get().say(t("保存失败，请重试"))
        return
      }
    }
    if (get().current !== current) return
    const { annotations: previous, popover, editingNote } = get()
    const hadNote = !!previous.find((a) => a.id === id)?.note
    const annotations = previous.filter((a) => a.id !== id)
    set({ annotations, popover: popover?.id === id ? null : popover, editingNote: editingNote?.id === id ? null : editingNote })
    get().scene?.setAnnotations(annotations)
    await deletion
    if (hadNote && get().current === current) await get().reflowNotes()
  },

  async updateNoteText(id, text) {
    if (get().annotations.find(a => a.id === id)?.note?.text === text) return
    const annotations = get().annotations.map((a) => (a.id === id && a.note ? { ...a, note: { ...a.note, text }, updatedAt: Date.now() } : a))
    set({ annotations })
    get().scene?.setAnnotations(annotations)
    const a = annotations.find((x) => x.id === id)
    if (a) await storage.putAnnotation(a)
  },

  async updateNoteTextColor(id, color) {
    const existing = get().annotations.find(a => a.id === id)
    const textColor = noteTextColorOf(color)
    if (!existing?.note || noteTextColorOf(existing.note.textColor) === textColor) return
    const note = { ...existing.note }
    if (textColor === 'default') delete note.textColor
    else note.textColor = textColor
    const updated = { ...existing, note, updatedAt: Date.now() }
    const annotations = get().annotations.map(a => a.id === id ? updated : a)
    set({ annotations })
    get().scene?.setAnnotations(annotations)
    await storage.putAnnotation(updated)
  },

  async updateNoteFont(id, value) {
    const font = noteFontIdOf(value), current = get().current
    noteFontSelections.delete(id)
    const existing = get().annotations.find(a => a.id === id)
    if (!existing?.note || noteFontIdOf(existing.note.font) === font) return
    const request = Symbol()
    noteFontSelections.set(id, request)
    try {
      const { ensureInlineNoteFont } = await import('../book/fonts')
      await ensureInlineNoteFont(font, existing.note.text + (existing.note.tags ?? []).join(' '))
      if (get().current !== current || noteFontSelections.get(id) !== request) return
      // Text and tags may have changed while the font was loading.
      const latest = get().annotations.find(a => a.id === id)
      if (!latest?.note) return
      const note = { ...latest.note }
      if (font === 'inherit') delete note.font
      else note.font = font
      const updated = { ...latest, note, updatedAt: Date.now() }
      const annotations = get().annotations.map(a => a.id === id ? updated : a)
      set({ annotations })
      get().scene?.setAnnotations(annotations)
      await storage.putAnnotation(updated)
      if (get().editingNote?.id !== id) await get().reflowNotes(id)
    } catch (error) {
      if (get().current === current && noteFontSelections.get(id) === request) get().say(error instanceof Error ? error.message : t("笔记字体加载失败，请重试。"))
    } finally { if (noteFontSelections.get(id) === request) noteFontSelections.delete(id) }
  },

  async updateNoteTags(id, tags) {
    const clean = sanitizeNoteTags(tags)
    let changed = false
    const annotations = get().annotations.map((a) => {
      if (a.id !== id || !a.note) return a
      const prev = a.note.tags ?? []
      if (prev.length === clean.length && prev.every((tag, i) => tag === clean[i])) return a
      changed = true
      const note = { ...a.note }
      if (clean.length) note.tags = clean
      else delete note.tags
      return { ...a, note, updatedAt: Date.now() }
    })
    if (!changed) return
    set({ annotations })
    get().scene?.setAnnotations(annotations)
    const a = annotations.find((x) => x.id === id)
    if (a) await storage.putAnnotation(a)
  },

  async reflowNotes(focusNoteId) {
    const { current, scene, annotations, readerFont } = get()
    if (!current || !scene?.pagination) return
    const version = ++noteLayoutVersion
    const previous = scene.pagination
    const config = scene.readingLayout(previous.config)
    try {
      const [{ ensureBookFonts }, { paginate }] = await Promise.all([import('../book/fonts'), import('../book/layout')])
      // Body fonts are already loaded for the existing pagination. Only notes can
      // introduce new characters here; avoid scanning the entire book again.
      const noteText = '笔记·续写下你的想法Note continued Write your thoughts' + annotations.map(a => a.note ? a.note.text + (a.note.tags ?? []).join('') : '').join('')
      const noteFonts = await ensureBookFonts(readerFont, noteText, annotations)
      const fonts = [...new Map([...(previous.fonts ?? []), ...noteFonts].map(font => [font.url, font])).values()]
      const pag = await paginate(current.parsed, config, undefined, annotations, previous)
      if (version !== noteLayoutVersion || get().current !== current || get().scene !== scene) return
      pag.fonts = fonts
      scene.clearSelection()
      scene.reflow(pag, get().editingNote?.id ?? focusNoteId)
      set({ turned: scene.turnedLeaves, leafCount: scene.leafCount })
      await get().saveReadingProgress()
    } catch (error) {
      if (version === noteLayoutVersion && get().current === current) get().say(error instanceof Error ? error.message : t("Could not lay out notes. Please retry."))
    }
  },

  async editNote(id, anchor) {
    const { annotations, scene, editingNote, popover } = get()
    if (!annotations.some(a => a.id === id && a.note) || editingNote?.id === id) return
    // Cancel an older pending note layout before it can replace the book under
    // this editor. New/changed note content is laid out on Done, not on entry.
    ++noteLayoutVersion
    if (editingNote) void flushAnnotation(editingNote.id)
    let rect = scene?.noteScreenRect(id)
    if (!rect) {
      scene?.revealNote(id)
      rect = scene?.noteScreenRect(id)
    }
    const fallback = anchor ?? popover?.rect ?? { left: window.innerWidth / 2 - 160, top: window.innerHeight / 2 - 80, width: 320, height: 160 }
    set({ popover: null, editingNote: { id, rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : fallback } })
  },

  finishNoteEditing: (keepNoteInView = true) => {
    const { editingNote, annotations, scene } = get()
    const id = editingNote?.id
    if (!id) return
    void flushAnnotation(id)
    set({ editingNote: null })
    // Compare with what is on the page, covering both editor entry paths and
    // changes reverted before Done. Unchanged notes retain the book and textures.
    if (scene?.pagination?.noteSignature === noteLayoutSignature(annotations)) return
    void get().reflowNotes(keepNoteInView ? id : undefined)
  },

  moveNote(id, x, y, rot) {
    const annotations = get().annotations.map((a) => (a.id === id && a.note ? { ...a, note: { ...a.note, x, y, rot }, updatedAt: Date.now() } : a))
    set({ annotations })
    const a = annotations.find((q) => q.id === id)
    if (a) void storage.putAnnotation(a)
  },

  async addNoteToMark(id) {
    const { scene, popover } = get()
    const target = get().annotations.find((a) => a.id === id)
    if (!target || !scene) return
    // A repeated click must reopen the note, never replace a draft with empty text.
    if (target.note) { await get().editNote(id); return }
    const pos = { x: 0, y: 0, rot: 0 }
    const annotations = get().annotations.map((a) => (a.id === id ? { ...a, note: { text: '', font: DEFAULT_NOTE_FONT, ...pos }, updatedAt: Date.now() } : a))
    set({ annotations, popover: null })
    scene.setAnnotations(annotations)
    const a = annotations.find((x) => x.id === id)!
    void get().editNote(id, popover?.rect)
    await storage.putAnnotation(a)
  },

  async removeNote(id) {
    const annotations = get().annotations.map((a) => {
      if (a.id !== id) return a
      const { note: _n, ...rest } = a
      void _n
      return { ...rest, updatedAt: Date.now() }
    })
    set({ annotations, editingNote: null })
    get().scene?.setAnnotations(annotations)
    const a = annotations.find((x) => x.id === id)
    if (a) await storage.putAnnotation(a)
    await get().reflowNotes()
  },

  startAsk() {
    get().finishNoteEditing(false)
    const { popover, scene, annotations } = get()
    if (!popover) return
    const annotation = popover.kind === 'mark' ? annotations.find(a => a.id === popover.id) : undefined
    const locator = popover.kind === 'mark' ? annotation?.locator : popover.locator
    const text = popover.kind === 'mark' ? annotation?.quote : popover.text
    if (!locator || !text) return
    scene?.clearSelection()
    scene?.showPseudoSelection(locator)
    set({ ask: { kind: 'passage', locator, text, rect: popover.rect }, popover: null, editingNote: null, panel: 'none' })
    const room = window.innerWidth - 440
    const over = popover.rect.left + popover.rect.width + 24 - room
    if (over > 0 && window.innerWidth > 900) scene?.nudgePx(-over)
  },

  openAsk() {
    get().finishNoteEditing(false)
    if (!get().current) return
    get().scene?.clearSelection()
    get().scene?.showPseudoSelection(null)
    set({ ask: { kind: 'book' }, popover: null, editingNote: null, panel: 'none' })
  },

  closeAsk() {
    get().scene?.showPseudoSelection(null)
    set({ ask: null })
  },

  say(msg) {
    set({ toast: msg })
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => set({ toast: null }), 2600)
  },

  goToToc(chapter, block) {
    get().finishNoteEditing(false)
    const { scene, current } = get()
    if (!scene || !current) return
    const pag = scene.pagination
    if (!pag) return
    const ch = current.parsed.chapters[chapter]
    const offset = block !== undefined ? ch.blocks[block]?.start ?? 0 : 0
    const page = pag.pageForOffset(chapter, offset)
    scene.goToLeaf(scene.pageToLeafTurned(page))
    set({ panel: 'none' })
  },
}))

export function colorOf(c: MarkColor) {
  return MARK_COLORS[c]
}
