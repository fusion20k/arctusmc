import { chromium, type Browser, type Page } from "playwright";
import { desc, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { db } from "../src/lib/db/client.js";
import { skins } from "../src/lib/db/schema.js";

const WIDTH = 320;
const HEIGHT = 640;
const TARGET_SLUG = "ms-9ada191d";
const RECENT_LIMIT = 3;

type Rect = { left: number; top: number; width: number; height: number };

type TargetRow = {
  id: number;
  slug: string;
  model: string;
  texture: Uint8Array;
  avatar: Uint8Array;
};

function getLayer1BodyRects(height: number): Rect[] {
  const common: Rect[] = [
    { left: 16, top: 16, width: 24, height: 16 },
    { left: 0, top: 16, width: 16, height: 16 },
    { left: 40, top: 16, width: 16, height: 16 },
  ];
  if (height === 64) {
    return [
      ...common,
      { left: 16, top: 48, width: 16, height: 16 },
      { left: 32, top: 48, width: 16, height: 16 },
    ];
  }
  return common;
}

async function normalizeLayer1BodyAlpha(textureBytes: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(textureBytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== 64 || (info.height !== 64 && info.height !== 32)) {
    return textureBytes;
  }

  const patched = Buffer.from(data);
  const rects = getLayer1BodyRects(info.height);

  for (const rect of rects) {
    for (let y = rect.top; y < rect.top + rect.height; y++) {
      for (let x = rect.left; x < rect.left + rect.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        if (patched[idx + 3]! < 255) {
          if (patched[idx] === 0 && patched[idx + 1] === 0 && patched[idx + 2] === 0) {
            patched[idx] = 56;
            patched[idx + 1] = 56;
            patched[idx + 2] = 56;
          }
          patched[idx + 3] = 255;
        }
      }
    }
  }

  return sharp(patched, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  })
    .png()
    .toBuffer();
}

const VIEWER_HTML = `<!doctype html>
<html><head><meta charset="utf-8" />
<style>html,body{margin:0;background:transparent;}canvas{display:block;background:transparent;}</style>
</head><body>
<canvas id="c" width="${WIDTH}" height="${HEIGHT}"></canvas>
<script type="module">
import { SkinViewer } from "https://esm.sh/skinview3d@3.4.2";

const viewer = new SkinViewer({
  canvas: document.getElementById("c"),
  width: ${WIDTH},
  height: ${HEIGHT},
  preserveDrawingBuffer: true,
  alpha: true,
  background: null,
  renderPaused: true,
});
viewer.renderer.setClearColor(0x000000, 0);
viewer.autoRotate = false;
viewer.fov = 35;
viewer.zoom = 0.78;
viewer.playerObject.rotation.y = Math.PI / 12;
viewer.globalLight.intensity = 3;
viewer.cameraLight.intensity = 0.6;

window.__renderSkin = async (base64, model) => {
  const url = "data:image/png;base64," + base64;
  const sv3dModel = model === 'slim' ? 'slim' : 'default';
  await viewer.loadSkin(url, { model: sv3dModel });
  viewer.render();
  await new Promise((r) => requestAnimationFrame(r));
  viewer.render();
  await new Promise((r) => requestAnimationFrame(r));
  viewer.render();
  return document.getElementById("c").toDataURL("image/png");
};

window.__viewerReady = true;
</script></body></html>`;

async function newViewerPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await ctx.newPage();
  await page.setContent(VIEWER_HTML, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { __viewerReady?: boolean }).__viewerReady === true, {
    timeout: 30000,
  });
  return page;
}

async function renderOne(
  page: Page,
  textureBytes: Buffer,
  model: "classic" | "slim",
): Promise<Buffer> {
  const normalizedTexture = await normalizeLayer1BodyAlpha(textureBytes);
  const base64 = normalizedTexture.toString("base64");
  const dataUrl = await page.evaluate(
    async ([b64, m]) => {
      const fn = (window as unknown as {
        __renderSkin: (b: string, m: string) => Promise<string>;
      }).__renderSkin;
      return fn(b64, m);
    },
    [base64, model] as const,
  );
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return Buffer.from(b64, "base64");
}

function safeSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function getPngInfo(buf: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buf).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

async function analyzeRenderedBodyRegion(buf: Buffer): Promise<{
  bodyRect: Rect;
  avgColor: { r: number; g: number; b: number };
  blackFraction: number;
}> {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * info.channels;
      const a = data[idx + 3] ?? 0;
      if (a > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      bodyRect: { left: 0, top: 0, width: info.width, height: info.height },
      avgColor: { r: 0, g: 0, b: 0 },
      blackFraction: 0,
    };
  }

  const bbox: Rect = {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };

  const bodyRect: Rect = {
    left: bbox.left + Math.floor(bbox.width * 0.35),
    top: bbox.top + Math.floor(bbox.height * 0.30),
    width: Math.max(1, Math.floor(bbox.width * 0.30)),
    height: Math.max(1, Math.floor(bbox.height * 0.28)),
  };

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let bodyCount = 0;

  let blackCount = 0;
  let nonTransparentCount = 0;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * info.channels;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      const a = data[idx + 3] ?? 0;

      if (a > 0) {
        nonTransparentCount++;
        if (r === 0 && g === 0 && b === 0) blackCount++;
      }

      if (
        x >= bodyRect.left &&
        x < bodyRect.left + bodyRect.width &&
        y >= bodyRect.top &&
        y < bodyRect.top + bodyRect.height &&
        a > 0
      ) {
        sumR += r;
        sumG += g;
        sumB += b;
        bodyCount++;
      }
    }
  }

  return {
    bodyRect,
    avgColor: {
      r: bodyCount ? sumR / bodyCount : 0,
      g: bodyCount ? sumG / bodyCount : 0,
      b: bodyCount ? sumB / bodyCount : 0,
    },
    blackFraction: nonTransparentCount ? blackCount / nonTransparentCount : 0,
  };
}

async function compareImages(rendered: Buffer, dbAvatar: Buffer): Promise<{ sameDimensions: boolean; equalPixels: boolean; diffFraction: number }> {
  const r = await sharp(rendered).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const d = await sharp(dbAvatar).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const sameDimensions = r.info.width === d.info.width && r.info.height === d.info.height;
  if (!sameDimensions) {
    return { sameDimensions, equalPixels: false, diffFraction: 1 };
  }

  let diff = 0;
  const pixelCount = r.info.width * r.info.height;
  for (let i = 0; i < pixelCount; i++) {
    const ri = i * r.info.channels;
    const di = i * d.info.channels;
    if (
      r.data[ri] !== d.data[di] ||
      r.data[ri + 1] !== d.data[di + 1] ||
      r.data[ri + 2] !== d.data[di + 2] ||
      r.data[ri + 3] !== d.data[di + 3]
    ) {
      diff++;
    }
  }

  return {
    sameDimensions,
    equalPixels: diff === 0,
    diffFraction: pixelCount ? diff / pixelCount : 0,
  };
}

async function main() {
  const recentRows = await db
    .select({ id: skins.id, slug: skins.slug })
    .from(skins)
    .orderBy(desc(skins.id))
    .limit(RECENT_LIMIT);

  const recent = recentRows.filter((r) => r.slug !== TARGET_SLUG);

  const slugs = [TARGET_SLUG, ...recent.map((r) => r.slug)];

  const rows = (await db
    .select({
      id: skins.id,
      slug: skins.slug,
      model: skins.model,
      texture: skins.texture,
      avatar: skins.avatar,
    })
    .from(skins)
    .where(inArray(skins.slug, slugs))) as TargetRow[];

  const sorted = slugs
    .map((slug) => rows.find((r) => r.slug === slug))
    .filter((r): r is TargetRow => Boolean(r));

  if (sorted.length !== slugs.length) {
    throw new Error(`Missing rows. requested=${slugs.length} found=${sorted.length}`);
  }

  console.log(`Selected slugs: ${sorted.map((r) => `${r.slug}(id=${r.id})`).join(", ")}`);

  const browser = await chromium.launch({ headless: true });
  const page = await newViewerPage(browser);

  for (const row of sorted) {
    const slug = safeSlug(row.slug);
    const texture = Buffer.from(row.texture);
    const dbAvatar = Buffer.from(row.avatar);
    const model: "classic" | "slim" = row.model === "slim" ? "slim" : "classic";

    const rendered = await renderOne(page, texture, model);

    const sourcePath = `.tmp-source-${slug}.png`;
    const renderedPath = `.tmp-rendered-${slug}.png`;
    const dbAvatarPath = `.tmp-dbavatar-${slug}.png`;

    await writeFile(sourcePath, await sharp(texture).png().toBuffer());
    await writeFile(renderedPath, rendered);
    await writeFile(dbAvatarPath, dbAvatar);

    const srcInfo = await getPngInfo(texture);
    const renderedInfo = await getPngInfo(rendered);
    const dbInfo = await getPngInfo(dbAvatar);
    const renderedStats = await analyzeRenderedBodyRegion(rendered);
    const compare = await compareImages(rendered, dbAvatar);

    console.log(
      JSON.stringify(
        {
          id: row.id,
          slug: row.slug,
          model,
          files: {
            source: sourcePath,
            rendered: renderedPath,
            dbAvatar: dbAvatarPath,
          },
          dimensions: {
            source: srcInfo,
            rendered: renderedInfo,
            dbAvatar: dbInfo,
          },
          renderedBodyRegion: {
            rect: renderedStats.bodyRect,
            avgColor: {
              r: Number(renderedStats.avgColor.r.toFixed(2)),
              g: Number(renderedStats.avgColor.g.toFixed(2)),
              b: Number(renderedStats.avgColor.b.toFixed(2)),
            },
          },
          renderedPureBlackFraction: Number(renderedStats.blackFraction.toFixed(6)),
          renderedVsDbAvatar: {
            sameDimensions: compare.sameDimensions,
            equalPixels: compare.equalPixels,
            diffFraction: Number(compare.diffFraction.toFixed(6)),
          },
        },
        null,
        2,
      ),
    );
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
