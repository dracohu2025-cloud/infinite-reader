import { t, useT, localeUrl } from '../i18n'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DESK_SURFACES } from '../settings'
import { canImportBook, useReader } from '../store/useReader'
import { Icon } from './icons'
import { ShelfControls } from './ShelfControls'
import { BookInfoDialog } from './BookInfoDialog'
import { getStorageMode } from '../storage/mode'

const PAGE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 't', 'T'])
const SHELF_BATCH = 60
const SHELF_LAYOUT_KEY = 'ir.shelf.layout'
const searchText = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()

// Original book titles and author names are kept in their source language.
const SHELF_SAMPLES = [
  { id: 'zh', filename: 'zh-sample.epub', title: '智人之后（排版样书）', author: 'Infinite Reader', label: 'Chinese sample', glyph: '文' },
  { id: 'alice', filename: 'alice.epub', title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', label: 'English classic', glyph: 'Aa' },
]

function ShelfSamples({ samples = SHELF_SAMPLES, hasBooks = false }: { samples?: typeof SHELF_SAMPLES; hasBooks?: boolean }) {
  return (
    <section className="shelf-samples" aria-labelledby="shelf-samples-title">
      <p className="shelf-samples-eyebrow">{t("No account needed")}</p>
      <h2 id="shelf-samples-title">{hasBooks ? t("More sample books") : t("Start with a sample book")}</h2>
      <p className="shelf-samples-intro">{t("Choose a book below to try reading. Sign in whenever you want to add your own books.")}</p>
      <div className="shelf-sample-grid">
        {samples.map(sample => (
          <a key={sample.id} className="shelf-sample" href={localeUrl(`/shelf?sample=${sample.id}`)}>
            <span className="shelf-sample-cover" aria-hidden="true">{sample.glyph}</span>
            <span className="shelf-sample-copy">
              <span className="shelf-sample-label">{t(sample.label)}</span>
              <span className="shelf-sample-title">{sample.title}</span>
              <span className="shelf-sample-author">{sample.author}</span>
              <span className="shelf-sample-action">{t("Read sample")}<Icon.right size={14} /></span>
            </span>
          </a>
        ))}
      </div>
    </section>
  )
}

/** Keep the return-to-shelf action available independently of reading controls. */
export function ShelfUp() {
  const current = useReader((s) => s.current)
  if (!current) return null
  return (
    <div
      className="read-chrome"
      data-ui
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (PAGE_KEYS.has(e.key)) e.stopPropagation()
      }}
    >
      <BackToShelf />
    </div>
  )
}

function BackToShelf() {
  const returnToShelf = useReader((s) => s.returnToShelf)
  return (
    <button type="button" className="shelf-up" aria-label={t("Back")} title={t("Back")} onClick={() => returnToShelf()}>
      <Icon.left size={18} />
    </button>
  )
}

function ShelfProgress({percent}: { percent: number }) {
    return <span className="shelf-progress">
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle className="shelf-progress-track" cx="16" cy="16" r="13"/>
      <circle className="shelf-progress-arc" cx="16" cy="16" r="13" pathLength={100}
              strokeDasharray={`${percent} ${100 - percent}`} transform="rotate(-90 16 16)"/>
    </svg>
        {percent}%
  </span>
}

function ShelfCover({ title, src }: { title: string; src?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const hasImage = !!src && src !== failedSrc
  return <span className="shelf-sample-cover shelf-book-cover" data-image={hasImage || undefined} aria-hidden="true">
    {hasImage ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailedSrc(src)} /> : Array.from(title.trim())[0]}
  </span>
}

function ShelfBook({title, author, cover, percent, spacious, onOpen, onDelete, onInfo}: {
    title: string;
    author?: string;
    cover?: string;
    percent?: number;
    spacious: boolean;
    onOpen: () => void;
    onDelete: () => void;
    onInfo: (anchor: HTMLButtonElement) => void
}) {
    const progress = spacious && percent !== undefined && Number.isFinite(percent)
        ? Math.min(100, Math.max(0, Math.round(percent))) : 0
  const titleRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const [showTitle, setShowTitle] = useState(false)
  const [titleAbove, setTitleAbove] = useState(false)
  const revealTitle = () => {
    const el = titleRef.current
    setShowTitle(!!el && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight + 1))
  }

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current
    const title = titleRef.current
    const list = title?.closest('.shelf-list')
    if (!showTitle || !tooltip || !title || !list) return
    const row = title.getBoundingClientRect()
    const bounds = list.getBoundingClientRect()
    // Keep the last visible row's full title inside the scrolling book list.
    setTitleAbove(row.bottom + tooltip.offsetHeight > bounds.bottom && row.top - bounds.top > bounds.bottom - row.bottom)
  }, [showTitle])

  useEffect(() => {
    if (!showTitle) return
    const dismiss = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowTitle(false)
    }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [showTitle])

  useLayoutEffect(() => {
    if (!menuPosition) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || menuButton.current?.contains(event.target))) return
      setMenuPosition(null)
    }
    const key = (event: KeyboardEvent) => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        event.preventDefault(); event.stopPropagation(); items[next]?.focus()
        return
      }
      if (event.key === 'Tab') { setMenuPosition(null); menuButton.current?.focus(); return }
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMenuPosition(null)
      menuButton.current?.focus()
    }
    const move = () => setMenuPosition(null)
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('scroll', move, true)
    window.addEventListener('resize', move)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('scroll', move, true)
      window.removeEventListener('resize', move)
    }
  }, [menuPosition])

  return (
    <li>
      <button
        type="button"
        className="shelf-book-open"
        onClick={onOpen}
        onFocus={revealTitle}
        onBlur={() => setShowTitle(false)}
        onMouseLeave={() => setShowTitle(false)}
      >
        {spacious && <ShelfCover title={title} src={cover} />}
        <span className="shelf-book-copy">
          <span className="shelf-title-wrap" onMouseEnter={revealTitle}>
            <span className="title" ref={titleRef}>{title}</span>
            {showTitle && (
              <span className="shelf-full-title" ref={tooltipRef} data-above={titleAbove ? '' : undefined} aria-hidden="true">
                <span>{title}</span>
              </span>
            )}
          </span>
          <span className="author">{author}</span>
            {spacious && <span className="shelf-book-action">
            {progress > 0 && <ShelfProgress percent={progress}/>}
                {progress > 0 ? t("Continue reading") : t("Start reading")}
                <Icon.right size={14}/>
          </span>}
        </span>
      </button>
      <button ref={menuButton} type="button" className="shelf-book-more" aria-label={t("More actions for {0}", title)}
        aria-haspopup="menu" aria-expanded={!!menuPosition} title={t("Book actions")}
        onClick={() => {
          if (menuPosition) { setMenuPosition(null); return }
          const rect = menuButton.current!.getBoundingClientRect()
          setMenuPosition({ left: Math.max(8, Math.min(window.innerWidth - 180, rect.right - 172)),
            top: rect.bottom + 100 <= window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - 100) })
        }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
        </svg>
      </button>
      {menuPosition && createPortal(
        <div ref={menuRef} className="shelf-book-menu" role="menu" aria-label={t("Actions for {0}", title)}
          style={{ top: menuPosition.top, left: menuPosition.left }} data-ui>
          <button type="button" role="menuitem" className="shelf-book-menu-info"
            onClick={() => { setMenuPosition(null); onInfo(menuButton.current!) }}>
            <Icon.library size={16} /> <span>{t("书籍信息")}</span>
          </button>
          <button type="button" role="menuitem" className="shelf-book-menu-delete"
            onClick={() => { setMenuPosition(null); onDelete() }}>
            <Icon.trash size={16} /> <span>{t("Delete book")}</span>
          </button>
        </div>, document.body,
      )}
    </li>
  )
}

function DeleteBookDialog({ title, busy, error, onCancel, onConfirm }: {
  title: string; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    dialog.current?.showModal()
    cancel.current?.focus()
  }, [])

  return (
    <dialog ref={dialog} className="shelf-delete-dialog" aria-labelledby="shelf-delete-title" aria-describedby="shelf-delete-description"
      onCancel={(e) => { e.preventDefault(); if (!busy) onCancel() }}>
      <h2 id="shelf-delete-title">{t("Delete book?")}</h2>
      <p className="shelf-delete-name">{title}</p>
      <p id="shelf-delete-description">{t("The EPUB, highlights, inline notes, AI conversations and search data for this book will be permanently deleted. This cannot be undone.")}</p>
      {error && <p className="shelf-delete-error" role="alert">{t(error)}</p>}
      <div className="shelf-delete-actions">
        <button ref={cancel} type="button" className="shelf-delete-cancel" disabled={busy} onClick={onCancel}>{t("Cancel")}</button>
        <button type="button" className="shelf-delete-confirm" disabled={busy} onClick={onConfirm}>{busy ? t("Deleting…") : t("Delete book")}</button>
      </div>
    </dialog>
  )
}

/**
 * Shelf at `/shelf`. Shelf controls stay above the independently scrolling book list.
 * Adding an EPUB still opens sign-in unless this session may import.
 */
export function Shelf({ onOpenCosts }: { onOpenCosts?: () => void }) {
  const { library, current, loading, error, session, openFromLibrary, removeBook, desk } = useReader()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(SHELF_BATCH)
  const [layout, setLayout] = useState<'compact' | 'spacious'>(() => {
    try { return localStorage.getItem(SHELF_LAYOUT_KEY) === 'spacious' ? 'spacious' : 'compact' } catch { return 'compact' }
  })
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const t = useT()
  const indexedBooks = useMemo(() => library.map(book => ({ book, text: searchText(`${book.title || t("Untitled")} ${book.author ?? ''}`) })), [library, t])
  const normalizedQuery = searchText(query)
  const matches = useMemo(() => {
    const terms = normalizedQuery.split(' ').filter(Boolean)
    return indexedBooks.filter(({ text }) => terms.every(term => text.includes(term))).map(({ book }) => book)
  }, [indexedBooks, normalizedQuery])
  const changeQuery = (value: string) => {
    setQuery(value)
    setLimit(SHELF_BATCH)
    listRef.current?.scrollTo({ top: 0 })
  }
  const changeLayout = (value: 'compact' | 'spacious') => {
    setLayout(value)
    try { localStorage.setItem(SHELF_LAYOUT_KEY, value) } catch { /* Keep the choice for this visit. */ }
  }
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null)
  const [infoTarget, setInfoTarget] = useState<{ id: string; owner: string; anchor: HTMLButtonElement } | null>(null)
  const owner = session.status === 'user' ? session.user.id : session.status
  const infoBook = infoTarget?.owner === owner ? library.find(b => b.id === infoTarget.id) : undefined
  if (infoTarget && (infoTarget.owner !== owner || !infoBook)) setInfoTarget(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deletingRef = useRef(false)
  const confirmDelete = async () => {
    if (!deleteTarget || deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    setDeleteError(null)
    try {
      await removeBook(deleteTarget.id)
      setDeleteTarget(null)
    } catch {
      setDeleteError(t("Could not delete this book. Please check your connection and try again."))
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }
  if (current || loading) return null
  const showSamples = (session.status === 'local' || session.status === 'checking') && library.length === 0
  // Opening a sample adds it to the local library; keep the other samples discoverable.
  const unreadSamples = session.status === 'local' ? SHELF_SAMPLES.filter(sample =>
    !library.some(book => book.filename === sample.filename) &&
    normalizedQuery.split(' ').filter(Boolean).every(term => searchText(`${sample.title} ${sample.author} ${t(sample.label)}`).includes(term)),
  ) : []
  const canAdd = session.status === 'user' && canImportBook()
  const pale = DESK_SURFACES.find((s) => s.id === desk)?.pale

  return (
    <div className="shelf" data-ui data-pale={pale ? '' : undefined} data-layout={layout}>
      <ShelfControls onOpenCosts={onOpenCosts} />
      <div
        className="shelf-col"
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (PAGE_KEYS.has(e.key)) e.stopPropagation()
        }}
      >
        <header className="shelf-heading">
          <div>
            <p className="kicker"><a className="shelf-home-link" href={localeUrl('/')} aria-label={t("Infinite Reader home")}>Infinite Reader <span aria-hidden="true">↗</span></a></p>
            <h1>{t("Shelf")}</h1>
          </div>
        </header>
        {!showSamples && <><div className="shelf-browse">
          <form className="shelf-search" role="search" onSubmit={(e) => e.preventDefault()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" />
            </svg>
            <input ref={searchRef} type="search" aria-label={t("Search books by title or author")} placeholder={t("Search title or author")}
              value={query} onChange={(e) => changeQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); changeQuery('') }
              }} />
            {query && <button type="button" aria-label={t("Clear search")} title={t("Clear search")} onClick={() => { changeQuery(''); searchRef.current?.focus() }}><Icon.close size={16} /></button>}
          </form>
          <div className="shelf-layout" role="group" aria-label={t("Book layout")}>
            <button type="button" aria-pressed={layout === 'compact'} onClick={() => changeLayout('compact')}>{t("Compact")}</button>
            <button type="button" aria-pressed={layout === 'spacious'} onClick={() => changeLayout('spacious')}>{t("Spacious")}</button>
          </div>
        </div>
        <div className="shelf-summary">
          <p className="shelf-count" role="status" aria-live="polite" aria-atomic="true">
            {normalizedQuery ? t('{0} of {1} books', matches.length, library.length) : t(library.length === 1 ? '{0} book' : '{0} books', library.length)}
          </p>
          {!canAdd && <p className="note">{t("Sign in to add a book.")}</p>}
        </div>
        </>}
        {error && (
          <div className="error" role="alert">
            {error && t(error)}
          </div>
        )}
        <div ref={listRef} className="shelf-list" role="region" aria-label={t("Books")} tabIndex={0}>
          {showSamples ? <ShelfSamples /> : matches.length ? (
            <ul className="shelf-books">
              {matches.slice(0, limit).map((b) => (
                <ShelfBook
                  key={b.id}
                  title={b.title || t("Untitled")}
                  author={b.author?.trim()}
                  cover={b.coverDataUrl}
                  percent={b.lastPercent}
                  spacious={layout === 'spacious'}
                  onOpen={() => void openFromLibrary(b.id)}
                  onInfo={anchor => setInfoTarget({ id: b.id, owner, anchor })}
                  onDelete={() => { setDeleteError(null); setDeleteTarget({ id: b.id, title: b.title || t("Untitled") }) }}
                />
              ))}
            </ul>
          ) : (
            <div className="shelf-empty">
              <p className="empty">{library.length ? t("No matching books.") : t("Nothing on the shelf yet.")}</p>
              {library.length > 0 && <button type="button" onClick={() => { changeQuery(''); searchRef.current?.focus() }}>{t("Clear search")}</button>}
            </div>
          )}
          {matches.length > limit && <div className="shelf-more">
            <span>{t('Showing {0} of {1}', limit, matches.length)}</span>
            <button type="button" onClick={() => setLimit(value => value + SHELF_BATCH)}>{t("Show more books")}</button>
          </div>}
          {!showSamples && unreadSamples.length > 0 && <ShelfSamples samples={unreadSamples} hasBooks />}
        </div>
      </div>
      {deleteTarget && <DeleteBookDialog title={deleteTarget.title} busy={deleting} error={deleteError}
        onCancel={() => setDeleteTarget(null)} onConfirm={() => void confirmDelete()} />}
      {infoTarget && infoBook && <BookInfoDialog key={`${owner}:${infoBook.id}`} book={infoBook} anchor={infoTarget.anchor}
        cloud={session.status === 'user' && getStorageMode() === 'api'} onClose={() => setInfoTarget(null)} />}
    </div>
  )
}
