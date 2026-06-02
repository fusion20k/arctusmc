import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "./schema";

const url = process.env.LIBSQL_URL ?? "file:./local.db";
const authToken = process.env.LIBSQL_AUTH_TOKEN;

if (process.env.NETLIFY === "true" && (!url || url.startsWith("file:"))) {
  throw new Error(
    `LIBSQL_URL is not configured for remote access. ` +
      `Got: "${url ?? "(not set)"}". ` +
      `Set LIBSQL_URL to your Turso database URL in Netlify environment variables.`
  );
}

const client = createClient({ url, authToken });

export const db = drizzle(client, { schema });
