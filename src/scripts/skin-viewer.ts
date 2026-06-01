import { SkinViewer, WalkingAnimation } from 'skinview3d';

function initViewer(wrap: HTMLElement): void {
  const canvas = wrap.querySelector<HTMLCanvasElement>('.skin-viewer-canvas');
  if (!canvas || canvas.dataset.initialized) return;
  canvas.dataset.initialized = 'true';

  const slug = wrap.dataset.slug;
  const width = parseInt(wrap.dataset.width || '300', 10);
  const height = parseInt(wrap.dataset.height || '400', 10);

  const viewer = new SkinViewer({
    canvas,
    width,
    height,
  });

  viewer.controls.enableZoom = false;
  viewer.animation = new WalkingAnimation();
  viewer.autoRotate = true;
  viewer.autoRotateSpeed = 0.6;

  viewer.loadSkin(`/api/texture/${slug}.png`).catch(() => {});
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        initViewer(entry.target as HTMLElement);
        observer.unobserve(entry.target);
      }
    }
  },
  { rootMargin: '100px' },
);

document.querySelectorAll<HTMLElement>('.skin-viewer-wrap').forEach((el) => {
  observer.observe(el);
});
