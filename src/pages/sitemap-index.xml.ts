import type { APIRoute } from 'astro';
import { countSkins } from '../lib/db/queries';
import { getSiteUrl } from '../lib/seo';

const CHUNK_SIZE = 5000;

export const prerender = true;

export const GET: APIRoute = async () => {
  const total = await countSkins();
  const pageCount = Math.max(1, Math.ceil(total / CHUNK_SIZE));
  const siteUrl = getSiteUrl().replace(/\/$/, '');

  const sitemaps = Array.from({ length: pageCount }, (_, i) => {
    return `  <sitemap>\n    <loc>${siteUrl}/sitemap/${i}.xml</loc>\n  </sitemap>`;
  }).join('\n');

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    sitemaps,
    '</sitemapindex>',
  ].join('\n');

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
