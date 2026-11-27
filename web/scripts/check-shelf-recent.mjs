// Run against VITE_BACKEND=api. The shelf leads with the most recently read book:
// opening a book records a read time even before the first page turn, and spacious
// cards show each started book's percentage as a ring.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const {default: puppeteer} = await import(process.env.PUPPETEER_CORE || 'puppeteer-core')
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader'],
    defaultViewport: {width: 1280, height: 900}
})
const page = await browser.newPage(), errors = []
page.on('pageerror', e => errors.push(e.message))
// Keep interface assertions independent of the browser's own language.
await page.evaluateOnNewDocument(() => {
    try {
        localStorage.setItem('ir:locale', 'en')
    } catch { /* Storage may be disabled. */
    }
})
const epub = await fs.readFile(new URL('../public/samples/zh-sample.epub', import.meta.url))
const user = {id: 'recent-user', email: 'recent@example.com', name: 'Reader', avatar_url: null}
const now = Date.now()
const books = [
    {
        id: 'recent-older',
        title: 'Older read',
        author: 'A',
        language: 'zh-CN',
        filename: 'older.epub',
        sizeBytes: epub.length,
        hasCover: false,
        status: 'ready',
        chapterCount: 3,
        chunkCount: 10,
        indexedChunks: 10,
        createdAt: now - 3000,
        progress: {percent: 40, location: {leaf: 4}, updatedAt: now - 2000}
    },
    {
        id: 'recent-newer',
        title: 'Recent read',
        author: 'B',
        language: 'zh-CN',
        filename: 'newer.epub',
        sizeBytes: epub.length,
        hasCover: false,
        status: 'ready',
        chapterCount: 3,
        chunkCount: 10,
        indexedChunks: 10,
        createdAt: now - 2000,
        progress: {percent: 20, location: {leaf: 2}, updatedAt: now - 1000}
    },
    {
        id: 'recent-unread',
        title: 'Never opened',
        author: 'C',
        language: 'zh-CN',
        filename: 'unread.epub',
        sizeBytes: epub.length,
        hasCover: false,
        status: 'ready',
        chapterCount: 3,
        chunkCount: 10,
        indexedChunks: 10,
        createdAt: now - 1000,
        progress: null
    },
]
let progressWrites = 0
await page.setRequestInterception(true)
page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return void request.continue()
    const json = (body, status = 200) => request.respond({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body)
    })
    if (path === '/api/auth/me') return void json({user})
    if (path === '/api/auth/providers') return void json({email: true, google: false})
    if (path === '/api/books') return void json({books})
    const progress = /^\/api\/books\/([^/]+)\/progress$/.exec(path)
    if (progress && request.method() === 'PUT') {
        const book = books.find(b => b.id === progress[1])
        const body = JSON.parse(request.postData() || '{}')
        if (book) book.progress = {...body, updatedAt: Date.now()}
        progressWrites++
        return void json({ok: true})
    }
    if (path.endsWith('/file')) return void request.respond({
        status: 200,
        contentType: 'application/epub+zip',
        body: epub
    })
    if (path.endsWith('/annotations')) return void json({annotations: []})
    if (path.endsWith('/notes')) return void json({notes: []})
    if (path.endsWith('/chat')) return void json({messages: [], pending: null})
    void json({ok: true})
})
const check = (ok, label) => {
    assert.ok(ok, label);
    console.log('PASS', label)
}
const shelf = () => page.waitForSelector('.shelf-book-open')
const titles = () => page.$$eval('.shelf-books .title', nodes => nodes.map(n => n.textContent))
const rings = () => page.$$eval('.shelf-books li', nodes => nodes.map(n => n.querySelector('.shelf-progress')?.textContent?.trim() ?? null))
const openNth = async (index) => {
    await page.click(`.shelf-books li:nth-child(${index}) .shelf-book-open`)
    await page.waitForFunction(() => window.__store.getState().current && !window.__store.getState().loading, {timeout: 120000})
    await page.evaluate(() => window.__store.getState().returnToShelf())
    await shelf()
}
try {
    await page.goto(process.env.READER_URL || 'http://127.0.0.1:5175/shelf', {waitUntil: 'domcontentloaded'})
    await shelf()
    check(JSON.stringify(await titles()) === JSON.stringify(['Recent read', 'Older read', 'Never opened']),
        'the most recently read book leads; never-opened books follow by newest addition')
    await page.click('.shelf-layout button:nth-child(2)')
    await page.waitForSelector('.shelf[data-layout="spacious"] .shelf-book-action')
    check(JSON.stringify(await rings()) === JSON.stringify(['20%', '40%', null]),
        'spacious cards show a progress ring and percentage for read books only')
    const actions = await page.$$eval('.shelf-book-action', nodes => nodes.map(n => n.textContent ?? ''))
    check(actions[0].includes('Continue reading') && actions[2].includes('Start reading'),
        'started books offer Continue reading while unread books still start')
    await openNth(2)
    check((await titles())[0] === 'Older read', 'opening a book moves it to the front without a page turn')
    check(/^\d+%$/.test((await rings())[0] ?? ''), 'opening a book shows its restored percentage')
    await new Promise(resolve => setTimeout(resolve, 1200))
    check(progressWrites > 0, 'opening persists reading progress')
    await page.reload({waitUntil: 'domcontentloaded'})
    await shelf()
    check(JSON.stringify(await titles()) === JSON.stringify(['Older read', 'Recent read', 'Never opened']),
        'the order survives a reload through the cloud read time')
    const persisted = await rings()
    check(/^\d+%$/.test(persisted[0] ?? '') && persisted[1] === '20%' && persisted[2] === null,
        'progress percentages survive a reload through the cloud progress')
    check(!errors.length, `no browser errors: ${errors.join('; ')}`)
} finally {
    await browser.close()
}
