import { gunzipSync } from 'fflate';
import type { TextAtlasPlace, TextAtlasResult } from '../../../shared/textAtlas';
import { sha256Hex, HttpError } from '../lib/util';
import manifest from './data/text-gazetteer.json';
import { alternateHanSpellings } from './hanSpellings';

export const TEXT_RESOLVER_VERSION = 8;
const MOUNTAIN_CODES = ['MT', 'MTS', 'PK', 'VLC'];
const ISLAND_CODES = ['ISL', 'ISLS', 'ATOL', 'ISLX'];
const STATE_COUNTRIES = new Set(['US', 'AU', 'DE', 'AT', 'CH', 'BR', 'MX', 'IN', 'MY', 'MM', 'FM', 'NG', 'ET', 'VE', 'RU']);
const BARE_HAN_NAME = /^\p{Script=Han}{2,}$/u;
const FORMAL_PLACE_SUFFIX = /[州省市县縣区區道府郡乡鄉镇鎮村岛島群山峰岭嶺河江海港湾灣关關]$/;

/** Refresh affected legacy results only after explicit generation consent. */
export function reusableTextResult(result: TextAtlasResult, resolverVersion?: number) {
  const hasMountainFix = resolverVersion !== undefined && resolverVersion >= 2 && resolverVersion < TEXT_RESOLVER_VERSION;
  return resolverVersion === TEXT_RESOLVER_VERSION || (result.status === 'ready' && !result.unresolved.length
    && !!result.map && (hasMountainFix || result.map.places.every(p => !MOUNTAIN_CODES.includes(p.featureCode))));
}

// Alias metadata: language code, historical flag, valid-from, valid-to (source strings).
export type GeoAlias = [string, boolean, string, string];
export type GeoRecord = [string, string, number, number, string, string, string, string, string, GeoAlias[]];
export type PlaceKind = 'pass' | 'city' | 'settlement' | 'admin' | 'island' | 'mountain' | 'mountain_range' | 'river' | 'site' | 'unknown';
export interface PlaceQuery { name: string; aliases: string[]; kind: PlaceKind; country: string }
export const normalizePlace = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const nameVariants = (name: string, query: PlaceQuery) => {
  // GeoNames may list only the formal 市 name for a Chinese city. Treat its
  // short/formal spelling as one name group, not contradictory alias evidence.
  if (query.country !== 'CN' || query.kind !== 'city' || !/^\p{Script=Han}{2,}$/u.test(name) || /[县縣区區省乡鄉镇鎮村]$/.test(name)) return [name];
  return [name, name.endsWith('市') ? name.slice(0, -1) : `${name}市`];
};
export interface GazetteerManifest {
  format: number; shards: number; objects: { key: string }[]; ranges: number[][];
}
export const MAX_GAZETTEER_SHARD_BYTES = 4 * 1024 * 1024;

export function gazetteerLookup(bucket: R2Bucket, config: GazetteerManifest = manifest) {
  // A small request-local cache bounds memory even when a passage names many places.
  const cache = new Map<number, Promise<Record<string, GeoRecord[]>>>();
  return async (name: string, country: string): Promise<GeoRecord[]> => {
    const normalized = normalizePlace(name);
    if (!normalized || !/^[A-Z]{2}$/.test(country)) return [];
    const key = `${country}:${normalized}`, shard = parseInt((await sha256Hex(key)).slice(0, 3), 16);
    let pending = cache.get(shard);
    if (!pending) {
      pending = (async () => {
        const range = config.ranges[shard], pack = config.objects[shard >> 8];
        if (config.format !== 2 || config.shards !== 4096 || !range || !pack || range[2]! > MAX_GAZETTEER_SHARD_BYTES) {
          throw new HttpError(503, 'gazetteer_unavailable', '地名库暂不可用，请稍后重试。');
        }
        const [offset, length, rawLength] = range;
        const object = await bucket.get(pack.key, { range: { offset, length } });
        if (!object) throw new HttpError(503, 'gazetteer_unavailable', '地名库暂不可用，请稍后重试。');
        const compressed = new Uint8Array(await object.arrayBuffer());
        if (compressed.length !== length) throw new HttpError(503, 'gazetteer_unavailable', '地名库暂不可用，请稍后重试。');
        const raw = gunzipSync(compressed, { out: new Uint8Array(rawLength!) });
        return JSON.parse(new TextDecoder().decode(raw));
      })();
      cache.set(shard, pending);
      if (cache.size > 2) cache.delete(cache.keys().next().value!);
    }
    return (await pending)[key] ?? [];
  };
}

const compatible = (r: GeoRecord, kind: PlaceKind) => {
  switch (kind) {
    case 'pass': return r[5] === 'PASS';
    case 'city': case 'settlement': return r[4] === 'P';
    case 'admin': return r[4] === 'A';
    case 'island': return r[4] === 'T' && ISLAND_CODES.includes(r[5]);
    case 'mountain': return MOUNTAIN_CODES.includes(r[5]);
    case 'mountain_range': return r[5] === 'MTS';
    case 'river': return ['STM', 'STMS'].includes(r[5]);
    case 'site': return r[4] === 'S';
    default: return true;
  }
};
const distance = (a: [number, number], b: [number, number]) => {
  const rad = Math.PI / 180, lat = (b[1] - a[1]) * rad, lon = (b[0] - a[0]) * rad;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(Math.sin(lat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(lon / 2) ** 2)));
};

type PlaceLookup = (name: string, country: string) => Promise<GeoRecord[]>;

function adminSuffixes(country: string) {
  if (country === 'JP') return ['县', '府'];
  return STATE_COUNTRIES.has(country) ? ['州', '省'] : ['省', '州'];
}

async function lookupNameGroup(names: string[], country: string, lookup: PlaceLookup, allowHanFallback = true) {
  const matches = new Map<string, GeoRecord>(), formalCityRows: GeoRecord[] = [];
  const collect = async (spellings: Iterable<string>) => {
    for (const spelling of spellings) {
      for (const row of await lookup(spelling, country)) {
        if (row[8] !== country) continue;
        matches.set(row[0], row);
        if (spelling.endsWith('市')) formalCityRows.push(row);
      }
    }
  };
  await collect(names);
  if (matches.size || !allowHanFallback) return { matches, formalCityRows, converted: false };
  await collect(new Set(names.flatMap(name => alternateHanSpellings(normalizePlace(name)))));
  return { matches, formalCityRows, converted: matches.size > 0 };
}

/** Try formal Han administrative suffixes when GeoNames omits the short Chinese state/province spelling. */
async function lookupAdminSuffixes(name: string, country: string, lookup: PlaceLookup, allowHanFallback: boolean, accept: (rows: GeoRecord[]) => boolean) {
  const base = normalizePlace(name);
  if (!BARE_HAN_NAME.test(base) || FORMAL_PLACE_SUFFIX.test(base)) return null;
  for (const suffix of adminSuffixes(country)) {
    const group = await lookupNameGroup([`${base}${suffix}`], country, lookup, allowHanFallback);
    if (accept([...group.matches.values()])) return group;
  }
  return null;
}

/** Name/type/region constraints precede proximity. Never invent a coordinate. */
export async function resolveTextPlaces(queries: PlaceQuery[], region: string, lookup: PlaceLookup) {
  const places: TextAtlasPlace[] = [], unresolved: string[] = [];
  const regions = new Map<string, { code?: string; converted: boolean }>();
  const deferred: { query: PlaceQuery; rows: GeoRecord[] }[] = [];
  const add = (query: PlaceQuery, r: GeoRecord) => {
    if (places.some(p => p.id === `geonames:${r[0]}`)) return;
    places.push({ id: `geonames:${r[0]}`, name: query.name, modernName: r[1], coordinates: [r[2], r[3]], imagePoint: null,
      source: 'GeoNames', sourceUrl: `https://www.geonames.org/${r[0]}/`, featureCode: r[5], countryCode: r[8],
      historicalAlias: r[9].length > 0 && r[9].every(a => a[1]),
    });
  };
  for (const query of queries) {
    if (region && !regions.has(query.country)) {
      const adm1Lookup = async (name: string, country: string) => (await lookup(name, country)).filter(r => r[5] === 'ADM1');
      let { matches, converted } = await lookupNameGroup([region], query.country, adm1Lookup);
      if (!matches.size) {
        const fallback = await lookupAdminSuffixes(region, query.country, adm1Lookup, true, rows => rows.length > 0);
        if (fallback) ({ matches, converted } = fallback);
      }
      regions.set(query.country, { code: matches.size === 1 ? matches.values().next().value![6] : undefined, converted });
    }
    const matchedRegion = regions.get(query.country);
    const admin1 = matchedRegion?.code;
    let candidates: Map<string, GeoRecord> | undefined;
    let formalCityRows: GeoRecord[] = [];
    let usedHanSpelling = matchedRegion?.converted ?? false;
    let sourceMatchedExactly = false;
    let exactSourceMissing = false;
    for (const name of [...new Set([query.name, ...query.aliases])]) {
      const variants = nameVariants(name, query);
      // A model alias may still narrow an exact source name using its own exact
      // spelling. A speculative conversion of that alias should never overturn it.
      const group = await lookupNameGroup(variants, query.country, lookup, !sourceMatchedExactly);
      if (name === query.name && !group.matches.size) exactSourceMissing = true;
      if (name === query.name && query.kind === 'admin' && ![...group.matches.values()].some(r => compatible(r, 'admin'))) {
        const fallback = await lookupAdminSuffixes(name, query.country, lookup, !sourceMatchedExactly, rows => rows.some(r => compatible(r, 'admin')));
        if (fallback) {
          for (const [id, row] of fallback.matches) group.matches.set(id, row);
          group.converted ||= fallback.converted;
        }
      }
      const { matches, converted } = group;
      if (!matches.size) continue;
      if (name === query.name) {
        sourceMatchedExactly = !converted;
        if (variants.length === 2) formalCityRows = group.formalCityRows;
      }
      usedHanSpelling ||= converted;
      // A translation may narrow an ambiguous name, but never broaden or replace an exact match.
      candidates = candidates ? new Map([...candidates].filter(([id]) => matches.has(id))) : matches;
    }
    // When an unqualified Han name has no exact entry (e.g. GeoNames only lists its 州/省/县 form)
    // and non-settlement alias candidates still disagree, intersect with its formal admin name.
    if (query.kind === 'unknown' && exactSourceMissing && candidates && candidates.size > 1
      && ![...candidates.values()].some(r => r[4] === 'P')) {
      const existing = candidates;
      const fallback = await lookupAdminSuffixes(query.name, query.country, lookup, !usedHanSpelling,
        rows => rows.some(r => existing.has(r[0])));
      if (fallback) {
        candidates = new Map([...existing].filter(([id]) => fallback.matches.has(id)));
        usedHanSpelling ||= fallback.converted;
      }
    }
    // Intersect names before type/region filtering: a recognized but incompatible alias
    // is contradictory evidence, not an absent name that can silently be ignored.
    let rows = [...(candidates?.values() ?? [])].filter(r => compatible(r, query.kind) && (!admin1 || r[6] === admin1)
      && !(query.country === 'CN' && query.kind === 'admin' && /[县縣]$/.test(query.name) && r[5] !== 'ADM3'));
    // A script fallback needs a unique candidate supported by aliases, type and any
    // supplied province. Administrative prominence and nearby pins cannot break its ties.
    if (usedHanSpelling && (rows.length > 1 || (region && !admin1))) rows = [];
    // Only an explicitly identified city may prefer an administrative seat over
    // same-name villages. Peer seats remain ambiguous; population never breaks ties.
    if (query.kind === 'city') {
      // Some real Chinese cities have only PPL, just like same-name villages.
      // A formal 市 alias plus a unique ADM2 with matching jurisdiction codes
      // can identify one such city, but never override alias/region constraints
      // or rank competing administrative seats.
      if (query.country === 'CN' && rows.length > 1 && rows.every(r => r[5] === 'PPL')) {
        const municipalities = formalCityRows.filter(r => r[5] === 'ADM2' && r[6] && r[7] && (!admin1 || r[6] === admin1));
        if (municipalities.length === 1) {
          const municipality = municipalities[0]!;
          const formalIds = new Set(formalCityRows.filter(r => r[4] === 'P').map(r => r[0]));
          const cities = rows.filter(r => formalIds.has(r[0]) && r[6] === municipality[6] && r[7] === municipality[7]);
          if (cities.length === 1) rows = cities;
        }
      }
      const seats = rows.filter(r => /^(PPLC|PPLA[2-5]?)$/.test(r[5]));
      if (seats.length) rows = seats;
      // For an explicit Chinese city, distinguish municipal/prefecture seats
      // from same-name county/township seats. Province/alias constraints already
      // apply; competing cities stay ambiguous, and lower seats remain usable
      // when there is no matching city (including county-level cities).
      if (query.country === 'CN') {
        const cities = rows.filter(r => /^(PPLC|PPLA|PPLA2)$/.test(r[5]));
        if (cities.length) rows = cities;
      }
      // A municipality and its nearby district seat can share the city's alias.
      // Prefer the parent only with matching jurisdiction codes and proximity;
      // unrelated cities, peers, and missing hierarchy evidence remain ambiguous.
      const parents = rows.filter(r => r[5] === 'PPLA2' && r[6] && r[7]);
      const parent = parents.length === 1 ? parents[0]! : undefined;
      if (parent && rows.every(r => r[0] === parent[0] || (
        /^PPLA[3-5]$/.test(r[5]) && r[8] === parent[8] && r[6] === parent[6] && r[7] === parent[7]
        && distance([parent[2], parent[3]], [r[2], r[3]]) <= 25
      ))) rows = [parent];
    } else if (query.kind === 'admin' && !/[县縣区區市郡]$/.test(query.name)
      && ![query.name, ...query.aliases].some(n => /\b(?:county|district|parish|borough|prefecture|city)\b/i.test(n))) {
      // A first-level state/province and its subordinate county/district can share an unqualified name.
      // Prefer the ADM1 only when every remaining candidate is a subordinate division inside it with a distinct canonical name.
      const parents = rows.filter(r => r[5] === 'ADM1' && r[6]);
      const parent = parents.length === 1 ? parents[0]! : undefined;
      if (parent && rows.every(r => r[0] === parent[0] || (
        /^ADM[2-5]$/.test(r[5]) && r[8] === parent[8] && r[6] === parent[6]
        && normalizePlace(r[1]) !== normalizePlace(parent[1])
      ))) rows = [parent];
    }
    if (rows.length === 1) add(query, rows[0]!);
    else deferred.push({ query, rows });
  }
  // Only unambiguous first-pass matches in the same country are anchors.
  const anchors = [...places];
  for (const { query, rows } of deferred) {
    const nearby = anchors.filter(p => p.countryCode === query.country);
    const ranked = nearby.length ? rows.map(r => ({ r, d: Math.min(...nearby.map(a => distance(a.coordinates, [r[2], r[3]]))) })).sort((a, b) => a.d - b.d) : [];
    const nearest = ranked[0];
    if (nearest && nearest.d <= 50 && ranked[1] && ranked[1].d - nearest.d >= 25) add(query, nearest.r);
    else unresolved.push(query.name);
  }
  return { places, unresolved: [...new Set(unresolved)] };
}
