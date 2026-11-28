// Local Vite + a fresh browser profile. Optional EPUB_FILE verifies a real book without uploading it.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import JSZip from 'jszip'
const { default: puppeteer } = await import(process.env.PUPPETEER_CORE || 'puppeteer-core')
const zip = new JSZip()
zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>')
zip.file('OEBPS/book.opf', '<package><metadata><title>脚注交互测试</title><language>zh</language></metadata><manifest><item id="earlier" href="earlier.xhtml" media-type="application/xhtml+xml"/><item id="ch" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="earlier"/><itemref idref="ch"/></spine></package>')
const markup = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><h1>阅读中的脚注</h1><p>这是正文中的Token<sup class="footnote-mark"><a href="#fn1">1</a></sup>，点击小标记就可以查看注释，继续在当前书页阅读。</p><p>跨文件注释<a epub:type="noteref" href="notes.xhtml#n%202">[2]</a>。另一个引用<sup><a href="#fn1">1</a></sup>。</p><p>普通链接<a href="#section">章节</a>，数学x<sup>2</sup>，丢失的脚注<sup><a href="#fn99">99</a></sup>，外部链接<a epub:type="noteref" href="https://example.com/#fn1">3</a>，损坏链接<a epub:type="noteref" href="#%zz">4</a>。</p><p>前置文档脚注<a epub:type="noteref" href="earlier.xhtml#earlier">5</a>。</p><p id="section">${'正文内容应当保持完整，已有划线和引用位置不会因脚注弹窗而改变。'.repeat(32)}</p><p class="footnote" id="fn1">1. 这是一段编者注，用来说明正文中的术语。<a role="doc-backlink" href="#reference">↩</a></p><p class="footnote" id="fn77">没有引用的脚注必须保留。</p></body></html>`
zip.file('OEBPS/chapter.xhtml', markup)
zip.file('OEBPS/earlier.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><aside role="doc-footnote" id="earlier"><p>第一段脚注。</p><p>第二段脚注。</p></aside></body></html>')
zip.file('OEBPS/notes.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><body><aside role="doc-footnote" id="n 2"><p>跨文件注释第一段。</p><p>${'这是可滚动的长脚注，不能超出屏幕边界。'.repeat(100)}</p></aside></body></html>`)
const fixture = await zip.generateAsync({type:'base64'})
const baselineZip = new JSZip()
for (const [name, file] of Object.entries(zip.files)) if (!file.dir) baselineZip.file(name, (await file.async('string')).replaceAll('href=', 'data-href='))
// Keep the OPF manifest intact; only remove content links.
baselineZip.file('OEBPS/book.opf', await zip.file('OEBPS/book.opf').async('string'))
const baseline = await baselineZip.generateAsync({type:'base64'})
// Legacy Calibre-style numeric references with verified reciprocal backlinks.
const legacyZip = new JSZip()
legacyZip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
legacyZip.file('book.opf', '<package><metadata><title>Legacy endnotes</title></metadata><manifest><item id="ch" href="text/chapter.html" media-type="application/xhtml+xml"/><item id="other" href="text/other.html" media-type="application/xhtml+xml"/><item id="notes" href="text/notes.html" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/><itemref idref="other"/><itemref idref="notes"/></spine></package>')
legacyZip.file('text/chapter.html', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<p>First<a class="pcalibre note" id="N-1" href="notes.html#F11-1">1</a>.</p>
<p>Second<a class="note" id="N-2" href="notes.html#F11-2">2</a>20th century.</p>
<p>Same file<span class="note"><a id="N-3" href="#F11-3">[3]</a></span>.</p>
<p>Empty anchor<sup><a id="N 4" href="notes.html#F11-4">４</a></sup>.</p>
<p>Multiple paragraphs<a class="note" id="N-12" href="notes.html#F11-12">12</a>.</p>
<p>Separate notes<a class="note" id="N-13" href="notes.html#F11-13">13</a> and <a class="note" id="N-14" href="notes.html#F11-14">14</a>.</p>
<p>Ambiguous container<a class="note" id="N-15" href="notes.html#F11-15">15</a>.</p>
<p>No source ID<a class="note" href="notes.html#F11-1">1</a>.</p>
<p>Ordinary link<a id="N-5" href="notes.html#F11-5">5</a>.</p>
<p>No backlink<a class="note" id="N-6" href="notes.html#F11-6">6</a>.</p>
<p>Non-numeric link<a class="note" id="N-7" href="notes.html#F11-7">Chapter</a>.</p>
<p>Malformed backlink<a class="note" id="N-8" href="notes.html#F11-8">8</a>.</p>
<p>External backlink<a class="note" id="N-9" href="notes.html#F11-9">9</a>.</p>
<p>Wrong source ID<a class="note" id="N-10" href="notes.html#F11-10">10</a>.</p>
<p id="F11-3">Same-file note.<a href="#N-3">↩</a></p>
<p>Semantic source<a epub:type="noteref" id="N-11" href="#footnote11">①</a> must remain visible.</p>
<aside epub:type="footnote" id="footnote11"><p><a epub:type="noteref" href="#N-11">①</a>Circular return must stay in definition.</p></aside>
</body></html>`)
legacyZip.file('text/other.html', '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Repeated source ID in another chapter<a class="note" id="N-1" href="notes.html#F11-1">1</a>.</p></body></html>')
legacyZip.file('text/notes.html', `<html xmlns="http://www.w3.org/1999/xhtml"><body><ol>
<li><p id="F11-1">First endnote.<a href="chapter.html#N-1">↩</a></p></li>
<li><p id="F11-2">Second endnote.<a href="chapter.html#N-2">↩</a></p></li>
<li><p><a id="F11-4"/>Empty-anchor note.<a role="doc-backlink" href="chapter.html#N%204">Return</a></p></li>
<li><p id="F11-12">First paragraph.</p><p>Second paragraph.</p><p>Final paragraph.<a href="chapter.html#N-12">↩</a></p></li>
<li><p id="F11-13">Independent first note.<a href="chapter.html#N-13">↩</a></p><p id="F11-14">Independent second note.<a href="chapter.html#N-14">↩</a></p></li>
<li><p id="F11-15">Ambiguous first note.</p><p id="F11-16">Another anchored note.<a href="chapter.html#N-15">↩</a></p></li>
<li><p id="F11-5">Ordinary target.<a href="chapter.html#N-5">↩</a></p></li>
<li><p id="F11-6">Target without a backlink.</p></li>
<li><p id="F11-7">Non-numeric target.<a href="chapter.html#N-7">↩</a></p></li>
<li><p id="F11-8">Bad backlink.<a href="chapter.html#%zz">↩</a></p></li>
<li><p id="F11-9">External backlink.<a href="https://example.com/text/chapter.html#N-9">↩</a></p></li>
<li><p id="F11-10">Wrong ID.<a href="chapter.html#N-1">↩</a></p></li>
</ol></body></html>`)
const legacyFixture = await legacyZip.generateAsync({type:'base64'})
const legacyBaselineZip = await JSZip.loadAsync(legacyFixture, {base64:true})
for (const [name, file] of Object.entries(legacyBaselineZip.files)) if (name.endsWith('.html')) legacyBaselineZip.file(name, (await file.async('string')).replaceAll('href=', 'data-href='))
const legacyBaseline = await legacyBaselineZip.generateAsync({type:'base64'})
// Duokan/Zhangyue-style references: the label is an image, not a text node.
const imageZip = new JSZip()
imageZip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
imageZip.file('book.opf', '<package><metadata><title>Image footnotes</title><language>en</language></metadata><manifest><item id="ch" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>')
imageZip.file('chapter.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<p>Before<sup><a epub:type="noteref" href="#note"><img src="note.svg" class="epub-footnote" alt="Image note explanation"/></a></sup>After.</p>
<aside epub:type="footnote" id="note"><ol><li>Image note explanation.</li></ol></aside>
<p>Unrelated image<a href="#ordinary"><img src="picture.svg"/></a></p><p id="ordinary">An ordinary destination.</p>
<p>Missing note<a epub:type="noteref" href="#missing"><img src="missing.svg"/></a></p>
<p>段首<a class="footnote" href="#source-a"><img src="mark.svg" alt=""/></a>中间<a class="footnote" href="#source-b"><img src="mark.svg" alt=""/></a>段尾。</p>
<ol class="footnote-content">
  <li class="footnote-item" id="source-a"><p>第一条注释。</p></li>
  <li class="footnote-item" id="source-b"><p>第二条注释。</p></li>
  <li class="footnote-item" id="unused"><p>Unreferenced definition.</p></li>
</ol>
<p>Ordinary target<a class="footnote" href="#ordinary"><img src="figure.svg"/></a>.</p>
<p>Ordinary image link<a href="#unused"><img src="link.svg"/></a>.</p>
<p>Terminal reference<a epub:type="noteref" href="#note"><img src="note.svg"/></a></p>
</body></html>`)
for (const name of ['note.svg', 'picture.svg', 'missing.svg', 'mark.svg', 'figure.svg', 'link.svg']) imageZip.file(name, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="brown"/></svg>')
const imageFixture = await imageZip.generateAsync({type:'base64'})
const browser = await puppeteer.launch({ executablePath:process.env.CHROME_BIN || '/usr/bin/chromium', headless:true, args:['--no-sandbox','--use-angle=swiftshader','--use-gl=angle','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'], defaultViewport:{width:1440,height:900} })
const page = await browser.newPage()
page.setDefaultTimeout(60000)
page.setDefaultNavigationTimeout(120000)
const errors = []
page.on('pageerror', e => errors.push(e.message))
page.on('console', m => { if (m.type() === 'error') console.log('BROWSER', m.text()) })
const check = (value, label) => { assert.ok(value, label); console.log('PASS', label) }
const settle = () => page.evaluate(() => {window.__reader.advance(3);window.__reader.renderNow()})
async function openBook(data, needle = '') {
  await page.evaluate(async data => {
    const blob = new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], {type:'application/epub+zip'})
    await window.__store.getState().openBlob(blob, 'footnotes.epub', undefined, { sample: true })
  }, data)
  const error = await page.evaluate(() => window.__store.getState().error)
  if (error) throw new Error(JSON.stringify(error))
  await page.waitForFunction(() => window.__reader?.hasBook && !window.__store.getState().loading)
  await settle()
  await page.evaluate(needle => {
    const r = window.__reader
    const matches = w => w.footnote && w.footnote.text.includes(needle)
    const p = r.pagination.pages.find(p => p.lines.some(l => l.words.some(matches)))
    const w = p.lines.flatMap(l=>l.words).find(matches)
    window.__targetNoteId = w.footnote.id
    window.__targetPage = p.index
    r.revealLocator({chapter:p.chapter,start:w.s,end:w.e}); r.advance(3);r.renderNow()
  }, needle)
  await page.waitForFunction(() => window.__reader.tex.get(window.__targetPage).image.width > 4)
  await settle()
  await page.waitForSelector('.footnote-hit:not(:disabled)', {visible:true})
}
async function checkHiddenDefinitions() {
  const result = await page.evaluate(() => {
    const { current, scene } = window.__store.getState()
    const definitions = current.parsed.chapters.flatMap(c => c.blocks.filter(b => b.footnoteDefinition).map(b => ({ ...b, chapter: c.index })))
    return {
      count: definitions.length,
      absent: definitions.every(b => !scene.pagination.pages.some(p => p.chapter === b.chapter && p.lines.some(l => l.words.some(w => w.s < b.start + b.text.length && w.e > b.start)))),
      noEmptyChapters: scene.pagination.pages.every(p => p.special || p.lines.length || p.images.length || p.notes?.length),
    }
  })
  check(result.count > 0 && result.absent, 'linked definitions keep source offsets but occupy no page text')
  check(result.noEmptyChapters, 'hiding definitions leaves no empty chapter pages')
}

try {
  await page.goto(process.env.READER_URL || 'http://127.0.0.1:5173/shelf', {waitUntil:'domcontentloaded'})
  await page.waitForFunction(() => window.__store?.getState().session.status === 'local')
  const imageNotes = await page.evaluate(async data => {
    const {parseEpub} = await import('/src/book/epub.ts')
    const {inlineImageFootnotes} = await import('/src/book/imageFootnotes.ts')
    const book = await parseEpub(Uint8Array.from(atob(data), c=>c.charCodeAt(0)).buffer)
    const blocks = book.chapters[0].blocks
    const visible = inlineImageFootnotes(blocks.filter(b=>!b.footnoteDefinition))
    const paragraph = visible.find(b=>b.text.startsWith('段首'))
    return { images: visible.filter(b=>b.img).map(b=>b.img.path), badges: visible.flatMap(b=>b.runs.filter(r=>r.footnote)).length,
      paragraphText: paragraph?.text, paragraphNotes: paragraph?.runs.filter(r=>r.footnote).map(r=>r.footnote.text),
      unreferenced: visible.some(b=>b.text.includes('Unreferenced definition.')),
      definitions: blocks.filter(b=>b.footnoteDefinition).length, joined: visible[0].text,
      terminalEnd: visible.at(-1).start+visible.at(-1).text.length, sourceEnd: book.chapters[0].textLength }
  }, imageFixture)
  check(imageNotes.paragraphText==='段首  中间  段尾。' && imageNotes.paragraphNotes?.join('/')==='第一条注释。/第二条注释。', 'class-marked publisher icons and the following prose share their original paragraph and note targets')
  check(imageNotes.badges===4 && imageNotes.definitions===3 && imageNotes.joined==='Before  After.', 'image references become inline badges and hide their resolved definition')
  check(imageNotes.images.join(',')==='picture.svg,missing.svg,figure.svg,link.svg' && imageNotes.unreferenced, 'ordinary links, illustrations, unresolved references and unreferenced definitions remain visible')
  check(imageNotes.terminalEnd===imageNotes.sourceEnd, 'terminal image reference adds no characters beyond source text')
  const parsed = await page.evaluate(async (data, baseline) => {
    const {parseEpub} = await import('/src/book/epub.ts')
    const decode = data => Uint8Array.from(atob(data), c=>c.charCodeAt(0)).buffer
    const b = await parseEpub(decode(data)), old = await parseEpub(decode(baseline))
    const source = b => b.chapters.map(c=>[c.textLength,c.blocks.map(b=>[b.start,b.text])])
    return { definitions:b.chapters.flatMap(c=>c.blocks.filter(b=>b.footnoteDefinition).map(b=>b.text)), unlinked:b.chapters.flatMap(c=>c.blocks).find(b=>b.text.includes('没有引用的脚注')), notes:b.chapters.flatMap(c=>c.blocks.flatMap(b=>b.runs.filter(r=>r.footnote).map(r=>r.footnote))), stable:JSON.stringify(source(b))===JSON.stringify(source(old)) }
  }, fixture, baseline)
  check(parsed.stable, 'source offsets unchanged when resolving notes')
  check(parsed.notes.length === 4, 'WeRead, shared reference and cross-file note recognized; ordinary, missing, external and malformed links ignored')
  check(parsed.notes[0].text.startsWith('这是一段') && !parsed.notes[0].text.includes('↩'), 'number and backlink removed from popup')
  check(parsed.notes[1].text.includes('第一段。\n'), 'multi-paragraph note outside spine preserved')
  check(parsed.definitions.length === 3 && parsed.definitions.includes('第一段脚注。') && parsed.definitions.includes('第二段脚注。'), 'same-chapter and multi-paragraph definitions in earlier spine documents identified')
  check(!parsed.unlinked.footnoteDefinition, 'unreferenced definitions remain visible')
  const legacy = await page.evaluate(async (data, baseline) => {
    const {parseEpub} = await import('/src/book/epub.ts')
    const decode = data => Uint8Array.from(atob(data), c => c.charCodeAt(0)).buffer
    const book = await parseEpub(decode(data)), old = await parseEpub(decode(baseline))
    const source = b => b.chapters.map(c => [c.textLength, c.blocks.map(b => [b.start, b.text])])
    return { stable: JSON.stringify(source(book)) === JSON.stringify(source(old)), mainVisible: !book.chapters[0].blocks.find(b => b.text.startsWith('Semantic source')).footnoteDefinition, definitionHidden: !!book.chapters[0].blocks.find(b => b.text.includes('Circular return')).footnoteDefinition, multiBlocks: book.chapters.flatMap(c => c.blocks.filter(b => b.footnoteDefinition === 'text/notes.html#F11-12')).length, notes: book.chapters.flatMap(c => c.blocks.flatMap(b => b.runs.filter(r => r.footnote).map(r => ({label:r.text,...r.footnote})))) }
  }, legacyFixture, legacyBaseline)
  check(legacy.stable, 'legacy endnotes preserve every source offset and numeric label')
  check(legacy.notes.length === 8 && legacy.notes[0].id === 'text/notes.html#F11-1' && legacy.notes[1].id === 'text/notes.html#F11-2', 'legacy numbered links resolve across files without EPUB semantic types')
  check(legacy.notes[2].text === 'Same-file note.' && legacy.notes[3].text === 'Empty-anchor note.', 'same-file and empty-anchor notes resolve with clean backlink-free text')
  check(legacy.notes.every(n => ['1','2','[3]','４','①','12','13','14'].includes(n.label)), 'ordinary links, non-numeric links and invalid or mismatched backlinks remain text')
  check(legacy.mainVisible && legacy.definitionHidden, 'mislabeled numbered backlinks do not become references or hide the original paragraph')
  const multi = legacy.notes.find(n => n.id === 'text/notes.html#F11-12')
  check(multi.text.includes('First paragraph.\n') && multi.text.includes('Second paragraph.\n') && multi.text.endsWith('Final paragraph.') && legacy.multiBlocks === 3, 'multi-paragraph endnotes include every paragraph and hide all definition blocks together')
  check(legacy.notes.find(n => n.id.endsWith('#F11-13')).text === 'Independent first note.' && legacy.notes.find(n => n.id.endsWith('#F11-14')).text === 'Independent second note.' && !legacy.notes.some(n => n.id.endsWith('#F11-15')), 'list-item expansion never absorbs a separately anchored note')
  await openBook(fixture)
  await checkHiddenDefinitions()
  const before = await page.evaluate(() => {window.__originalPag=window.__reader.pagination; return window.__reader.turnedLeaves})
  await page.click('.footnote-hit:not(:disabled)')
  await page.waitForSelector('.footnote-popover')
  check(await page.$eval('.footnote-content',e=>e.textContent.startsWith('这是一段')), 'click opens correct footnote')
  check(await page.evaluate(() => window.__reader.pagination === window.__originalPag && !window.__store.getState().popover && !window.__store.getState().editingNote), 'no repagination, highlight toolbar or note editor')
  check(await page.evaluate(()=>window.__reader.turnedLeaves) === before, 'opening footnote does not turn page')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.footnote-popover',{hidden:true})
  check(await page.evaluate(()=>document.activeElement.classList.contains('footnote-hit')), 'Escape closes and restores focus')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.footnote-popover')
  await page.mouse.click(10,10)
  await page.waitForSelector('.footnote-popover',{hidden:true})
  console.log('PASS keyboard activation and outside dismissal')
  await page.click('.footnote-hit[data-footnote-id*="notes.xhtml"]')
  await page.waitForSelector('.footnote-popover')
  check(await page.$eval('.footnote-content', e=>e.scrollHeight>e.clientHeight), 'long notes scroll')
  await page.setViewport({width:390,height:844})
  await settle()
  await page.waitForFunction(()=>{ const el=document.querySelector('.footnote-popover'); if(!el)return false; const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight })
  console.log('PASS popup fits narrow viewport')
  await page.keyboard.press('Escape')
  await page.setViewport({width:1440,height:900})
  await openBook(imageFixture, 'Image note explanation')
  await page.click('.footnote-hit:not(:disabled)')
  await page.waitForSelector('.footnote-popover')
  check(await page.$eval('.footnote-content', e=>e.textContent)==='Image note explanation.', 'image reference opens its exact note content')
  await page.keyboard.press('Escape')
  await openBook(imageFixture, '第二条注释。')
  await page.click('.footnote-hit[data-footnote-id="chapter.xhtml#source-b"]:not(:disabled)')
  await page.waitForSelector('.footnote-popover')
  check(await page.$eval('.footnote-content', e=>e.textContent)==='第二条注释。', 'publisher image reference opens its own note')
  await page.keyboard.press('Escape')
  if (process.env.EPUB_FILE) {
    const bytes = await fs.readFile(process.env.EPUB_FILE)
    const originalZip = await JSZip.loadAsync(bytes)
    for (const [name, file] of Object.entries(originalZip.files)) if (/\.x?html$/.test(name)) originalZip.file(name, (await file.async('string')).replace(/(<a\b[^>]*?)\bhref=/gi, '$1data-href='))
    const unlinked = await originalZip.generateAsync({type:'base64'})
    check(await page.evaluate(async (data, old) => {
      const {parseEpub} = await import('/src/book/epub.ts')
      const decode = data => Uint8Array.from(atob(data), c=>c.charCodeAt(0)).buffer
      const source = b => b.chapters.map(c=>[c.textLength,c.blocks.map(b=>[b.start,b.text])])
      return JSON.stringify(source(await parseEpub(decode(data)))) === JSON.stringify(source(await parseEpub(decode(old))))
    }, bytes.toString('base64'), unlinked), 'all real-book chapter text and offsets preserved')
    await openBook(bytes.toString('base64'), process.env.NOTE_TEXT || '')
    await checkHiddenDefinitions()
    const id = await page.evaluate(() => window.__targetNoteId)
    await page.click(`.footnote-hit[data-footnote-id=${JSON.stringify(id)}]:not(:disabled)`)
    await page.waitForSelector('.footnote-popover')
    check((await page.$eval('.footnote-content', e=>e.textContent)).length>10, 'real imported book displays footnote content')
  }
  for (const id of (process.env.NOTE_IDS || '').split(',').filter(Boolean)) {
    await page.keyboard.press('Escape')
    const expected = await page.evaluate(id => {
      const r = window.__reader
      const p = r.pagination.pages.find(p => p.lines.some(l => l.words.some(w => w.footnote?.id === id)))
      if (!p) throw new Error('Missing rendered footnote: ' + id)
      const word = p.lines.flatMap(l => l.words).find(w => w.footnote?.id === id)
      window.__targetPage = p.index
      r.revealLocator({chapter:p.chapter,start:word.s,end:word.e}); r.advance(3); r.renderNow()
      return word.footnote.text
    }, id)
    await page.waitForFunction(() => window.__reader.tex.get(window.__targetPage).image.width > 4)
    await settle()
    const selector = `.footnote-hit[data-footnote-id=${JSON.stringify(id)}]:not(:disabled)`
    await page.waitForSelector(selector, {visible:true}); await page.click(selector)
    await page.waitForSelector('.footnote-popover')
    check(await page.$eval('.footnote-content', el => el.textContent) === expected, `real-book badge opens exact note: ${id}`)
  }
  await fs.mkdir(process.env.SCREENSHOT_DIR || '/tmp/footnote-screenshots', {recursive:true})
  await page.screenshot({path:`${process.env.SCREENSHOT_DIR || '/tmp/footnote-screenshots'}/footnote.png`})
  await page.evaluate(() => {window.__reader.turn(1);window.__reader.advance(3);window.__reader.renderNow()})
  await page.waitForSelector('.footnote-popover', {hidden:true})
  console.log('PASS turning the page dismisses the popup')
  check(errors.length===0, `no browser errors: ${errors.join('; ')}`)
} finally { await browser.close() }
