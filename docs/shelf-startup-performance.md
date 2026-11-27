# Shelf startup and font loading

A signed-out first visit used to load the reader/editor dependency graph, create a
WebGL scene, then wait for `/api/auth/me` and `/api/auth/providers` in sequence before
showing the bundled sample books. Slow cross-border transfers amplify that chain.
The default Wenkai face was also a single 7,231,496-byte WOFF2, even for a short sample.

## Changes

- Render sample cards while authentication is pending, without selecting a storage
  account or issuing book writes. The authenticated library replaces that preview
  after the session is verified. Auth lookup has an eight-second deadline; the
  existing local fallback handles failure. A private book deep link still requires
  authentication and retains its URL.
- Fetch login providers when the form is displayed, without delaying the shelf or
  the form itself. Provider requests also have an eight-second deadline.
- Load `ReaderWorkspace`, EPUB preparation, and layout/font modules on book open.
  Await scene readiness before installing the prepared book. A failed reader chunk
  presents a retry action instead of a blank application. Keep the scene mounted
  after its first use to preserve reading/navigation behavior.
- Use small static captures of the existing desk backgrounds before WebGL starts.
  `generate-shelf-backgrounds.mjs` reproduces them from the application's own renderer.
- Subset the exact existing Wenkai 500 font into Unicode faces. Keep Latin shaping
  characters together; use the pinned Noto Serif SC Unicode partitions for commonly
  used characters, and bounded extra subsets for all remaining original code points.
  Noto font binaries are not reused. Every original mapped character is covered;
  generation verifies horizontal metrics against the original font.
- Font downloads share an eight-request queue and an in-flight/success cache. Each
  transfer, including its response body, has a 30-second deadline and one retry for transient
  failures. Failed entries are evicted; successful subsets remain cached. The whole
  multi-subset font no longer has a single 30-second download deadline. Stylesheet
  imports retain a 30-second deadline. Pagination still waits for the requested font.
  Font CSS parsing also preserves semicolons in Vite-inlined data URLs.
- Give only Vite's content-hashed `/assets/*` immutable browser caching. HTML, auth,
  and private book responses do not inherit that rule.

## Verification

Production build static import graph (entry plus App; not all optional chunks):

| | Before | After |
| --- | ---: | ---: |
| JavaScript, uncompressed | 1,805,060 bytes | approximately 422 KB |
| JavaScript, gzip | 527,706 bytes | approximately 133 KB |
| Chinese sample Wenkai transfer | 7,231,496 bytes | approximately 891 KB / 18 subsets |

A browser comparison against the previous production build found identical page
objects and chapter start positions for the Chinese sample (16 pages) and the
English sample (202 pages).

These are build/browser fixture measurements, not mainland-China latency claims.
The font-transfer fixture deliberately fails one subset with HTTP 503 and verifies
that the requested font eventually loads. Generated subsets preserve all 30,142
original mapped code points; each file is at most 128,028 bytes. The full distributed
subset set is larger than the monolithic font (~9 MB), but readers fetch only needed
subsets. Rare-character-heavy books can require more of the set.

Checks (set `PUPPETEER_CORE` and `CHROME_BIN` as needed):

```sh
npm --prefix web run build -- --manifest
npm --prefix web run preview -- --host 127.0.0.1 --port 5202
READER_URL=http://127.0.0.1:5202 node web/scripts/check-shelf-startup.mjs
READER_URL=http://127.0.0.1:5202 node web/scripts/check-font-recovery.mjs
READER_URL=http://127.0.0.1:5202/shelf node web/scripts/check-shelf-samples.mjs
READER_URL=http://127.0.0.1:5202/shelf node web/scripts/check-shelf-loading.mjs
READER_URL=http://127.0.0.1:5202/shelf node web/scripts/check-shelf-recent.mjs
READER_URL=http://127.0.0.1:5202/shelf node web/scripts/check-login-consent.mjs
node --experimental-strip-types --test web/src/book/fontDownloads.test.ts web/src/book/wenkaiSubsets.test.ts web/src/book/fontCatalog.test.ts web/src/route/bookPath.test.ts web/src/route/entry.test.ts
node web/scripts/check-i18n-source.mjs
npm --prefix web run lint
```

All browser fixtures mock authentication and cloud data; they do not send emails,
write to real accounts, or invoke paid AI calls.

## Font regeneration

Runtime/build consumers do not need Python. Generated WOFF2 files and CSS are
checked in with the original SIL OFL license. To regenerate after updating fonts:

```sh
python3 -m venv /tmp/reader-font-tools-venv
/tmp/reader-font-tools-venv/bin/pip install fonttools==4.61.1 brotli==1.2.1
/tmp/reader-font-tools-venv/bin/python web/scripts/subset-wenkai.py
```

`src/assets/wenkai/manifest.json` records the source font SHA-256 and coverage/size
figures. The script uses versions pinned by the web lockfile and verifies every
assigned character's advance width and side bearing before writing the final CSS.
