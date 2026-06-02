import type { APIRoute } from 'astro';
import { countSkins, getSlugsPage } from '../../lib/db/queries';
import { getSiteUrl } from '../../lib/seo';

const CHUNK_SIZE = 5000;

export const prerender = true;

export async function getStaticPaths() {
  const { countSkins } = await import('../../lib/db/queries');
  const total = await countSkins();
  const pageCount = Math.max(1, Math.ceil(total / CHUNK_SIZE));
  return Array.from({ length: pageCount }, (_, i) => ({
    params: { page: String(i) },
  }));
}

export const GET: APIRoute = async ({ params }) => {
  const pageParam = params.page ?? '0';
  const page = parseInt(pageParam, 10);

  if (isNaN(page) || page < 0) {
    return new Response('Not Found', { status: 404 });
  }

  const total = await countSkins();
  const pageCount = Math.max(1, Math.ceil(total / CHUNK_SIZE));

  if (page >= pageCount) {
    return new Response('Not Found', { status: 404 });
  }

  const slugs = await getSlugsPage(page, CHUNK_SIZE);
  const siteUrl = getSiteUrl().replace(/\/$/, '');

  const urls = slugs
    .map((slug) => `  <url>\n    <loc>${siteUrl}/skin/${slug}</loc>\n  </url>`)
    .join('\n');

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
  ].join('\n');

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
