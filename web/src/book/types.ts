export interface Footnote {
  id: string
  text: string
}

export interface TextRun {
  footnote?: Footnote
  text: string
  /** Visual hard breaks, measured in this run; excluded from chapter text. */
  breaks?: number[]
  bold?: boolean
  italic?: boolean
  sup?: boolean
  mono?: boolean
  smallcaps?: boolean
}

export type BlockKind = 'p' | 'h1' | 'h2' | 'h3' | 'quote' | 'li' | 'pre' | 'img' | 'hr'
export type Align = 'left' | 'center' | 'right' | 'justify'

export interface LiteraryStyle {
  role: 'quote' | 'epigraph' | 'verse' | 'attribution'
  group: number
  first?: boolean
  last?: boolean
}

export interface Block {
  /** Presentation role on a standalone chapter title page; source text stays intact. */
  chapterHeading?: 'number' | 'title'
  /** Source paragraph identity; images can split one paragraph into several blocks. */
  flowId?: number
  /** A resolved popup owns this definition; retain its source offsets but omit it from normal layout. */
  footnoteDefinition?: string
  kind: BlockKind
  runs: TextRun[]
  /** Plain text of the block; chapter text is blocks joined by "\n". */
  text: string
  /** Offset of this block's first character inside the chapter text. */
  start: number
  align?: Align
  noIndent?: boolean
  literary?: LiteraryStyle
  marker?: string
  img?: { path: string; alt: string; footnote?: Footnote }
  ids?: string[]
}

export interface Chapter {
  index: number
  href: string
  title: string
  blocks: Block[]
  textLength: number
}

export interface TocItem {
  /** Archive-relative navigation target, including fragment, for server-side section extraction. */
  href?: string
  title: string
  chapter: number
  /** Optional block index inside the chapter for fragment links. */
  block?: number
  level: number
}

export interface BookMeta {
  id: string
  title: string
  author: string
  language: string
  addedAt: number
  coverDataUrl?: string
  lastLeaf?: number
  lastPercent?: number
  filename?: string
  /** Last reading activity (opened or turned); drives the shelf order. */
  lastReadAt?: number
  /** backend indexing state; absent for local books */
  status?: 'uploaded' | 'parsing' | 'indexing' | 'ready' | 'failed' | 'deleting'
  indexPercent?: number
  size?: number
}

export interface ParsedBook {
  meta: Omit<BookMeta, 'id' | 'addedAt'>
  chapters: Chapter[]
  toc: TocItem[]
  cover?: Blob
  getImage(path: string): Promise<Blob | null>
}
