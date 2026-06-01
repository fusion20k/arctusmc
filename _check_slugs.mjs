import { createClient } from "@libsql/client";
const c = createClient({ url: "file:./local.db" });
const r = await c.execute("SELECT slug FROM skins LIMIT 3");
r.rows.forEach(row => console.log(row[0]));
