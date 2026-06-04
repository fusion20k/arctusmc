import { chromium, type Browser, type Page } from "playwright";
import { expandLegacySkin, normalizeLayer1BodyAlpha } from "./texture-quality.js";

const WIDTH = 320;
const HEIGHT = 640;

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

export interface BodyRenderer {
  render(textureBytes: Buffer, model: "classic" | "slim"): Promise<Buffer>;
  close(): Promise<void>;
}

export async function createBodyRenderer(): Promise<BodyRenderer> {
  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page: Page = await ctx.newPage();
  page.on("pageerror", (e) => console.warn(`  [render] page error: ${e.message}`));

  async function loadViewer(): Promise<void> {
    await page.setContent(VIEWER_HTML, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => (window as unknown as { __viewerReady?: boolean }).__viewerReady === true,
      { timeout: 30000 },
    );
  }
  await loadViewer();

  return {
    async render(textureBytes, model) {
      try {
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
      } catch (e) {
        await loadViewer().catch(() => {});
        throw e;
      }
    },
    async close() {
      await browser.close();
    },
  };
}
