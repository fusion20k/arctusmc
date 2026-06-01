import type { APIRoute } from "astro";
import { getRandomSkins } from "../../lib/db/queries";

export const GET: APIRoute = async () => {
  const skins = await getRandomSkins(24);

  return new Response(JSON.stringify({ skins }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
};
