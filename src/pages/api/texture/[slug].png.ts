import type { APIRoute } from "astro";
import { getTextureBlob } from "../../../lib/db/queries";

export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug;
  if (!slug) {
    return new Response(null, { status: 400 });
  }

  const result = await getTextureBlob(slug);
  if (!result) {
    return new Response(null, { status: 404 });
  }

  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};

export const HEAD: APIRoute = async ({ params }) => {
  const slug = params.slug;
  if (!slug) {
    return new Response(null, { status: 400 });
  }
  const result = await getTextureBlob(slug);
  if (!result) {
    return new Response(null, { status: 404 });
  }
  return new Response(null, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
