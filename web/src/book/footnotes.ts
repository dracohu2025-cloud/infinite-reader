import type { Footnote } from './types'

const typeOf = (el: Element) => `${el.getAttribute('epub:type') || el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || ''} ${el.getAttribute('role') || ''}`.split(/\s+/)
const hasType = (el: Element, names: string[]) => typeOf(el).some(t => names.includes(t))
const noteClass = (el: Element) => /(?:^|\s)(?:footnote|endnote)(?:\s|$)/i.test(el.getAttribute('class') || '')
const isBacklink = (el: Element) => hasType(el, ['backlink', 'doc-backlink']) || /^[↩↵↑←]+$/.test(el.textContent?.trim() || '')

/** Some publishers mark numbered return links as noteref too. Follow the other
 * anchor back once: if it points to our containing definition, this is the return. */
function isDefinitionBacklink(a: Element, target: Element, doc: Document, path: string, targetPath: string, resolvePath: (base: string, href: string) => string) {
  if (target.localName !== 'a') return false
  if (!hasType(target, ['noteref', 'doc-noteref']) && !target.closest('sup, .note, .footnote-mark, .noteref')) return false
  const href = target.getAttribute('href') || '', hash = href.indexOf('#')
  if (hash < 0 || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return false
  try {
    if ((hash === 0 ? targetPath : resolvePath(targetPath, href)) !== path) return false
    const definition = doc.getElementById(decodeURIComponent(href.slice(hash + 1)))
    return !!definition && definition !== a && definition.contains(a)
  } catch { return false }
}

/** EPUB 2 endnotes often use .note links and reciprocal arrows, without semantic roles. */
function isLinkedEndnote(a: Element, body: Element, path: string, targetPath: string, resolvePath: (base: string, href: string) => string) {
  const sourceId = a.getAttribute('id')
  const label = (a.textContent || '').trim().normalize('NFKC')
  if (!sourceId || !/^(?:\d+|\[\d+\]|\(\d+\)|【\d+】)$/.test(label) || !a.closest('sup, .note, .footnote-mark, .noteref')) return false
  return Array.from(body.querySelectorAll('a')).some(link => {
    if (!isBacklink(link)) return false
    const href = link.getAttribute('href') || '', hash = href.indexOf('#')
    if (hash < 0 || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return false
    try {
      const sourcePath = hash === 0 ? targetPath : resolvePath(targetPath, href)
      // IDs such as N-1 can repeat in every chapter; check the document as well.
      return sourcePath === path && decodeURIComponent(href.slice(hash + 1)) === sourceId
    } catch { return false }
  })
}

/** Resolve only local, identifiable notes. Ordinary links and missing targets remain text. */
export async function resolveFootnotes(doc: Document, path: string, resolvePath: (base: string, href: string) => string, readDocument: (path: string) => Promise<Document | null>, definitions?: WeakMap<Element, string>): Promise<WeakMap<Element, Footnote>> {
  const notes = new WeakMap<Element, Footnote>()
  for (const a of Array.from(doc.getElementsByTagNameNS('*', 'a'))) {
    const href = a.getAttribute('href') || ''
    const hash = href.indexOf('#')
    if (hash < 0 || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue
    let targetPath: string, id: string
    try {
      targetPath = hash === 0 ? path : resolvePath(path, href)
      id = decodeURIComponent(href.slice(hash + 1))
    } catch { continue }
    if (!id || isBacklink(a)) continue
    const targetDoc = targetPath === path ? doc : await readDocument(targetPath)
    const target = targetDoc?.getElementById(id)
    if (!target || target === a || target.contains(a)) continue
    if (isDefinitionBacklink(a, target, doc, path, targetPath, resolvePath)) continue
    const semantic = hasType(a, ['noteref', 'doc-noteref']) || hasType(target, ['footnote', 'endnote', 'doc-footnote', 'doc-endnote'])
    const marked = a.closest('sup, .footnote-mark, .noteref') && (noteClass(target) || /^f(?:oot)?n\d/i.test(id))
    // Some EPUBs mark only the image link and its matching list item with classes.
    const imageNote = noteClass(a) && target.matches('li.footnote-item, li.endnote-item')
      && !a.textContent?.trim() && a.querySelectorAll('img, image').length === 1
    // Some EPUB 2 books put the ID on an empty anchor inside the note paragraph.
    let body = target.localName === 'a' && target.parentElement && /^(p|li|aside)$/i.test(target.parentElement.localName) ? target.parentElement : target
    // Numbered endnotes may span several paragraphs, with the return link in the
    // last one. Stay within one list item and never absorb another anchored note.
    const item = body.parentElement
    if (item?.localName === 'li' && item.firstElementChild === body && !item.querySelector('li') &&
      !Array.from(item.querySelectorAll('[id]')).some(el => !body.contains(el)) &&
      isLinkedEndnote(a, item, path, targetPath, resolvePath)) body = item
    if (!semantic && !marked && !imageNote && !isLinkedEndnote(a, body, path, targetPath, resolvePath)) continue
    const clone = body.cloneNode(true) as Element
    for (const link of Array.from(clone.querySelectorAll('a'))) {
      if (isBacklink(link)) link.remove()
    }
    for (const unsafe of Array.from(clone.querySelectorAll('script, style'))) unsafe.remove()
    for (const br of Array.from(clone.querySelectorAll('br'))) br.replaceWith('\n')
    for (const p of Array.from(clone.querySelectorAll('p, li, div'))) p.append('\n')
    let text = (clone.textContent || '').replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    const label = a.textContent?.trim() || ''
    if (/^\d+$/.test(label)) text = text.replace(new RegExp(`^\\s*(?:\\[${label}\\]|${label}[.、．])\\s*`), '')
    if (text) {
      const key = `${targetPath}#${id}`
      notes.set(a, { id: key, text })
      // Plain-text popups cannot replace illustrations or tables in a definition.
      if (!body.querySelector('img, image, svg, table')) definitions?.set(body, key)
    }
  }
  return notes
}
