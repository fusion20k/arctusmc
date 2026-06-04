import { chromium, type Page, type Browser } from "playwright";
import { eq, inArray } from "drizzle-orm";
import { db } from "../src/lib/db/client.js";
import { skins } from "../src/lib/db/schema.js";
import { expandLegacySkin, normalizeLayer1BodyAlpha } from "../src/lib/texture-quality.js";

const WIDTH = 320;
const HEIGHT = 640;
const CONCURRENCY = 8;
const BATCH_SIZE = 100;

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
  page.on("pageerror", (e) => console.warn(`  page error: ${e.message}`));
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
  const expandedTexture = await expandLegacySkin(textureBytes);
  const normalizedTexture = await normalizeLayer1BodyAlpha(expandedTexture);
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

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1] ?? "0", 10) : 0;

  // Page through metadata only to identify targets; pulling all texture+avatar blobs
  // at once exceeds libSQL response limits and aborts the connection.
  const PAGE = 500;
  const targetIds: number[] = [];
  let offset = 0;
  while (true) {
    const page = await db
      .select({ id: skins.id, avatar: skins.avatar })
      .from(skins)
      .limit(PAGE)
      .offset(offset);
    if (page.length === 0) break;
    for (const r of page) {
      if (all) {
        targetIds.push(r.id as number);
        continue;
      }
      const avatarBuf = r.avatar as Uint8Array | null;
      if (!avatarBuf || avatarBuf.length === 0) {
        targetIds.push(r.id as number);
        continue;
      }
      if (avatarBuf.length < 24) {
        targetIds.push(r.id as number);
        continue;
      }
      const view = Buffer.from(avatarBuf.buffer, avatarBuf.byteOffset, avatarBuf.byteLength);
      const w = view.readUInt32BE(16);
      const h = view.readUInt32BE(20);
      if (w === 128 && h === 256) targetIds.push(r.id as number);
    }
    if (page.length < PAGE) break;
    offset += PAGE;
  }

  // Fetch full rows (with texture) only for selected targets, one at a time during work.
  const targets = targetIds.map((id) => ({ id }));

  const work = limit > 0 ? targets.slice(0, limit) : targets;
  console.log(`Rendering ${work.length} skins in 3D (concurrency=${CONCURRENCY}, batch=${BATCH_SIZE})`);

  const browser = await chromium.launch({ headless: true });
  const pages = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => newViewerPage(browser)),
  );

  let ok = 0;
  let fail = 0;
  let cursor = 0;

  async function worker(workerIdx: number) {
    const page = pages[workerIdx]!;
    while (true) {
      const idx = cursor++;
      if (idx >= work.length) return;
      const row = work[idx]!;
      try {
        const full = await db
          .select({ slug: skins.slug, model: skins.model, texture: skins.texture })
          .from(skins)
          .where(eq(skins.id, row.id))
          .limit(1);
        const f = full[0];
        if (!f) {
          fail++;
          continue;
        }
        const tex = Buffer.from(f.texture as Uint8Array);
        const model: "classic" | "slim" = f.model === "slim" ? "slim" : "classic";
        const avatar = await renderOne(page, tex, model);
        await db.update(skins).set({ avatar }).where(eq(skins.id, row.id));
        ok++;
        if (ok % 25 === 0) {
          console.log(`  ${ok}/${work.length} (fail=${fail}) last=${f.slug}`);
        }
      } catch (e) {
        fail++;
        console.warn(`  fail id=${row.id}: ${(e as Error).message}`);
        // Recover worker by reloading the page if it broke.
        try {
          await page.setContent(VIEWER_HTML, { waitUntil: "domcontentloaded" });
          await page.waitForFunction(
            () => (window as unknown as { __viewerReady?: boolean }).__viewerReady === true,
            { timeout: 30000 },
          );
        } catch {}
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));

  await browser.close();
  console.log(`\nDone. ok=${ok} fail=${fail} total=${work.length}`);
  // Silence unused-import warning for inArray (kept for future filtering).
  void inArray;
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
