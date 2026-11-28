import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, buildEpub, makeEnv, mockFetch, resetDb } from './helpers';
import * as geo from '../src/atlas/textGazetteer';
import manifest from '../src/atlas/data/text-gazetteer.json';
import anyangFixtureRaw from './fixtures/anyang-geonames.json';
import kaifengFixtureRaw from './fixtures/kaifeng-geonames.json';
import hanFixtureRaw from './fixtures/han-geonames.json';
import { atlasPrefix } from '../src/atlas/cache';
import { textMapExtent } from '../src/atlas/textRecognition';
import { gzipSync, strToU8 } from 'fflate';
import { sha256Hex } from '../src/lib/util';
import { excludeTextPlaces, mergeTextMaps, type TextAtlasResult } from '../../shared/textAtlas';

beforeEach(resetDb);
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; vi.restoreAllMocks(); });
const pass: geo.GeoRecord = ['1798648', '平型关', 113.93333, 39.33333, 'T', 'PASS', '24', '', 'CN', []];
const village: geo.GeoRecord = ['1798647', '平型关', 113.90339, 39.30786, 'P', 'PPL', '24', '', 'CN', []];
const query: geo.PlaceQuery = { name: '平型关', aliases: [], kind: 'pass', country: 'CN' };
const wutai: geo.GeoRecord = ['1790956', 'Wutaishan', 113.56261, 39.08262, 'T', 'MTS', '24', '', 'CN', []];
const qinghaiWutai: geo.GeoRecord = ['7407572', 'Wutai Shan', 102.72633, 35.67621, 'T', 'MT', '06', '6302', 'CN', []];
const shanxi: geo.GeoRecord = ['1795912', 'Shanxi', 112.25, 37.66667, 'A', 'ADM1', '24', '', 'CN', []];
// Actual CN:邯郸 rows from the published, hash-verified GeoNames pack.
const handanRows: geo.GeoRecord[] = [
  ['1808960', 'Hanshan Qu', 114.53333, 36.55, 'A', 'ADM3', '10', '1304', 'CN', [['zh', false, '', '']]],
  ['1808961', 'Handan Shi', 114.55, 36.56667, 'A', 'ADM2', '10', '1304', 'CN', [['zh', false, '', '']]],
  ['1808963', 'Handan', 114.48764, 36.60999, 'P', 'PPLA2', '10', '1304', 'CN', [['zh', false, '', '']]],
  ['1812147', 'Hanshan', 114.53333, 36.56667, 'P', 'PPLA3', '10', '1304', 'CN', [['zh', false, '', '']]],
];
// Actual CN:安阳/anyang/安阳市 rows from the hash-verified published packs.
const kaifengRows = kaifengFixtureRaw as unknown as Record<string, geo.GeoRecord[]>;
const anyangRows = anyangFixtureRaw as unknown as Record<string, geo.GeoRecord[]>;
// GeoNames records and alias metadata from the same source snapshot as the published index.
const hanRows = hanFixtureRaw as unknown as Record<string, geo.GeoRecord[]>;
const lookupHan = async (name: string, country: string) => hanRows[`${country}:${geo.normalizePlace(name)}`] ?? [];
const hanoi: geo.PlaceQuery = { name: '河内', aliases: [], kind: 'city', country: 'VN' };
// Actual US:夏威夷州 / US:hawaii / US:hawaiianislands / UM:midway / JP:冲绳县 rows from the published GeoNames packs.
const hawaiiIndex: Record<string, geo.GeoRecord[]> = {
  'US:夏威夷州': [['5855797', 'Hawaii', -156.38612, 20.78785, 'A', 'ADM1', 'HI', '', 'US', [['zh', false, '', '']]]],
  'US:hawaii': [
    ['5853336', 'Puʻumakani', -156.88603, 20.77798, 'T', 'MT', 'HI', '009', 'US', []],
    ['5855765', 'Hawaii County', -155.52289, 19.6024, 'A', 'ADM2', 'HI', '001', 'US', [['en', false, '', '']]],
    ['5855797', 'Hawaii', -156.38612, 20.78785, 'A', 'ADM1', 'HI', '', 'US', [['en', false, '', '']]],
    ['5855799', 'Island of Hawai‘i', -155.66494, 19.54814, 'T', 'ISL', 'HI', '001', 'US', [['de', false, '', '']]],
    ['6463769', 'hawaii', -80.1198, 25.8602, 'S', 'HTL', 'FL', '', 'US', []],
  ],
  'US:hawaiianislands': [['5855811', 'Hawaiian Islands', -157.00974, 21.13446, 'T', 'ISLS', 'HI', '009', 'US', [['en', false, '', '']]]],
};
const lookupHawaii = async (name: string, country: string) => hawaiiIndex[`${country}:${geo.normalizePlace(name)}`] ?? [];
const answer = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: '平型关', period: '', region: '', places: [query] }) } }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
async function setup() {
  const te = makeEnv(), client = new Client(te);
  const { user } = await client.login();
  const form = new FormData(); form.set('file', new File([buildEpub()], 'atlas.epub'));
  const { book } = await (await client.fetch('/api/books', { method: 'POST', body: form })).json() as any;
  await env.BOOKS.put(manifest.key, 'fixture');
  vi.spyOn(geo, 'gazetteerLookup').mockReturnValue(async () => [pass, village]);
  const endpoint = `/api/books/${book.id}/text-atlas`;
  const request = (json: unknown = { text: '平型关位于晋北。', confirmed: true }) => client.fetch(endpoint, { method: 'POST', json });
  return { te, client, user, book, endpoint, request };
}

describe('confirmed text maps', () => {
  it('initializes the revised daily quota from actual usage instead of rejected legacy requests', async () => {
    const { request, user } = await setup(); let calls = 0;
    const day = Math.floor(Date.now() / 86400_000) * 86400_000;
    await env.DB.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 38)').bind(`text-atlas:daily:${user.id}`, day).run();
    await env.DB.batch(Array.from({ length: 30 }, (_, i) => env.DB.prepare(
      "INSERT INTO ai_usage (id, operation_id, user_id, feature, provider, requested_model, status, started_at) VALUES (?, ?, ?, 'text_atlas', 'deepseek', 'fixture', 'succeeded', ?)",
    ).bind(`prior-${i}`, `prior-${i}`, user.id, day + 1)));
    restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return answer(); } }).restore;
    expect((await request()).status).toBe(200);
    expect(await (await request()).json()).toMatchObject({ cached: true });
    expect(calls).toBe(1);
    expect(await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(`text-atlas:daily:v2:${user.id}`).first()).toEqual({ count: 31 });
  });

  it('reports a daily quota separately, preserves cached maps, and allows manual retry after reset', async () => {
    const { request, user, book } = await setup(); let calls = 0;
    restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return answer(); } }).restore;
    await request();
    const key = `text-atlas:daily:v2:${user.id}`;
    await env.DB.prepare('UPDATE rate_limits SET count = 120 WHERE key = ?').bind(key).run();
    expect(await (await request()).json()).toMatchObject({ cached: true });
    for (let i = 0; i < 2; i++) {
      const response = await request({ text: '平型关新的段落', confirmed: true });
      expect(response.status).toBe(429);
      const body = await response.json() as any;
      expect(body.error.code).toBe('text_atlas_daily_limit');
      expect(body.error.limit).toBe(120);
      expect(body.error.resetAt).toBeGreaterThan(Date.now());
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect(calls).toBe(1);
    expect(await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first()).toEqual({ count: 120 });
    const jobs = await env.BOOKS.list({ prefix: `${atlasPrefix(user.id, book.id)}text/` });
    const statuses = await Promise.all(jobs.objects.map(async o => (await (await env.BOOKS.get(o.key))!.json<any>()).status));
    expect(statuses.sort()).toEqual(['rate_limited', 'ready']);
    await env.DB.prepare('UPDATE rate_limits SET count = 119 WHERE key = ?').bind(key).run();
    // No special retry flag is needed after a quota rejection; no model was attempted.
    expect((await request({ text: '平型关新的段落', confirmed: true })).status).toBe(200);
    expect(calls).toBe(2);
  });

  it('limits new inference bursts without charging the daily allowance or blocking cached maps', async () => {
    const { request, user } = await setup(); let calls = 0;
    restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return answer(); } }).restore;
    await request();
    await env.DB.prepare('UPDATE rate_limits SET count = 6 WHERE key = ?').bind(`text-atlas:infer:${user.id}`).run();
    const blocked = await request({ text: '另一个平型关段落', confirmed: true });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: { code: 'text_atlas_minute_limit' } });
    expect(Number(blocked.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect(await (await request()).json()).toMatchObject({ cached: true });
    expect(calls).toBe(1);
    expect(await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(`text-atlas:daily:v2:${user.id}`).first()).toEqual({ count: 1 });
  });

  it('atomically admits only one of two different passages competing for the last daily slot', async () => {
    const { request, user } = await setup(); let calls = 0;
    const day = Math.floor(Date.now() / 86400_000) * 86400_000;
    await env.DB.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 119)').bind(`text-atlas:daily:v2:${user.id}`, day).run();
    restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return answer(); } }).restore;
    const responses = await Promise.all(['平型关第一段', '平型关第二段'].map(text => request({ text, confirmed: true })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 429]);
    expect(calls).toBe(1);
    expect(await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(`text-atlas:daily:v2:${user.id}`).first()).toEqual({ count: 120 });
  });

  it('requires ownership and a second confirmation to remove a place from this book only', async () => {
    const { request, client, te, book, user } = await setup(); let calls = 0;
    restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return answer(); } }).restore;
    const first = await (await request()).json() as TextAtlasResult;
    await request({ text: '再次提到平型关。', confirmed: true });
    await env.BOOKS.put(`${atlasPrefix(user.id, book.id)}content/image.json`, JSON.stringify({ result: {
      status: 'recognized', map: { ...first.map, image: { sha256: 'a'.repeat(64), bytes: 100 } }, recognizedAt: 1,
    } }));
    const endpoint = `/api/books/${book.id}/text-atlas/places/geonames%3A1798648`;
    const remove = (json: unknown = { confirmed: true }) => client.fetch(endpoint, { method: 'DELETE', json });
    expect((await remove({})).status).toBe(400);
    expect((await remove({ confirmed: false })).status).toBe(400);
    expect((await new Client(te).fetch(endpoint, { method: 'DELETE', json: { confirmed: true } })).status).toBe(401);
    const other = new Client(te); await other.login('delete-other@example.com');
    expect((await other.fetch(endpoint, { method: 'DELETE', json: { confirmed: true } })).status).toBe(404);
    expect((await client.fetch(`/api/books/${book.id}/text-atlas/places/bad-id`, { method: 'DELETE', json: { confirmed: true } })).status).toBe(400);
    expect((await remove()).status).toBe(200);
    expect((await remove()).status).toBe(200);
    const page = await (await client.fetch(`/api/books/${book.id}/atlas`)).json() as any;
    expect(page.excludedPlaceIds).toEqual(['geonames:1798648']);
    expect(page.maps[0].map.places[0].id).toBe('geonames:1798648');
    expect(page.textMaps).toHaveLength(2);
    expect(page.textMaps.every((r: TextAtlasResult) => r.map === null)).toBe(true);
    expect(mergeTextMaps([first, ...page.textMaps])).toBeNull();
    expect(await (await request()).json()).toMatchObject({ cached: true, map: null, excludedPlaceIds: ['geonames:1798648'] });
    expect(calls).toBe(2);
    // Other books are unaffected; deleting the book also removes its exclusion markers.
    const form = new FormData(); form.set('file', new File([buildEpub()], 'other.epub'));
    const { book: otherBook } = await (await client.fetch('/api/books', { method: 'POST', body: form })).json() as any;
    expect(await (await client.fetch(`/api/books/${otherBook.id}/atlas`)).json()).toMatchObject({ excludedPlaceIds: [] });
    await client.fetch(`/api/books/${book.id}`, { method: 'DELETE' });
    expect((await env.BOOKS.list({ prefix: atlasPrefix(user.id, book.id) })).objects).toHaveLength(0);
  });

  it('does not resurrect a removed place when an in-flight recognition finishes', async () => {
    const { request, client, book } = await setup(); let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { started = r; });
    restore = mockFetch({ 'https://llm.test/chat/completions': async () => { started(); await gate; return answer(); } }).restore;
    const pending = request(); await ready;
    expect((await client.fetch(`/api/books/${book.id}/text-atlas/places/geonames%3A1798648`, { method: 'DELETE', json: { confirmed: true } })).status).toBe(200);
    release();
    expect(await (await pending).json()).toMatchObject({ status: 'ready', map: null, excludedPlaceIds: ['geonames:1798648'] });
    expect(await (await request()).json()).toMatchObject({ cached: true, map: null });
  });

  it('filters IDs rather than names and recomputes extents without mutating recognition caches', () => {
    const p = (id: string, x: number) => ({ id, name: '同名', modernName: 'Place', coordinates: [x, 30] as [number, number], imagePoint: null, source: 'GeoNames' as const, sourceUrl: '', featureCode: 'PPL' });
    const result: TextAtlasResult = { status: 'ready', cached: true, createdAt: 1, unresolved: [], map: {
      id: 'passage', title: 'Places', number: '', period: '', bounds: [[0, 0], [150, 60]], center: [70, 30], places: [p('geonames:1', 1), p('geonames:2', 140)],
    } };
    const filtered = excludeTextPlaces(result, ['geonames:2']);
    expect(filtered.map?.places.map(p => p.id)).toEqual(['geonames:1']);
    expect(filtered.map!.bounds[1][0]).toBeLessThan(2);
    expect(result.map?.places).toHaveLength(2);
    expect(mergeTextMaps([result], ['geonames:2'])?.map?.places).toHaveLength(1);
    expect(excludeTextPlaces(filtered, ['geonames:1']).map).toBeNull();
  });

  it('requires authentication, ownership and explicit consent before paid work', async () => {
    const { request, endpoint, te, user, book } = await setup();
    let calls = 0; restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return answer(); } }).restore;
    for (const json of [{ text: '平型关' }, { text: '平型关', confirmed: false }, { text: '平型关', confirmed: true, extra: true }, { text: 'a'.repeat(6001), confirmed: true }]) expect((await request(json)).status).toBe(400);
    expect((await new Client(te).fetch(endpoint, { method: 'POST', json: { text: '平型关', confirmed: true } })).status).toBe(401);
    const other = new Client(te); await other.login('other@example.com');
    expect((await other.fetch(endpoint, { method: 'POST', json: { text: '平型关', confirmed: true } })).status).toBe(404);
    expect(calls).toBe(0);
    expect((await env.BOOKS.list({ prefix: atlasPrefix(user.id, book.id) })).objects).toHaveLength(0);
    expect((await env.DB.prepare("SELECT * FROM ai_usage WHERE feature = 'text_atlas'").all()).results).toHaveLength(0);
  });

  it('grounds coordinates, records usage and reuses saved results without another call', async () => {
    const { request, book } = await setup(); let calls = 0;
    restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return answer(); } }).restore;
    const first = await request(); expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'ready', cached: false, map: { places: [{ id: 'geonames:1798648', coordinates: [113.93333, 39.33333] }] } });
    expect(await (await request()).json()).toMatchObject({ cached: true }); expect(calls).toBe(1);
    expect((await env.DB.prepare("SELECT * FROM ai_usage WHERE feature = 'text_atlas'").all()).results).toMatchObject([{ book_id: book.id, status: 'succeeded', total_tokens: 140, usage_status: 'reported' }]);
  });

  it('restores text places alongside image maps, including legacy results, without inference', async () => {
    const { request, client, te, user, book } = await setup(); let calls = 0;
    restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return answer(); } }).restore;
    const result = await (await request()).json() as TextAtlasResult;
    const prefix = atlasPrefix(user.id, book.id);
    await env.BOOKS.put(`${prefix}text/legacy.json`, JSON.stringify({ status: 'ready', result: { ...result, createdAt: 1 } }));
    await env.BOOKS.put(`${prefix}text/empty.json`, JSON.stringify({ status: 'ready', result: { ...result, status: 'uncertain', map: null } }));
    await env.BOOKS.put(`${prefix}text/running.json`, JSON.stringify({ status: 'running', startedAt: Date.now() }));
    await env.BOOKS.put(`${prefix}text/failed.json`, JSON.stringify({ status: 'failed', startedAt: Date.now() }));
    const imageMap = { ...result.map, id: 'image-map', image: { sha256: 'a'.repeat(64), bytes: 100 } };
    await env.BOOKS.put(`${prefix}content/image.json`, JSON.stringify({ result: { status: 'recognized', map: imageMap, recognizedAt: 1 } }));
    const endpoint = `/api/books/${book.id}/atlas`;
    const page = await (await client.fetch(endpoint)).json() as any;
    expect(page.maps).toHaveLength(1);
    expect(page.maps[0].map.id).toBe('image-map');
    expect(page.textMaps).toHaveLength(2);
    expect(page.textMaps.every((r: TextAtlasResult) => r.cached)).toBe(true);
    expect(mergeTextMaps(page.textMaps)?.map?.places).toHaveLength(1);
    expect(calls).toBe(1);
    const other = new Client(te); await other.login('other-atlas@example.com');
    expect((await other.fetch(endpoint)).status).toBe(404);
    const form = new FormData(); form.set('file', new File([buildEpub()], 'other.epub'));
    const { book: otherBook } = await (await client.fetch('/api/books', { method: 'POST', body: form })).json() as any;
    expect(await (await client.fetch(`/api/books/${otherBook.id}/atlas`)).json()).toMatchObject({ maps: [], textMaps: [] });
  });

  it('unions passage caches by geographic ID, keeping same-name distinct places and fitting all coordinates', () => {
    const result = (id: string, timestamp: number, placeId: string, longitude: number): TextAtlasResult => ({
      status: 'ready', cached: false, createdAt: timestamp, unresolved: [], map: {
        id, title: 'passage', period: '1937', number: '', bounds: [[0, 0], [1, 1]], center: [0, 0],
        places: [{ id: placeId, name: '同名地点', modernName: id, coordinates: [longitude, 40], imagePoint: null, source: 'GeoNames', sourceUrl: 'https://www.geonames.org/1', featureCode: 'PPL' }],
      },
    });
    const old = result('old', 1, 'geo:1', 179), newer = result('new', 2, 'geo:1', 179), other = result('other', 3, 'geo:2', -179);
    const merged = mergeTextMaps([other, newer, old, newer, { status: 'uncertain', map: null, createdAt: 4, unresolved: ['未知'], cached: true }]);
    expect(merged?.map?.places.map(p => [p.id, p.modernName])).toEqual([['geo:1', 'new'], ['geo:2', 'other']]);
    expect(merged?.map?.period).toBe('');
    expect(merged!.map!.bounds[1][0] - merged!.map!.bounds[0][0]).toBeLessThan(3);
    expect(mergeTextMaps([old, other, newer])).toEqual(merged);
    expect(mergeTextMaps([])).toBeNull();
  });

  it('atomically rejects concurrent generation and never automatically retries a failure', async () => {
    const { request, user } = await setup(); let release!: () => void, started!: () => void, calls = 0;
    const ready = new Promise<void>(r => { started = r; }); const gate = new Promise<void>(r => { release = r; });
    restore = mockFetch({ 'https://llm.test/chat/completions': async () => { calls++; started(); await gate; return new Response('failure', { status: 503 }); } }).restore;
    const work = request(); await ready;
    expect((await request()).status).toBe(409);
    expect(await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(`text-atlas:daily:v2:${user.id}`).first()).toEqual({ count: 1 });
    release(); expect((await work).status).toBe(502);
    expect((await request()).status).toBe(409); expect(calls).toBe(1);
    expect((await request({ text: '平型关位于晋北。', confirmed: true, retry: true })).status).toBe(502); expect(calls).toBe(2);
  });

  it.each(['uncertain', 'wrong-mountain'] as const)('refreshes an affected legacy %s cache only with consent, then reuses it', async kind => {
    const { request, client, book, user } = await setup(); let calls = 0;
    restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return answer(); } }).restore;
    const result = await (await request()).json() as TextAtlasResult;
    const key = (await env.BOOKS.list({ prefix: `${atlasPrefix(user.id, book.id)}text/` })).objects[0]!.key;
    const legacy = kind === 'uncertain' ? { ...result, status: 'uncertain', map: null, unresolved: ['平型关'] }
      : { ...result, map: { ...result.map, places: [{ ...result.map!.places[0], featureCode: 'MT', id: 'geonames:7407572' }] } };
    await env.BOOKS.put(key, JSON.stringify({ status: 'ready', startedAt: 1, result: legacy }));
    await client.fetch(`/api/books/${book.id}/atlas`);
    expect((await request({ text: '平型关位于晋北。', confirmed: false })).status).toBe(400);
    expect(calls).toBe(1);
    expect(await (await request()).json()).toMatchObject({ cached: false, map: { places: [{ id: 'geonames:1798648' }] } });
    expect(await (await request()).json()).toMatchObject({ cached: true });
    expect(calls).toBe(2);
    expect((await env.BOOKS.list({ prefix: `${atlasPrefix(user.id, book.id)}text/` })).objects).toHaveLength(1);
    const saved = await (await env.BOOKS.get(key))!.json<any>();
    expect(saved.resolverVersion).toBe(geo.TEXT_RESOLVER_VERSION);
  });

  it('refreshes v3 unresolved Handan after consent once and preserves complete v3 results', async () => {
    const { request, user, book } = await setup(); let calls = 0;
    const city: geo.PlaceQuery = { name: '邯郸', aliases: ['Handan'], kind: 'city', country: 'CN' };
    vi.mocked(geo.gazetteerLookup).mockReturnValue(async () => handanRows);
    restore = mockFetch({ 'https://llm.test/chat/completions': () => {
      calls++;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: '邯郸', period: '', region: '', places: [city] }) } }], usage: { prompt_tokens: 100, completion_tokens: 40 } });
    } }).restore;
    const digest = await sha256Hex(`v2-global:${manifest.sha256}:邯郸`);
    const key = `${atlasPrefix(user.id, book.id)}text/${digest}.json`;
    const old = { status: 'ready', startedAt: 1, resolverVersion: 3,
      result: { status: 'uncertain', map: null, unresolved: ['邯郸'], createdAt: 1, cached: false, cacheId: `text-${digest}` } };
    await env.BOOKS.put(key, JSON.stringify(old));
    expect((await request({ text: '邯郸', confirmed: false })).status).toBe(400);
    expect(calls).toBe(0);
    expect(await (await request({ text: '邯郸', confirmed: true })).json()).toMatchObject({ cached: false, status: 'ready', map: { places: [{ id: 'geonames:1808963' }] } });
    expect(await (await request({ text: '邯郸', confirmed: true })).json()).toMatchObject({ cached: true });
    expect(calls).toBe(1);
    const saved = await (await env.BOOKS.get(key))!.json<any>();
    expect(saved.resolverVersion).toBe(geo.TEXT_RESOLVER_VERSION);
    expect(geo.reusableTextResult(saved.result, 3)).toBe(true);
    expect(geo.reusableTextResult({ ...saved.result, unresolved: ['邯郸'] }, 3)).toBe(false);
    expect(geo.reusableTextResult({ ...saved.result, map: { ...saved.result.map, places: [{ ...saved.result.map.places[0], featureCode: 'MTS' }] } }, 3)).toBe(true);
  });

  it('refreshes v4 unresolved Anyang only after consent and keeps complete v4 results cached', async () => {
    const { request, user, book } = await setup(); let calls = 0;
    const rows = anyangRows;
    vi.mocked(geo.gazetteerLookup).mockReturnValue(async name => rows[geo.normalizePlace(name)] ?? []);
    restore = mockFetch({ 'https://llm.test/chat/completions': () => {
      calls++;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: '安阳', period: '', region: '', places: [{ name: '安阳', aliases: ['Anyang'], kind: 'city', country: 'CN' }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 40 } });
    } }).restore;
    const digest = await sha256Hex(`v2-global:${manifest.sha256}:安阳`);
    const key = `${atlasPrefix(user.id, book.id)}text/${digest}.json`;
    await env.BOOKS.put(key, JSON.stringify({ status: 'ready', startedAt: 1, resolverVersion: 4,
      result: { status: 'uncertain', map: null, unresolved: ['安阳'], createdAt: 1, cached: false, cacheId: `text-${digest}` } }));
    expect((await request({ text: '安阳', confirmed: false })).status).toBe(400); expect(calls).toBe(0);
    expect(await (await request({ text: '安阳', confirmed: true })).json()).toMatchObject({ cached: false, status: 'ready', map: { places: [{ id: 'geonames:1785294' }] } });
    expect(await (await request({ text: '安阳', confirmed: true })).json()).toMatchObject({ cached: true }); expect(calls).toBe(1);
    const saved = await (await env.BOOKS.get(key))!.json<any>();
    expect(saved.resolverVersion).toBe(geo.TEXT_RESOLVER_VERSION);
    expect(geo.reusableTextResult(saved.result, 4)).toBe(true);
    expect(geo.reusableTextResult({ ...saved.result, unresolved: ['其他地点'] }, 4)).toBe(false);
    expect(geo.reusableTextResult({ ...saved.result, map: { ...saved.result.map, places: [{ ...saved.result.map.places[0], featureCode: 'MTS' }] } }, 4)).toBe(true);
  });

  it('refreshes v6 unresolved Hanoi once after consent and reuses the updated pin', async () => {
    const { request, user, book } = await setup();
    vi.mocked(geo.gazetteerLookup).mockReturnValue(lookupHan);
    const extract = vi.fn(() => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      title: '河内', period: '', region: '', places: [{ ...hanoi, aliases: ['Hà Nội'] }],
    }) } }], usage: { prompt_tokens: 100, completion_tokens: 40 } }));
    restore = mockFetch({ 'https://llm.test/chat/completions': extract }).restore;
    const digest = await sha256Hex(`v2-global:${manifest.sha256}:河内`);
    const key = `${atlasPrefix(user.id, book.id)}text/${digest}.json`;
    const old = { status: 'ready', startedAt: 1, resolverVersion: 6,
      result: { status: 'uncertain', map: null, unresolved: ['河内'], createdAt: 1, cached: false, cacheId: `text-${digest}` } };
    await env.BOOKS.put(key, JSON.stringify(old));
    expect((await request({ text: '河内', confirmed: false })).status).toBe(400);
    expect(await (await env.BOOKS.get(key))!.json()).toEqual(old);
    expect(extract).not.toHaveBeenCalled();
    const result = await (await request({ text: '河内', confirmed: true })).json<TextAtlasResult>();
    expect(result).toMatchObject({ cached: false, status: 'ready', unresolved: [], map: { places: [{ id: 'geonames:1581130' }] } });
    expect(await (await request({ text: '河内', confirmed: true })).json()).toMatchObject({ cached: true, map: result.map });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(geo.reusableTextResult({ ...result, map: { ...result.map!, places: [{ ...result.map!.places[0], featureCode: 'MTS' }] } }, 6)).toBe(true);
    expect(geo.reusableTextResult({ ...result, unresolved: ['河内'] }, 6)).toBe(false);
  });

  it('refreshes v7 unresolved Hawaii after consent once and preserves complete v7 results', async () => {
    const { request, user, book } = await setup();
    vi.mocked(geo.gazetteerLookup).mockReturnValue(lookupHawaii);
    const extract = vi.fn(() => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      title: '夏威夷', period: '', region: '', places: [{ name: '夏威夷', aliases: ['Hawaii'], kind: 'unknown', country: 'US' }],
    }) } }], usage: { prompt_tokens: 420, completion_tokens: 41 } }));
    restore = mockFetch({ 'https://llm.test/chat/completions': extract }).restore;
    const digest = await sha256Hex(`v2-global:${manifest.sha256}:夏威夷`);
    const key = `${atlasPrefix(user.id, book.id)}text/${digest}.json`;
    const old = { status: 'ready', startedAt: 1, resolverVersion: 7,
      result: { status: 'uncertain', map: null, unresolved: ['夏威夷'], createdAt: 1, cached: false, cacheId: `text-${digest}` } };
    await env.BOOKS.put(key, JSON.stringify(old));
    expect((await request({ text: '夏威夷', confirmed: false })).status).toBe(400);
    expect(extract).not.toHaveBeenCalled();
    const result = await (await request({ text: '夏威夷', confirmed: true })).json<TextAtlasResult>();
    expect(result).toMatchObject({ cached: false, status: 'ready', unresolved: [], map: { places: [{ id: 'geonames:5855797', coordinates: [-156.38612, 20.78785] }] } });
    expect(await (await request({ text: '夏威夷', confirmed: true })).json()).toMatchObject({ cached: true, map: result.map });
    expect(extract).toHaveBeenCalledTimes(1);
    const saved = await (await env.BOOKS.get(key))!.json<any>();
    expect(saved.resolverVersion).toBe(geo.TEXT_RESOLVER_VERSION);
    expect(geo.reusableTextResult(saved.result, 7)).toBe(true);
    expect(geo.reusableTextResult({ ...saved.result, unresolved: ['夏威夷'] }, 7)).toBe(false);
  });

  it('refreshes v5 unresolved Kaifeng only after consent and keeps complete v5 results cached', async () => {
    const { request, user, book } = await setup(); let calls = 0;
    const rows = kaifengRows;
    vi.mocked(geo.gazetteerLookup).mockReturnValue(async name => rows[geo.normalizePlace(name)] ?? []);
    restore = mockFetch({ 'https://llm.test/chat/completions': () => {
      calls++;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: '开封', period: '', region: '', places: [{ name: '开封', aliases: ['Kaifeng'], kind: 'city', country: 'CN' }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 40 } });
    } }).restore;
    const digest = await sha256Hex(`v2-global:${manifest.sha256}:开封`);
    const key = `${atlasPrefix(user.id, book.id)}text/${digest}.json`;
    await env.BOOKS.put(key, JSON.stringify({ status: 'ready', startedAt: 1, resolverVersion: 5,
      result: { status: 'uncertain', map: null, unresolved: ['开封'], createdAt: 1, cached: false, cacheId: `text-${digest}` } }));
    expect((await request({ text: '开封', confirmed: false })).status).toBe(400); expect(calls).toBe(0);
    expect(await (await request({ text: '开封', confirmed: true })).json()).toMatchObject({ cached: false, status: 'ready', map: { places: [{ id: 'geonames:1804879' }] } });
    expect(await (await request({ text: '开封', confirmed: true })).json()).toMatchObject({ cached: true }); expect(calls).toBe(1);
    const saved = await (await env.BOOKS.get(key))!.json<any>();
    expect(saved.resolverVersion).toBe(geo.TEXT_RESOLVER_VERSION);
    expect(geo.reusableTextResult(saved.result, 5)).toBe(true);
    expect(geo.reusableTextResult({ ...saved.result, unresolved: ['其他地点'] }, 5)).toBe(false);
    expect(geo.reusableTextResult({ ...saved.result, map: { ...saved.result.map, places: [{ ...saved.result.map.places[0], featureCode: 'MTS' }] } }, 5)).toBe(true);
  });

  it('keeps unaffected legacy success and newly unresolved results free of repeated inference', async () => {
    const { request, user, book } = await setup(); let calls = 0;
    restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return answer(); } }).restore;
    await request();
    const key = (await env.BOOKS.list({ prefix: `${atlasPrefix(user.id, book.id)}text/` })).objects[0]!.key;
    const old = await (await env.BOOKS.get(key))!.json<any>(); delete old.resolverVersion;
    await env.BOOKS.put(key, JSON.stringify(old));
    expect(await (await request()).json()).toMatchObject({ cached: true });
    vi.mocked(geo.gazetteerLookup).mockReturnValue(async () => []);
    const input = { text: '平型关未能定位。', confirmed: true };
    expect(await (await request(input)).json()).toMatchObject({ status: 'uncertain', cached: false });
    expect(await (await request(input)).json()).toMatchObject({ status: 'uncertain', cached: true });
    expect(calls).toBe(2);
  });

  it('refreshes v2 unresolved city results after consent and reuses v2 complete successes', async () => {
    const { request, user, book } = await setup(); let calls = 0;
    const city: geo.PlaceQuery = { name: '上海', aliases: ['Shanghai'], kind: 'city', country: 'CN' };
    const rows: geo.GeoRecord[] = [
      ['1796236', 'Shanghai', 121.45806, 31.22222, 'P', 'PPLA', '23', '', 'CN', []],
      ['10138757', 'Shanghai', 100.107, 27.0741, 'P', 'PPL', '29', '', 'CN', []],
    ];
    vi.mocked(geo.gazetteerLookup).mockReturnValue(async () => rows);
    restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: '上海', period: '', region: '', places: [city] }) } }], usage: { prompt_tokens: 100, completion_tokens: 40 } }); } }).restore;
    const input = { text: '上海', confirmed: true };
    expect(await (await request(input)).json()).toMatchObject({ status: 'ready', map: { places: [{ id: 'geonames:1796236' }] } });
    const key = (await env.BOOKS.list({ prefix: `${atlasPrefix(user.id, book.id)}text/` })).objects[0]!.key;
    const saved = await (await env.BOOKS.get(key))!.json<any>();
    await env.BOOKS.put(key, JSON.stringify({ ...saved, resolverVersion: 2 }));
    expect(await (await request(input)).json()).toMatchObject({ cached: true }); expect(calls).toBe(1);
    await env.BOOKS.put(key, JSON.stringify({ ...saved, resolverVersion: 2, result: { ...saved.result, status: 'uncertain', map: null, unresolved: ['上海'] } }));
    expect((await request({ ...input, confirmed: false })).status).toBe(400); expect(calls).toBe(1);
    expect(await (await request(input)).json()).toMatchObject({ cached: false, status: 'ready', map: { places: [{ id: 'geonames:1796236' }] } });
    expect(await (await request(input)).json()).toMatchObject({ cached: true }); expect(calls).toBe(2);
    expect(geo.reusableTextResult({ ...saved.result, unresolved: ['其他地点'] }, 2)).toBe(false);
    expect(geo.reusableTextResult({ ...saved.result, map: { ...saved.result.map, places: [{ ...saved.result.map.places[0], featureCode: 'MTS' }] } }, 2)).toBe(true);
  });

  it('replaces a corrected passage in the union instead of retaining its wrong point', () => {
    const result = (placeId: string, createdAt: number): TextAtlasResult => ({ status: 'ready', cached: true, createdAt, unresolved: [],
      map: { id: 'same-passage', title: '五台山', period: '', number: '', bounds: [[100, 30], [115, 40]], center: [113, 39],
        places: [{ id: placeId, name: '五台山', modernName: 'Wutai', coordinates: [113, 39], imagePoint: null, source: 'GeoNames', sourceUrl: '', featureCode: 'MTS' }] } });
    const wrong = result('geonames:7407572', 1), fixed = result('geonames:1790956', 2);
    expect(mergeTextMaps([fixed, wrong])?.map?.places.map(p => p.id)).toEqual(['geonames:1790956']);
    expect(mergeTextMaps([wrong, { status: 'uncertain', cacheId: 'same-passage', map: null, createdAt: 3, cached: false, unresolved: ['五台山'] }])).toBeNull();
  });

  it('does not bill when the gazetteer is unavailable and removes caches with the book', async () => {
    const { request, user, book, client } = await setup(); let calls = 0;
    restore = mockFetch({ 'https://llm.test/chat/completions': () => { calls++; return answer(); } }).restore;
    await env.BOOKS.delete(manifest.key); expect((await request()).status).toBe(503); expect(calls).toBe(0);
    await env.BOOKS.put(manifest.key, 'fixture'); expect((await request()).status).toBe(200);
    expect((await client.fetch(`/api/books/${book.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await env.BOOKS.list({ prefix: atlasPrefix(user.id, book.id) })).objects).toHaveLength(0);
  });
});

describe('place disambiguation', () => {
  it('matches Hanoi within Vietnam and retains the selected spelling with or without a Latin alias', async () => {
    for (const name of ['河内', '河內']) for (const aliases of [[], ['Hanoi'], ['Hà Nội']]) {
      const { places, unresolved } = await geo.resolveTextPlaces([{ ...hanoi, name, aliases }], '', lookupHan);
      expect(unresolved).toEqual([]);
      expect(places).toMatchObject([{ id: 'geonames:1581130', name, coordinates: [105.84117, 21.0245], countryCode: 'VN' }]);
    }
    const lookup = vi.fn(lookupHan);
    expect(await geo.resolveTextPlaces([{ ...hanoi, country: 'CN' }], '', lookup)).toEqual({ places: [], unresolved: ['河内'] });
    expect(lookup.mock.calls.every(([, country]) => country === 'CN')).toBe(true);
  });

  it('matches other foreign cities in both script directions using GeoNames spellings', async () => {
    for (const [name, country, id] of [['维也纳', 'AT', '2761369'], ['维也納', 'AT', '2761369'], ['维·也纳', 'AT', '2761369'], ['內羅畢', 'KE', '184745']]) {
      const result = await geo.resolveTextPlaces([{ ...hanoi, name, country }], '', lookupHan);
      expect(result.places).toMatchObject([{ id: `geonames:${id}`, name, countryCode: country }]);
    }
  });

  it('keeps exact spellings and does not guess from ambiguous character conversions', async () => {
    const exact = hanRows['VN:河內']![0];
    const lookup = vi.fn(async (name: string) => name === '河内' || name === '發城' || name === '髮城' ? [exact] : []);
    expect((await geo.resolveTextPlaces([hanoi], '', lookup)).places).toHaveLength(1);
    expect(lookup.mock.calls.map(([name]) => name)).toEqual(['河内']);
    lookup.mockClear();
    expect((await geo.resolveTextPlaces([{ ...hanoi, name: '发城' }], '', lookup)).unresolved).toEqual(['发城']);
    expect(lookup.mock.calls.map(([name]) => name)).toEqual(['发城']);
  });

  it('preserves exact source-name decisions when an optional model alias has only a converted match', async () => {
    const capital = hanRows['VN:河內']![0];
    const village: geo.GeoRecord = ['village', 'Village', 102, 20, 'P', 'PPL', 'other-region', '', 'VN', []];
    const data: Record<string, geo.GeoRecord[]> = { '河内': [capital, village], '譯名': [village] };
    const lookup = vi.fn(async (name: string) => data[name] ?? []);
    expect((await geo.resolveTextPlaces([{ ...hanoi, aliases: ['译名'] }], '', lookup)).places[0]?.id).toBe('geonames:1581130');
    expect(lookup.mock.calls.map(([name]) => name)).toEqual(['河内', '译名']);
    expect((await geo.resolveTextPlaces([{ ...hanoi, name: 'Example', aliases: ['译名'] }], '', lookup)).places[0]?.id).toBe('geonames:village');
  });

  it('requires a unique compatible converted match and respects aliases and province', async () => {
    const capital = hanRows['VN:河內']![0];
    const other: geo.GeoRecord = ['other', 'Other settlement', 102, 20, 'P', 'PPL', 'other-region', '', 'VN', []];
    const province: geo.GeoRecord = ['province', 'Province', 102, 20, 'A', 'ADM1', 'other-region', '', 'VN', []];
    const anchor: geo.GeoRecord = ['anchor', 'Nearby', capital[2], capital[3], 'P', 'PPL', capital[6], '', 'VN', []];
    const rows: Record<string, geo.GeoRecord[]> = { '河內': [capital, other], '另一地': [anchor], '邊省': [province] };
    const lookup = async (name: string) => rows[name] ?? [];
    expect((await geo.resolveTextPlaces([hanoi, { ...hanoi, name: '另一地' }], '', lookup)).unresolved).toEqual(['河内']);
    expect((await geo.resolveTextPlaces([hanoi], '邊省', lookup)).places[0]?.id).toBe('geonames:other');
    const restricted = async (name: string) => name === '河內' ? [capital] : lookup(name);
    expect((await geo.resolveTextPlaces([hanoi], '边省', restricted)).unresolved).toEqual(['河内']);
    const anotherProvince: geo.GeoRecord = ['another-province', 'Second province', 103, 21, 'A', 'ADM1', 'second', '', 'VN', []];
    const ambiguousRegion = async (name: string) => name === '河内' ? [capital] : name === '邊省' ? [province, anotherProvince] : [];
    expect((await geo.resolveTextPlaces([hanoi], '边省', ambiguousRegion)).unresolved).toEqual(['河内']);
    expect((await geo.resolveTextPlaces([{ ...hanoi, aliases: ['另一地'] }], '', restricted)).unresolved).toEqual(['河内']);
    expect((await geo.resolveTextPlaces([{ ...hanoi, kind: 'mountain' }], '', restricted)).unresolved).toEqual(['河内']);
  });

  it('resolves Anyang short/formal names against the published multilingual index', async () => {
    const rows = anyangRows;
    const henan: geo.GeoRecord = ['henan', 'Henan', 113.5, 34, 'A', 'ADM1', '09', '', 'CN', []];
    const lookup = async (name: string) => name === '河南' ? [henan] : rows[geo.normalizePlace(name)] ?? [];
    for (const name of ['安阳', '安阳市']) for (const aliases of [[], ['Anyang']]) for (const region of ['', '河南']) {
      const result = await geo.resolveTextPlaces([{ name, aliases, kind: 'city', country: 'CN' }], region, lookup);
      expect(result.unresolved).toEqual([]);
      expect(result.places[0]).toMatchObject({ id: 'geonames:1785294', coordinates: [114.38278, 36.096] });
    }
    // Chinese source spelling genuinely lacks the city: a strict alias intersection lost it.
    expect(rows['安阳']!.some(r => r[0] === '1785294')).toBe(false);
    expect(rows['安阳市']!.some(r => r[0] === '1785294')).toBe(true);
  });

  it('resolves a Chinese city with a generic PPL code using its formal city name and matching ADM2', async () => {
    const lookup = async (name: string) => kaifengRows[geo.normalizePlace(name)] ?? [];
    for (const name of ['开封', '开封市']) for (const aliases of [[], ['Kaifeng']]) {
      const result = await geo.resolveTextPlaces([{ name, aliases, kind: 'city', country: 'CN' }], '', lookup);
      expect(result.unresolved).toEqual([]);
      expect(result.places).toMatchObject([{ id: 'geonames:1804879', coordinates: [114.30742, 34.7986], featureCode: 'PPL' }]);
    }
  });

  it('does not use formal-city evidence to override a province, conflicting alias or settlement type', async () => {
    const province: geo.GeoRecord = ['province', 'Sichuan', 104, 30, 'A', 'ADM1', '32', '', 'CN', []];
    const lookup = async (name: string) => name === '四川' ? [province] : name === '明确村庄' ? [kaifengRows['开封']![3]!] : kaifengRows[geo.normalizePlace(name)] ?? [];
    const q: geo.PlaceQuery = { name: '开封', aliases: [], kind: 'city', country: 'CN' };
    expect((await geo.resolveTextPlaces([q], '四川', lookup)).unresolved).toEqual(['开封']);
    expect((await geo.resolveTextPlaces([{ ...q, aliases: ['明确村庄'] }], '', lookup)).places[0]?.id).toBe('geonames:1804881');
    for (const kind of ['settlement', 'unknown'] as const) expect((await geo.resolveTextPlaces([{ ...q, kind }], '', lookup)).unresolved).toEqual(['开封']);
  });

  it('requires unique formal municipality and settlement evidence, including matching jurisdiction codes', async () => {
    const city: geo.GeoRecord = ['city', 'Example', 114, 35, 'P', 'PPL', '09', '4102', 'CN', []];
    const admin: geo.GeoRecord = ['admin', 'Example Shi', 114.2, 35, 'A', 'ADM2', '09', '4102', 'CN', []];
    const village: geo.GeoRecord = ['village', 'Example', 105, 31, 'P', 'PPL', '32', '5108', 'CN', []];
    const q: geo.PlaceQuery = { name: '示例', aliases: [], kind: 'city', country: 'CN' };
    const resolve = (formal: geo.GeoRecord[]) => geo.resolveTextPlaces([q], '', async name => name === '示例市' ? formal : [city, village]);
    expect((await resolve([city, admin])).places[0]?.id).toBe('geonames:city');
    for (const formal of [[city], [admin], [city, { ...admin, 7: 'different' }], [city, { ...admin, 6: '' }], [city, village, { ...admin, 7: '5108' }], [city, admin, { ...admin, 0: 'peer', 6: '32', 7: '5108' }], [city, village, admin, { ...admin, 0: 'peer', 6: '32', 7: '5108' }]]) {
      expect((await resolve(formal)).unresolved).toEqual(['示例']);
    }
    expect((await geo.resolveTextPlaces([{ ...q, country: 'JP' }], '', async () => [city, admin, village])).places).toEqual([]);
  });

  it('preserves province, settlement, conflicting alias and competing-city constraints for Chinese names', async () => {
    const rows = anyangRows;
    const hubei: geo.GeoRecord = ['hubei', 'Hubei', 112, 31, 'A', 'ADM1', '12', '', 'CN', []];
    const q: geo.PlaceQuery = { name: '安阳', aliases: ['Anyang'], kind: 'city', country: 'CN' };
    const lookup = async (name: string) => name === '湖北' ? [hubei] : name === '安阳县' ? [rows['安阳']![0]!] : rows[geo.normalizePlace(name)] ?? [];
    expect((await geo.resolveTextPlaces([q], '湖北', lookup)).places[0]?.id).toBe('geonames:1817945');
    expect((await geo.resolveTextPlaces([{ ...q, aliases: ['安阳县'] }], '', lookup)).places).toEqual([]);
    for (const kind of ['settlement', 'unknown'] as const) expect((await geo.resolveTextPlaces([{ ...q, kind }], '', lookup)).unresolved).toEqual(['安阳']);
    const city = rows['安阳市']![0]!;
    const competing = { ...city, 0: 'another-city', 6: 'another-province' };
    expect((await geo.resolveTextPlaces([q], '', async name => [...await lookup(name), competing])).unresolved).toEqual(['安阳']);
  });

  it('uses Chinese city name variants generically without rewriting explicit county/town/village names or foreign places', async () => {
    const city: geo.GeoRecord = ['city', 'Example', 110, 30, 'P', 'PPLA2', 'a', 'b', 'CN', []];
    const lookup = vi.fn(async (name: string) => name === '示例市' ? [city] : []);
    expect((await geo.resolveTextPlaces([{ name: '示例', aliases: [], kind: 'city', country: 'CN' }], '', lookup)).places[0]?.id).toBe('geonames:city');
    for (const name of ['示例县', '示例區', '示例镇', '示例村']) {
      lookup.mockClear(); await geo.resolveTextPlaces([{ name, aliases: [], kind: 'city', country: 'CN' }], '', lookup);
      expect(lookup.mock.calls[0][0]).toBe(name);
      expect(lookup.mock.calls.every(([spelling]) => /^示例[县縣区區镇鎮村]$/.test(spelling))).toBe(true);
    }
    lookup.mockClear(); await geo.resolveTextPlaces([{ name: '示例', aliases: [], kind: 'city', country: 'JP' }], '', lookup);
    expect(lookup.mock.calls.map(call => call[0])).toEqual(['示例']);
  });

  it('resolves the published Handan rows while preserving explicit district or unknown interpretations', async () => {
    const q: geo.PlaceQuery = { name: '邯郸', aliases: [], kind: 'city', country: 'CN' };
    const lookup = async (name: string) => name === 'Hanshan' ? [handanRows[3]!] : handanRows;
    for (const aliases of [[], ['Handan']]) {
      const result = await geo.resolveTextPlaces([{ ...q, aliases }], '', lookup);
      expect(result.unresolved).toEqual([]);
      expect(result.places[0]).toMatchObject({ id: 'geonames:1808963', coordinates: [114.48764, 36.60999] });
    }
    expect((await geo.resolveTextPlaces([{ ...q, aliases: ['Hanshan'] }], '', lookup)).places[0]?.id).toBe('geonames:1812147');
    for (const kind of ['settlement', 'admin', 'unknown'] as const) {
      expect((await geo.resolveTextPlaces([{ ...q, kind }], '', lookup)).unresolved).toEqual(['邯郸']);
    }
  });

  it('uses parent/district evidence globally without ranking unrelated or competing city seats', async () => {
    const parent: geo.GeoRecord = ['parent', 'Example', 10, 45, 'P', 'PPLA2', 'a1', 'a2', 'FR', []];
    const district: geo.GeoRecord = ['district', 'Example District', 10.02, 45.02, 'P', 'PPLA3', 'a1', 'a2', 'FR', []];
    const q: geo.PlaceQuery = { name: 'Example', aliases: [], kind: 'city', country: 'FR' };
    expect((await geo.resolveTextPlaces([q], '', async () => [district, parent])).places[0]?.id).toBe('geonames:parent');
    for (const patch of [{ 5: 'PPLA2' }, { 6: 'other' }, { 7: 'other' }, { 7: '' }, { 2: 12 }, { 5: 'PPLC' }]) {
      const result = await geo.resolveTextPlaces([q], '', async () => [parent, { ...district, ...patch }]);
      expect(result.places).toEqual([]); expect(result.unresolved).toEqual(['Example']);
    }
    expect((await geo.resolveTextPlaces([q], '', async () => [{ ...parent, 7: '' }, district])).places).toEqual([]);
  });

  it.each([
    ['上海', 'CN', '1796236', 'PPLA'], ['北京', 'CN', '1816670', 'PPLC'],
    ['天津', 'CN', '1792947', 'PPLA'], ['重庆', 'CN', '1814906', 'PPLA'],
    ['Paris', 'FR', '2988507', 'PPLC'], ['Cambridge', 'GB', '2653941', 'PPLA2'],
  ])('distinguishes the city %s from same-name villages without a place-name whitelist', async (name, country, id, code) => {
    const seat: geo.GeoRecord = [id, name, 120, 30, 'P', code, 'city-region', '', country, []];
    const village: geo.GeoRecord = ['village', name, 100, 25, 'P', 'PPL', 'other-region', '', country, []];
    const admin: geo.GeoRecord = ['province', name, 120, 30, 'A', 'ADM1', 'city-region', '', country, []];
    const q: geo.PlaceQuery = { name, aliases: [], kind: 'city', country };
    const lookup = async () => [village, admin, seat];
    expect((await geo.resolveTextPlaces([q], '', lookup)).places.map(p => p.id)).toEqual([`geonames:${id}`]);
    for (const kind of ['settlement', 'unknown'] as const) {
      expect((await geo.resolveTextPlaces([{ ...q, kind }], '', lookup)).unresolved).toEqual([name]);
    }
  });

  it('does not override region/alias evidence, rank competing cities, or drop non-capital cities', async () => {
    const city: geo.GeoRecord = ['city', 'Town', 120, 30, 'P', 'PPLA', '23', '', 'CN', []];
    const village: geo.GeoRecord = ['village', 'Town', 100, 25, 'P', 'PPL', '29', '', 'CN', []];
    const province: geo.GeoRecord = ['province', 'Yunnan', 100, 25, 'A', 'ADM1', '29', '', 'CN', []];
    const q: geo.PlaceQuery = { name: 'Town', aliases: [], kind: 'city', country: 'CN' };
    expect((await geo.resolveTextPlaces([q], 'Yunnan', async n => n === 'Yunnan' ? [province] : [city, village])).places[0]?.id).toBe('geonames:village');
    expect((await geo.resolveTextPlaces([{ ...q, aliases: ['Village'] }], '', async n => n === 'Village' ? [village] : [city, village])).places[0]?.id).toBe('geonames:village');
    expect((await geo.resolveTextPlaces([q], '', async () => [city, { ...village, 5: 'PPLC' }])).unresolved).toEqual(['Town']);
    expect((await geo.resolveTextPlaces([q], '', async () => [village])).places[0]?.id).toBe('geonames:village');
    expect((await geo.resolveTextPlaces([q], '', async () => [village, { ...village, 0: 'other' }])).unresolved).toEqual(['Town']);
  });

  it('accepts Mount Wutai as a mountain or range and uses aliases or province to disambiguate', async () => {
    const lookup = async (name: string) => name === '山西' ? [shanxi] : name === 'Mount Wutai' ? [wutai] : [wutai, qinghaiWutai];
    for (const kind of ['mountain', 'mountain_range'] as const) {
      for (const [region, aliases] of [['山西', []], ['', ['Mount Wutai']]] as [string, string[]][]) {
        const result = await geo.resolveTextPlaces([{ name: '五台山', country: 'CN', kind, aliases }], region, lookup);
        expect(result.places.map(p => p.id)).toEqual(['geonames:1790956']);
        expect(result.places[0]?.coordinates).toEqual([113.56261, 39.08262]);
      }
    }
    const ambiguous = await geo.resolveTextPlaces([{ name: '五台山', country: 'CN', kind: 'mountain', aliases: [] }], '', lookup);
    expect(ambiguous.places).toEqual([]); expect(ambiguous.unresolved).toEqual(['五台山']);
  });

  it('does not discard conflicting name evidence after a type or province filter removes it', async () => {
    const town: geo.GeoRecord = ['town', 'Town', 113.5, 39, 'P', 'PPL', '24', '', 'CN', []];
    const query: geo.PlaceQuery = { name: '五台山', country: 'CN', kind: 'mountain', aliases: ['another-name'] };
    for (const alias of [town, qinghaiWutai]) {
      const result = await geo.resolveTextPlaces([query], '山西', async name => name === '山西' ? [shanxi] : name === 'another-name' ? [alias] : [wutai]);
      expect(result.places).toEqual([]); expect(result.unresolved).toEqual(['五台山']);
    }
    // A pass name that exists only as a village cannot be replaced by an unrelated translated pass.
    expect((await geo.resolveTextPlaces([{ ...query, kind: 'pass' }], '', async name => name === '五台山' ? [town] : [pass])).places).toEqual([]);
  });
  it('matches multilingual names globally and intersects aliases without widening matches', async () => {
    const paris: geo.GeoRecord = ['2988507', 'Paris', 2.3488, 48.8534, 'P', 'PPLC', '11', '75', 'FR', [['zh', false, '', '']]];
    const other: geo.GeoRecord = ['other', 'Paris', 3, 47, 'P', 'PPL', '11', '', 'FR', []];
    const us: geo.GeoRecord = ['4717560', 'Paris', -95.5, 33.66, 'P', 'PPL', 'TX', '', 'US', []];
    const lookup = vi.fn(async (name: string, country: string) => country === 'FR' ? name === 'Paris' ? [paris, other, us] : [paris] : [us]);
    const result = await geo.resolveTextPlaces([{ name: '巴黎', aliases: ['Paris'], kind: 'settlement', country: 'FR' }, { name: 'Paris', aliases: [], kind: 'settlement', country: 'US' }], '', lookup);
    expect(result.places.map(p => p.id)).toEqual(['geonames:2988507', 'geonames:4717560']);
    expect(result.unresolved).toEqual([]);
    const conflicting = await geo.resolveTextPlaces([{ name: '巴黎', aliases: ['别处'], kind: 'settlement', country: 'FR' }], '', async n => n === '巴黎' ? [paris] : [other]);
    expect(conflicting.places).toEqual([]);
  });
  it('supports non-city foreign features and labels historical aliases', async () => {
    const river: geo.GeoRecord = ['2638289', 'River Thames', .65, 51.5, 'H', 'STM', 'ENG', '', 'GB', [['zh', false, '', '']]];
    const mountain: geo.GeoRecord = ['3020139', 'Mont Blanc', 6.86, 45.83, 'T', 'MT', '84', '', 'FR', [['zh', false, '', '']]];
    const city: geo.GeoRecord = ['524901', 'Saint Petersburg', 30.3, 59.9, 'P', 'PPLA', '66', '', 'RU', [['zh', true, '1924', '1991']]];
    const result = await geo.resolveTextPlaces([
      { name: '泰晤士河', aliases: [], kind: 'river', country: 'GB' },
      { name: '勃朗峰', aliases: [], kind: 'mountain', country: 'FR' },
      { name: '列宁格勒', aliases: [], kind: 'settlement', country: 'RU' },
    ], '', async n => n === '泰晤士河' ? [river] : n === '勃朗峰' ? [mountain] : [city]);
    expect(result.places).toHaveLength(3);
    expect(result.places[2]?.historicalAlias).toBe(true);
  });
  it('recognizes a volcano as a mountain without selecting same-name hills', async () => {
    const fuji: geo.GeoRecord = ['1864094', 'Fujiyama', 138.73, 35.36, 'T', 'VLC', '', '', 'JP', [['zh', false, '', '']]];
    const hill: geo.GeoRecord = ['8725193', 'Fuji Yama', 139, 36, 'T', 'HLL', '', '', 'JP', []];
    const result = await geo.resolveTextPlaces([{ name: '富士山', aliases: [], kind: 'mountain', country: 'JP' }], '', async () => [fuji, hill]);
    expect(result.places.map(p => p.id)).toEqual(['geonames:1864094']);
  });
  it('keeps state filters and proximity anchors inside the queried country', async () => {
    const state: geo.GeoRecord = ['state', 'State', 0, 0, 'A', 'ADM1', '11', '', 'FR', []];
    const nearbyWrongCountry: geo.GeoRecord = ['anchor', 'Anchor', 0, 0, 'P', 'PPL', '11', '', 'FR', []];
    const a: geo.GeoRecord = ['a', 'Town', 0, .01, 'P', 'PPL', '22', '', 'GB', []];
    const b: geo.GeoRecord = ['b', 'Town', 5, 5, 'P', 'PPL', '22', '', 'GB', []];
    const result = await geo.resolveTextPlaces([{ name: 'Anchor', aliases: [], kind: 'settlement', country: 'FR' }, { name: 'Town', aliases: [], kind: 'settlement', country: 'GB' }], 'State', async n => n === 'State' ? [state] : n === 'Anchor' ? [nearbyWrongCountry] : [a, b]);
    expect(result.unresolved).toEqual(['Town']);
  });
  it('distinguishes passes from settlements and leaves equally plausible places unresolved', async () => {
    expect((await geo.resolveTextPlaces([query], '', async () => [pass, village])).places[0]?.id).toBe('geonames:1798648');
    const uncertain = await geo.resolveTextPlaces([{ ...query, kind: 'unknown' }], '', async () => [pass, village]);
    expect(uncertain.places).toHaveLength(0); expect(uncertain.unresolved).toEqual(['平型关']);
  });
  it('uses unambiguous anchors for nearby villages without inventing missing places', async () => {
    const near: geo.GeoRecord = ['7520534', '小寨', 113.97099, 39.36862, 'P', 'PPL', '24', '', 'CN', []];
    const far: geo.GeoRecord = ['other', '小寨', 110, 30, 'P', 'PPL', '24', '', 'CN', []];
    const result = await geo.resolveTextPlaces([query, { name: '小寨', kind: 'settlement', country: 'CN', aliases: [] }, { name: '未知地点', kind: 'unknown', country: 'CN', aliases: [] }], '', async n => n === '平型关' ? [pass, village] : n === '小寨' ? [near, far] : []);
    expect(result.places.map(p => p.id)).toEqual(['geonames:1798648', 'geonames:7520534']); expect(result.unresolved).toEqual(['未知地点']);
  });
  it('resolves Hawaii across admin, island, and unknown queries using formal state suffixes and ADM1 hierarchy', async () => {
    for (const q of [
      { name: '夏威夷', aliases: ['Hawaii'], kind: 'admin' as const, country: 'US' },
      { name: '夏威夷', aliases: [], kind: 'admin' as const, country: 'US' },
      { name: '夏威夷', aliases: ['Hawaii'], kind: 'unknown' as const, country: 'US' },
      { name: 'Hawaii', aliases: [], kind: 'admin' as const, country: 'US' },
    ]) {
      const result = await geo.resolveTextPlaces([q], '', lookupHawaii);
      expect(result.unresolved).toEqual([]);
      expect(result.places).toMatchObject([{ id: 'geonames:5855797', name: q.name, featureCode: 'ADM1', countryCode: 'US' }]);
    }
    expect((await geo.resolveTextPlaces([{ name: '夏威夷', aliases: ['Hawaii'], kind: 'island', country: 'US' }], '', lookupHawaii)).places[0]?.id).toBe('geonames:5855799');
    expect((await geo.resolveTextPlaces([{ name: '夏威夷', aliases: ['Hawaiian Islands'], kind: 'island', country: 'US' }], '', lookupHawaii)).places[0]?.id).toBe('geonames:5855811');
    expect((await geo.resolveTextPlaces([{ name: '夏威夷', aliases: ['Hawaiian Islands'], kind: 'unknown', country: 'US' }], '', lookupHawaii)).places[0]?.id).toBe('geonames:5855811');
    const countyLookup = async (name: string, country: string) => name === 'Hawaii County' ? [hawaiiIndex['US:hawaii']![1]!] : lookupHawaii(name, country);
    expect((await geo.resolveTextPlaces([{ name: 'Hawaii County', aliases: ['Hawaii'], kind: 'admin', country: 'US' }], '', countyLookup)).places[0]?.id).toBe('geonames:5855765');
    const samePrimaryAdmin: geo.GeoRecord[] = [
      ['adm1', 'Example', 10, 20, 'A', 'ADM1', 'EX', '', 'US', []],
      ['adm2', 'Example', 10.1, 20.1, 'A', 'ADM2', 'EX', '001', 'US', []],
    ];
    expect((await geo.resolveTextPlaces([{ name: 'Example', aliases: [], kind: 'admin', country: 'US' }], '', async () => samePrimaryAdmin)).unresolved).toEqual(['Example']);
    const otherStateCounty: geo.GeoRecord[] = [
      ['adm1', 'Example', 10, 20, 'A', 'ADM1', 'EX', '', 'US', []],
      ['adm2', 'Example County', 15, 25, 'A', 'ADM2', 'OT', '001', 'US', []],
    ];
    expect((await geo.resolveTextPlaces([{ name: 'Example', aliases: [], kind: 'admin', country: 'US' }], '', async () => otherStateCounty)).unresolved).toEqual(['Example']);
  });
  it('supports formal Japanese prefecture/region suffixes and island atolls while keeping unknown city/state names ambiguous', async () => {
    const okinawaRows: Record<string, geo.GeoRecord[]> = {
      'JP:冲绳县': [['1854345', 'Okinawa', 127.93333, 26.5, 'A', 'ADM1', '47', '', 'JP', [['zh-Hans', false, '', '']]]],
      'JP:okinawa': [
        ['1854343', 'Okinawa Shotō', 128.04364, 26.69311, 'T', 'ISLS', '47', '', 'JP', []],
        ['1854345', 'Okinawa', 127.93333, 26.5, 'A', 'ADM1', '47', '', 'JP', []],
        ['1854346', 'Okinawa', 127.94581, 26.50687, 'T', 'ISL', '47', '1858371', 'JP', []],
        ['1894616', 'Okinawa', 127.80139, 26.33583, 'P', 'PPLA2', '47', '1854344', 'JP', []],
      ],
      'UM:midway': [
        ['5854941', 'Midway Atoll National Wildlife Refuge', -177.389, 28.228, 'L', 'RESW', '300', '', 'UM', []],
        ['5854942', 'Midway Atoll', -177.36989, 28.23164, 'T', 'ATOL', '300', '', 'UM', []],
        ['11695313', 'Midway', -177.37515, 28.21222, 'P', 'PPL', '300', '', 'UM', []],
      ],
      'US:honolulu': [
        ['5856195', 'Honolulu', -157.85833, 21.30694, 'P', 'PPLA', 'HI', '003', 'US', []],
        ['other-honolulu', 'Honolulu', -90, 35, 'P', 'PPL', 'AL', '', 'US', []],
      ],
    };
    const lookup = async (name: string, country: string) => okinawaRows[`${country}:${geo.normalizePlace(name)}`] ?? lookupHawaii(name, country);
    expect((await geo.resolveTextPlaces([{ name: '冲绳', aliases: ['Okinawa'], kind: 'admin', country: 'JP' }], '', lookup)).places[0]?.id).toBe('geonames:1854345');
    // Okinawa has a same-name city (PPLA2), so an ambiguous unknown query must not guess the prefecture.
    expect((await geo.resolveTextPlaces([{ name: '冲绳', aliases: ['Okinawa'], kind: 'unknown', country: 'JP' }], '', lookup)).unresolved).toEqual(['冲绳']);
    expect((await geo.resolveTextPlaces([{ name: '中途岛', aliases: ['Midway'], kind: 'island', country: 'UM' }], '', lookup)).places[0]?.id).toBe('geonames:5854942');
    expect((await geo.resolveTextPlaces([{ name: '檀香山', aliases: ['Honolulu'], kind: 'city', country: 'US' }], '夏威夷', lookup)).places[0]?.id).toBe('geonames:5856195');
  });
});

describe('global shard IO and viewport', () => {
  it('reads only the addressed byte range, keeps alias metadata and reuses a shard', async () => {
    const key = 'FR:巴黎', shard = parseInt((await sha256Hex(key)).slice(0, 3), 16);
    const row: geo.GeoRecord = ['2988507', 'Paris', 2.35, 48.85, 'P', 'PPLC', '11', '75', 'FR', [['zh', false, '', '']]];
    const raw = strToU8(JSON.stringify({ [key]: [row] })), compressed = gzipSync(raw);
    const config: geo.GazetteerManifest = { format: 2, shards: 4096, objects: Array.from({ length: 16 }, (_, i) => ({ key: `fixture-${i}` })), ranges: [] };
    config.ranges[shard] = [7, compressed.length, raw.length];
    await env.BOOKS.put(config.objects[shard >> 8]!.key, new Uint8Array([...new Uint8Array(7), ...compressed, 0, 0]));
    const get = vi.fn((...args: Parameters<R2Bucket['get']>) => env.BOOKS.get(...args));
    const lookup = geo.gazetteerLookup({ get } as unknown as R2Bucket, config);
    expect(await lookup('巴黎', 'FR')).toEqual([row]);
    expect(await lookup('巴黎', 'FR')).toEqual([row]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]).toEqual([config.objects[shard >> 8]!.key, { range: { offset: 7, length: compressed.length } }]);
    expect(await lookup('巴黎', 'invalid')).toEqual([]);
  });
  it('fits international date-line and polar locations with valid extents', () => {
    const pacific = textMapExtent([[179, 40], [-179, 42]]);
    expect(pacific.bounds[1][0] - pacific.bounds[0][0]).toBeLessThan(3);
    expect(pacific.center[0]).toBe(-180);
    for (const lat of [-90, 90]) {
      const result = textMapExtent([[0, lat]]);
      expect(result.bounds[1][1]).toBeGreaterThan(result.bounds[0][1]);
      expect(Math.abs(result.center[1])).toBeLessThanOrEqual(85);
    }
  });
});
