# Bug Investigation: ConnectionFailed for local.db on Netlify

## Bug Summary

Netlify-deployed Astro SSR app fails with:
```
ConnectionFailed("Unable to open connection to local database ./local.db: 14")
```
Error 14 is `SQLITE_CANTOPEN`. The libsql client is configured to open a local SQLite file
instead of connecting to the remote Turso database.

---

## Root Cause Analysis

**File:** `src/lib/db/client.ts`

```ts
const client = createClient({
  url: process.env.LIBSQL_URL ?? "file:./local.db",
  authToken: process.env.LIBSQL_AUTH_TOKEN,
});
```

The client is instantiated at **module load time** using `process.env.LIBSQL_URL`.
The fallback is `"file:./local.db"` — a local SQLite file path.

When `LIBSQL_URL` is absent or empty at runtime, the fallback is used and the libsql
client attempts to open `./local.db` as a local SQLite file. In a Netlify serverless
function environment, the filesystem is read-only and no such file exists, causing
`SQLITE_CANTOPEN` (error 14).

**Why is `LIBSQL_URL` missing at runtime?**

The `netlify.toml` only configures `NODE_VERSION`:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "20"
```

There is no `LIBSQL_URL` or `LIBSQL_AUTH_TOKEN` configured here, and there is no
evidence they are set in Netlify's dashboard environment variables. The `.env.example`
confirms the local-dev defaults:

```
LIBSQL_URL=file:./local.db
LIBSQL_AUTH_TOKEN=
```

These are local-only defaults — they must be overridden with the actual Turso remote URL
and auth token in Netlify's environment settings. Without that, `process.env.LIBSQL_URL`
is `undefined` at runtime, and the fallback `"file:./local.db"` is used.

---

## Affected Components

| File | Issue |
|---|---|
| `src/lib/db/client.ts` | Creates libsql client with a file-URL fallback; falls back to local SQLite when env var is missing |
| `netlify.toml` | Does not set `LIBSQL_URL` or `LIBSQL_AUTH_TOKEN` in the Netlify build/function environment |
| `.env.example` | Documents `file:./local.db` as the default, but this value must never reach Netlify production |

All pages and API routes that import from `src/lib/db/queries.ts` are affected since they
all consume the singleton `db` client created in `client.ts`.

---

## Proposed Solution

### 1. Set environment variables in Netlify (required, non-code change)

In the Netlify dashboard → Site settings → Environment variables, add:

- `LIBSQL_URL` = `libsql://<your-database>.turso.io` (the actual remote Turso URL)
- `LIBSQL_AUTH_TOKEN` = `<your-turso-auth-token>`

### 2. Add a guard in `client.ts` to fail fast with a clear message (code change)

Replace the silent fallback with an explicit error when a file URL is detected outside of
local development, or when the variable is entirely missing. This turns a cryptic
`SQLITE_CANTOPEN` into an actionable error message.

```ts
const url = process.env.LIBSQL_URL;
const authToken = process.env.LIBSQL_AUTH_TOKEN;

if (!url || url.startsWith("file:")) {
  throw new Error(
    `LIBSQL_URL is not configured for remote access. ` +
    `Got: "${url ?? "(not set)"}". ` +
    `Set LIBSQL_URL to your Turso database URL in Netlify environment variables.`
  );
}

const client = createClient({ url, authToken });
```

This guard will cause the serverless function to throw immediately with a human-readable
error instead of propagating `SQLITE_CANTOPEN` from deep inside libsql.

> Note: If local SQLite development must remain supported, the guard should only throw
> when `NODE_ENV === "production"` or when a `file:` URL is detected while not running
> locally (e.g., check for `NETLIFY=true`).

---

## Implementation Notes

### Code change — `src/lib/db/client.ts`

Added a guard that throws a descriptive error at module load time when the app is running
on Netlify (`NETLIFY=true`, set automatically by the platform) and `LIBSQL_URL` is either
absent or is a local `file:` URL:

```ts
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
```

The guard uses `NETLIFY=true` (injected automatically by Netlify into every serverless
function) so local SQLite development with `file:./local.db` continues to work unchanged.

### Tests

No test framework is configured in this project. The fix was verified by running
`npx astro check`, which reported **0 errors, 0 warnings, 0 hints** across all 43 files.

### Required user action

The code guard alone does not fix the production failure — the root cause is missing
environment variables. The user **must** add these in the Netlify dashboard
(Site settings → Environment variables):

| Variable | Value |
|---|---|
| `LIBSQL_URL` | `libsql://<your-database>.turso.io` |
| `LIBSQL_AUTH_TOKEN` | `<your-turso-auth-token>` |

Once set, re-deploy the site. The guard will then be unreachable in production, and the
libsql client will connect to the remote Turso database correctly.
