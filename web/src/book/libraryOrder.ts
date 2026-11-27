import type {BookMeta} from './types'

/**
 * Shelf order: most recently read first, never-opened books after them by newest
 * addition. Opening a book counts as reading, so a touched book needs no page turn
 * to lead the shelf.
 */
export function orderLibrary(books: BookMeta[]): BookMeta[] {
    return [...books].sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0) || b.addedAt - a.addedAt)
}

/** Bring a just-read book forward without waiting for the next library refresh. */
export function touchLibrary(books: BookMeta[], id: string, at: number): BookMeta[] {
    return orderLibrary(books.map((book) => (book.id === id ? {
        ...book,
        lastReadAt: Math.max(book.lastReadAt ?? 0, at)
    } : book)))
}

/**
 * Keep read times recorded in this session when a refresh returns older server
 * progress (its PUT is debounced). Values only move forward.
 */
export function mergeReadTimes(books: BookMeta[], sessionReadAt: ReadonlyMap<string, number>): BookMeta[] {
    return books.map((book) => {
        const at = sessionReadAt.get(book.id)
        return at !== undefined && at > (book.lastReadAt ?? 0) ? {...book, lastReadAt: at} : book
    })
}
