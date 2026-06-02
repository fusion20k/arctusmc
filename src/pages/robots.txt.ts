import type { APIRoute } from 'astro';
import { getSiteUrl } from '../lib/seo';

export const prerender = true;

export const GET: APIRoute = () => {
  const siteUrl = getSiteUrl().replace(/\/$/, '');
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${siteUrl}/sitemap-index.xml`,
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
};
