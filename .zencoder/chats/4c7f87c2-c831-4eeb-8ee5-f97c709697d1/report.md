# Skinora — Final Implementation Report

## What Was Implemented

Skinora is a full-stack Minecraft skin browsing website built from scratch. The following systems were implemented across Steps 1–9:

### Stack
- **Astro 4 (TypeScript)** with SSR via `@astrojs/netlify` adapter
- **Tailwind CSS** (`@astrojs/tailwind`) for styling
- **Turso / libSQL + Drizzle ORM** for database (local file `local.db` for dev; Turso URL in prod)
- **skinview3d** for 3D skin preview on detail pages
- **sharp** (ingest-only) for texture validation and avatar rendering
- Deployed target: **Netlify** (Functions / SSR)

### Pages & Routes
| Route | Description |
|---|---|
| `/` | Home — recent skins + tag cloud + ad slots |
| `/random` | Random skin grid with JavaScript-powered Refresh |
| `/skin/[slug]` | Detail page — 3D viewer (skinview3d island), metadata, tags, JSON-LD |
| `/tag/[tag]` | Paginated grid by tag; 404 for unknown tags |
| `/contact` | Contact / DMCA takedown info |
| `/privacy` | Privacy policy |
| `/ad-preferences` | Ad preferences |
| `/robots.txt` | Allows crawl, references sitemap index |
| `/sitemap-index.xml` | Sitemap index (chunked by 5000 URLs) |
| `/sitemap/[page].xml` | Chunked skin URL sitemap |
| `/api/avatar/[slug].png` | Avatar PNG served from DB blob |
| `/api/texture/[slug].png` | Raw skin PNG served from DB blob |
| `/api/random.json` | Random set of skins (JSON, no-store) |

### Data Pipeline
- Ingestion script (`scripts/ingest.ts`) resolves usernames via Mojang bulk API, downloads textures, deduplicates by SHA-256, renders face avatars with sharp, extracts dominant-color tags via pixel bucketing, generates auto-descriptions, and upserts to DB.
- 15 skins ingested into `local.db` (Notch, Grian, Dream, Technoblade, TommyInnit, jeb_, Dinnerbone, Wilbur_Soot, Ph1LzA, PhilzA, Hypixel, xNestorio, Skeppy, BadBoyHalo, Fundy).

### UI Components
- `BaseLayout.astro`, `Header.astro`, `Footer.astro` — shell with nav and legal links
- `Seo.astro` — title, description, canonical, OG/Twitter, optional JSON-LD slot
- `AdSlot.astro` — network-agnostic; renders AdSense `<ins>` or labeled placeholder (CLS-stable)
- `SkinCard.astro`, `SkinGrid.astro` (interleaves ads every N cards), `Pagination.astro`
- `SkinViewer.astro` — lazy 3D viewer backed by `src/scripts/skin-viewer.ts`

### SEO Infrastructure
- Stable slugs (`{username}-{hash8}`) in all canonical URLs
- Per-page OG + Twitter cards; JSON-LD `ImageObject` on skin detail pages
- Sitemap index + chunked child sitemaps built from live DB slugs

---

## How the Solution Was Tested

### Automated Gates (all clean)
```
npm run check  → astro check: 0 errors, 0 warnings (38 files)
npm run lint   → ESLint: 0 errors
npm run build  → Astro/Netlify build: Complete
```

### Smoke Tests (via `npm run dev`, curl on localhost:4321)

| Route | Status | Content-Type | Cache-Control |
|---|---|---|---|
| `/` | 200 | text/html | — |
| `/random` | 200 | text/html | — |
| `/skin/grian-fd82a31b` | 200 | text/html | — |
| `/skin/nonexistent-slug` | **404** | text/html | — |
| `/tag/classic` | 200 | text/html | — |
| `/tag/nonexistent-tag` | **404** | text/html | — |
| `/contact` | 200 | text/html | — |
| `/privacy` | 200 | text/html | — |
| `/ad-preferences` | 200 | text/html | — |
| `/robots.txt` | 200 | text/plain | max-age=86400 |
| `/sitemap-index.xml` | 200 | application/xml | max-age=3600 |
| `/sitemap/0.xml` | 200 | application/xml | max-age=3600 |
| `/api/avatar/grian-fd82a31b.png` | 200 | image/png | public, max-age=31536000, immutable |
| `/api/texture/grian-fd82a31b.png` | 200 | image/png | public, max-age=31536000, immutable |
| `/api/avatar/nonexistent.png` | **404** | — | — |
| `/api/texture/nonexistent.png` | **404** | — | — |
| `/api/random.json` | 200 | application/json | no-store |

**Skin detail page verified:**
- `<title>`, `<meta name="description">`, `<link rel="canonical">` ✓
- `og:title`, `og:description`, `og:image` (avatar endpoint), `og:url` ✓
- `twitter:card`, `twitter:title`, `twitter:image` ✓
- JSON-LD `ImageObject` with `contentUrl`, `thumbnailUrl`, `datePublished`, `keywords` ✓

**Sitemap verified:** `/sitemap/0.xml` lists all 15 skin URLs with real slugs.

**Footer verified:** `/contact`, `/privacy`, `/ad-preferences` all linked from footer.

**Ad slots verified:** Placeholder `<div class="ad-placeholder">` rendered when `PUBLIC_ADSENSE_CLIENT` is not set (no CLS impact).

---

## Biggest Issues / Challenges

### 1. TypeScript in Astro `<script>` blocks — ESLint incompatibility
The most significant technical challenge was that `astro-eslint-parser` v1.4.0 treats unattributed `<script>` blocks as JavaScript (not TypeScript) when passing content to `@typescript-eslint/parser`, despite the `parserOptions.parser` configuration. This caused ESLint "Parsing error: Unexpected token" failures for TypeScript syntax (type annotations, `as` casts).

Adding `lang="ts"` to `<script>` tags makes Astro treat them as inline (disabling TypeScript and npm import processing) — so that was not viable either.

**Resolution:** Extracted all browser TypeScript logic from Astro `<script>` blocks into dedicated `.ts` modules (`src/scripts/skin-viewer.ts`, `src/scripts/random-refresh.ts`) and imported them from plain `<script>` blocks. The `.ts` files are handled by ESLint's `*.ts` override with `@typescript-eslint/parser`, and Astro/Vite correctly bundles the imports.

### 2. HEAD method not auto-derived from GET in Astro SSR
Astro SSR endpoints only expose the HTTP methods explicitly exported. Exporting only `GET` caused HEAD requests to return 404 for image endpoints.

**Resolution:** Added explicit `HEAD` exports to `src/pages/api/avatar/[slug].png.ts` and `src/pages/api/texture/[slug].png.ts`, returning empty bodies with the correct `Content-Type` and `Cache-Control` headers.

### 3. Mojang API rate-limiting during ingestion
During Step 3 ingestion, the Mojang `sessionserver` endpoint occasionally returned 429 or timed out. The pipeline's exponential backoff and concurrency limiting (p-limit, configurable delay) handled this, though initial runs needed careful pacing.

### 4. `sharp` binary compatibility (Windows dev)
`sharp` uses native binaries. On Windows with Node 18, the `@img/sharp-win32-x64` prebuilt binary was required. This was pulled automatically by npm but required verifying the correct platform binary was present before the ingest script could run.

### 5. Skinview3d WebGL in Astro island
The `skinview3d` viewer requires a `<canvas>` element and WebGL. Astro's `client:visible` / IntersectionObserver pattern ensured the 3D viewer only initializes when the canvas is in the viewport, avoiding unnecessary WebGL context creation on page load. The viewer loads the skin via the `/api/texture/[slug].png` endpoint after initialization.
