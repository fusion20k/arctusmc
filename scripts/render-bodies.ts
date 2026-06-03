import { chromium, type Page, type Browser } from "playwright";
import { eq, inArray } from "drizzle-orm";
import { db } from "../src/lib/db/client.js";
import { skins } from "../src/lib/db/schema.js";

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
  const base64 = textureBytes.toString("base64");
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

  const allRows = await db
    .select({ id: skins.id, slug: skins.slug, model: skins.model, texture: skins.texture, avatar: skins.avatar })
    .from(skins);

  // Identify "flat composite" avatars vs already-3D. Flat composites are exactly 128×256 PNGs
  // produced by sharp; 3D renders are 320×640 from this script (or larger from mc-heads).
  const targets = all
    ? allRows
    : allRows.filter((r) => {
        const avatarBuf = r.avatar as Uint8Array | null;
        if (!avatarBuf || avatarBuf.length === 0) return true;
        // PNG IHDR: bytes 16-19 = width BE, 20-23 = height BE
        if (avatarBuf.length < 24) return true;
        const view = Buffer.from(avatarBuf.buffer, avatarBuf.byteOffset, avatarBuf.byteLength);
        const w = view.readUInt32BE(16);
        const h = view.readUInt32BE(20);
        return w === 128 && h === 256;
      });

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
        const tex = Buffer.from(row.texture as Uint8Array);
        const model: "classic" | "slim" = row.model === "slim" ? "slim" : "classic";
        const avatar = await renderOne(page, tex, model);
        await db.update(skins).set({ avatar }).where(eq(skins.id, row.id));
        ok++;
        if (ok % 25 === 0) {
          console.log(`  ${ok}/${work.length} (fail=${fail}) last=${row.slug}`);
        }
      } catch (e) {
        fail++;
        console.warn(`  fail ${row.slug}: ${(e as Error).message}`);
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
