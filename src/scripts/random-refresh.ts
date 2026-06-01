interface SkinCardData {
  slug: string;
  source_username: string | null;
  model: string;
  tags: Array<{ type: string; name: string }>;
}

const buttons = document.querySelectorAll<HTMLButtonElement>('.js-refresh-btn');
const icons = document.querySelectorAll<SVGElement>('.js-refresh-icon');
const container = document.getElementById('skin-grid-container');

const AD_FREQUENCY = 12;

const setBusy = (busy: boolean) => {
  buttons.forEach((b) => (b.disabled = busy));
  icons.forEach((i) =>
    busy ? i.classList.add('animate-spin') : i.classList.remove('animate-spin'),
  );
};

const buildCard = (skin: SkinCardData): HTMLAnchorElement => {
  const card = document.createElement('a');
  card.href = `/skin/${skin.slug}`;
  card.className =
    'group flex flex-col card-frost overflow-hidden hover:border-brand-500/60 hover:bg-frost-800/70 transition-all duration-150';

  const tagsHtml = skin.tags
    .slice(0, 3)
    .map((t) => {
      const cls = t.type === 'model' ? 'tag tag-model' : 'tag tag-color';
      return `<span class="${cls}">${t.name}</span>`;
    })
    .join('');

  card.innerHTML = `
    <div class="aspect-square skin-checker flex items-center justify-center p-3">
      <img
        src="/api/avatar/${skin.slug}.png?v=7"
        alt="Minecraft skin"
        width="160"
        height="320"
        loading="lazy"
        decoding="async"
        class="w-full h-full object-contain pixelated drop-shadow-[0_4px_12px_rgba(0,0,0,0.45)]"
      />
    </div>
    <div class="p-3 flex flex-col gap-1.5 flex-1">
      <p class="text-xs text-frost-400 capitalize">${skin.model}</p>
      ${tagsHtml ? `<div class="flex flex-wrap gap-1 mt-0.5">${tagsHtml}</div>` : ''}
    </div>
  `;
  return card;
};

const buildInlineAd = (): HTMLDivElement => {
  const wrap = document.createElement('div');
  wrap.className = 'col-span-full';
  wrap.innerHTML = `
    <div class="w-full overflow-hidden">
      <div class="ad-placeholder"><span>Advertisement</span></div>
    </div>
  `;
  return wrap;
};

const handleClick = async () => {
  if (!container) return;
  setBusy(true);

  try {
    const res = await fetch('/api/random.json');
    if (!res.ok) throw new Error('fetch failed');

    const data = (await res.json()) as { skins: SkinCardData[] };
    if (!data.skins?.length) throw new Error('no skins');

    const grid = document.createElement('div');
    grid.className =
      'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 sm:gap-4';

    data.skins.forEach((skin, i) => {
      if (i > 0 && i % AD_FREQUENCY === 0) {
        grid.appendChild(buildInlineAd());
      }
      grid.appendChild(buildCard(skin));
    });

    container.innerHTML = '';
    container.appendChild(grid);
  } catch {
    window.location.reload();
  } finally {
    setBusy(false);
  }
};

buttons.forEach((b) => b.addEventListener('click', handleClick));
