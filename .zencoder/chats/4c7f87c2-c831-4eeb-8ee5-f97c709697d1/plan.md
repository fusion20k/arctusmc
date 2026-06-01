# Spec and build

## Agent Instructions

Ask the user questions when anything is unclear or needs their input. This includes:

- Ambiguous or incomplete requirements
- Technical decisions that affect architecture or user experience
- Trade-offs that require business context

Do not make assumptions on important decisions — get clarification first.

---

## Workflow Steps

### [x] Step: Technical Specification

Assess the task's difficulty, as underestimating it leads to poor outcomes.

- easy: Straightforward implementation, trivial bug fix or feature
- medium: Moderate complexity, some edge cases or caveats to consider
- hard: Complex logic, many caveats, architectural considerations, or high-risk changes

Create a technical specification for the task that is appropriate for the complexity level:

- Review the existing codebase architecture and identify reusable components.
- Define the implementation approach based on established patterns in the project.
- Identify all source code files that will be created or modified.
- Define any necessary data model, API, or interface changes.
- Describe verification steps using the project's test and lint commands.

Save the output to `c:\Users\david\Desktop\skinora\.zencoder\chats\4c7f87c2-c831-4eeb-8ee5-f97c709697d1/spec.md` with:

- Technical context (language, dependencies)
- Implementation approach
- Source code structure changes
- Data model / API / interface changes
- Verification approach

If the task is complex enough, create a detailed implementation plan based on `c:\Users\david\Desktop\skinora\.zencoder\chats\4c7f87c2-c831-4eeb-8ee5-f97c709697d1/spec.md`:

- Break down the work into concrete tasks (incrementable, testable milestones)
- Each task should reference relevant contracts and include verification steps
- Replace the Implementation step below with the planned tasks

Rule of thumb for step size: each step should represent a coherent unit of work (e.g., implement a component, add an API endpoint, write tests for a module). Avoid steps that are too granular (single function).

Save to `c:\Users\david\Desktop\skinora\.zencoder\chats\4c7f87c2-c831-4eeb-8ee5-f97c709697d1/plan.md`. If the feature is trivial and doesn't warrant this breakdown, keep the Implementation step below as is.

**Stop here.** Present the specification (and plan, if created) to the user and wait for their confirmation before proceeding.

---

## Implementation Plan

Based on `spec.md`. Stack: **Astro 4 (TS) + Tailwind + `@astrojs/netlify` SSR + Turso/libSQL + Drizzle + skinview3d**, hosted on Netlify. Each step is a coherent, independently testable unit. Do the steps in order; later steps depend on earlier ones.

### [x] Step 1: Project scaffold & tooling

Initialize the Astro/TypeScript project and all dev tooling.

- Create `package.json`, `astro.config.mjs` (Netlify adapter, SSR `output: 'server'`), `tsconfig.json` (strict), `netlify.toml`.
- Add integrations: `@astrojs/tailwind` (+ `tailwind.config`), `@astrojs/netlify`.
- Add tooling: ESLint (`eslint-plugin-astro`, TS parser), Prettier (`prettier-plugin-astro`), and npm scripts: `dev`, `build`, `preview`, `check` (`astro check`), `lint`, `ingest`.
- Create `.env.example` with `LIBSQL_URL`, `LIBSQL_AUTH_TOKEN`, `PUBLIC_SITE_URL`, `PUBLIC_ADSENSE_CLIENT`.
- Minimal placeholder `index.astro` to prove the build.

**Verify:** `npm install`, `npm run dev` serves a page, `npm run check` and `npm run build` succeed.

### [x] Step 2: Database layer (schema, client, queries)

Implement the persistence layer per spec §4.

- `src/lib/db/client.ts`: libSQL client driven by env, defaulting to a local file (`file:./local.db`) for testing.
- `src/lib/db/schema.ts`: Drizzle tables `skins`, `tags`, `skin_tags` with indexes/constraints.
- `drizzle.config.ts` + generate migrations into `db/migrations/`; add a `db:migrate` script.
- `src/lib/db/queries.ts`: implement the query contracts (`getRandomSkins`, `getRecentSkins`, `getSkinBySlug`, `getTextureBlob`, `getAvatarBlob`, `getSkinsByTag`, `listTags`, `countSkins`, `getSlugsPage`).

**Verify:** migrations apply to a local libSQL file; a throwaway script inserts + reads a row; `npm run check` passes.

### [x] Step 3: Ingestion pipeline

Implement `scripts/ingest.ts` and shared helpers per spec §2.2.

- `src/lib/colors.ts`: palette + dominant-color bucketing from raw pixels.
- `src/lib/description.ts`: deterministic auto-description generator.
- `scripts/ingest.ts`: seed list → Mojang bulk resolve → profile fetch → texture download → sha256 dedupe → `sharp` validate + face-avatar render → color/model tags → description → upsert (skins + tags + skin_tags). CLI flags `--file`, `--limit`; concurrency limit, delay, exponential backoff; idempotent/resumable.
- `scripts/seed-usernames.txt`: small sample seed list.

**Verify:** `npm run ingest -- --file scripts/seed-usernames.txt --limit 20` populates DB; no duplicate `texture_hash`; tags + joins populated; re-run is a no-op.

### [x] Step 4: Core layout, design system & shared UI components

Build the reusable UI shell per spec §3.

- `BaseLayout.astro`, `Header.astro`, `Footer.astro` (contact/privacy/ad-preferences links).
- `Seo.astro` (title, meta description, canonical, OG/Twitter, optional JSON-LD slot).
- `AdSlot.astro` (network-agnostic; AdSense `<ins>` when `PUBLIC_ADSENSE_CLIENT` set, else labeled placeholder; CLS-stable).
- `SkinCard.astro`, `SkinGrid.astro` (interleaves `AdSlot` every N cards), `Pagination.astro`.
- Tailwind theme/base styles for a clean, professional look.

**Verify:** a temporary demo page renders header/footer/grid/ad placeholder with no console errors; `check` + `lint` pass.

### [x] Step 5: Image & data endpoints

Implement serving endpoints per spec §5.

- `src/pages/api/texture/[slug].png.ts` — raw skin PNG blob, immutable cache, 404 on miss.
- `src/pages/api/avatar/[slug].png.ts` — avatar PNG blob, immutable cache, 404 on miss.
- `src/pages/api/random.json.ts` — JSON random set, `no-store`.

**Verify:** endpoints return correct `Content-Type`, valid PNG bytes, expected cache headers, and 404 for unknown slugs.

### [x] Step 6: Primary pages (home, /random, /skin/[slug], /tag/[tag])

Wire pages to DB queries, ads, and SEO.

- `index.astro`: recent + random teaser + ad slots.
- `random.astro`: random grid + **Refresh** (island/script hitting `/api/random.json`, full-reload fallback).
- `skin/[slug].astro`: `skinview3d` island (`client:visible`, fetches texture endpoint), metadata, auto description, tag links, ad slots, JSON-LD `ImageObject`; 404 on unknown slug.
- `tag/[tag].astro`: paginated grid via `getSkinsByTag`; empty/404 for unknown tag.

**Verify:** navigate all routes; 3D viewer rotates; Refresh swaps skins; pagination works; meta/OG/JSON-LD present; `check` + `lint` pass.

### [x] Step 7: Footer / legal pages

Static content pages.

- `contact.astro` (incl. takedown/contact path), `privacy.astro`, `ad-preferences.astro`.

**Verify:** all three render and are linked from the footer.

### [x] Step 8: SEO infrastructure (robots + sitemaps)

Make the catalog crawlable at scale per spec §2.5.

- `robots.txt.ts` (allow crawl, reference sitemap index).
- `sitemap-index.xml.ts` + `sitemap/[page].xml.ts` (chunked ≤5000 URLs, built from DB slugs).
- Confirm canonical URLs use `PUBLIC_SITE_URL`.

**Verify:** `/robots.txt`, `/sitemap-index.xml`, `/sitemap/0.xml` are valid XML and list real skin URLs.

### [x] Step 9: Final verification, polish & report

End-to-end hardening.

1. Run `npm run check`, `npm run lint`, `npm run build` — all clean.
2. `npm run preview` and execute the full manual smoke checklist (spec §6).
3. Confirm cache headers, no console errors, CLS-stable ad slots.
4. Write a report to `c:\Users\david\Desktop\skinora\.zencoder\chats\4c7f87c2-c831-4eeb-8ee5-f97c709697d1/report.md` describing:
   - What was implemented
   - How the solution was tested
   - The biggest issues or challenges encountered
