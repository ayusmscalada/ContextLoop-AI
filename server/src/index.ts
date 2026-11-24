/** Local / VPS / Docker entry point: long-running Node server for the API + built web UI. */
import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { ROOT } from "./db.js";
import { app, indexStats, llmEnabled, MODEL, prepare } from "./app.js";

const PORT = Number(process.env.PORT ?? 8787);

// Serve the built web UI from the same origin when it exists (npm run build).
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), dist).replace(/\\/g, "/") }));
  app.get("*", (c) => c.html(fs.readFileSync(path.join(dist, "index.html"), "utf8")));
}

await prepare();
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`ContextLoop AI API on http://localhost:${PORT}  (index: ${indexStats.chunks} chunks / ${indexStats.docs} docs in ${indexStats.buildMs} ms; LLM: ${llmEnabled() ? MODEL : "offline mode"})`);
});
