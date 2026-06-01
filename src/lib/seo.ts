export const SITE_NAME = 'Arctus MC';
export const SITE_DESCRIPTION =
  'Arctus MC is a frozen archive of Minecraft skins. Spin the random skin viewer or search by color and style to discover thousands of player skins.';

export function getSiteUrl(): string {
  return import.meta.env.PUBLIC_SITE_URL ?? 'http://localhost:4321';
}

export function canonicalUrl(path: string): string {
  const base = getSiteUrl().replace(/\/$/, '');
  return `${base}${path}`;
}

export function avatarUrl(slug: string): string {
  return `${getSiteUrl()}/api/avatar/${slug}.png`;
}

export function textureUrl(slug: string): string {
  return `${getSiteUrl()}/api/texture/${slug}.png`;
}
