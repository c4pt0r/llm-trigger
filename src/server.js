// HTTP API + tiny static UI. Default bind is 127.0.0.1 (this thing can run shell
// commands if you enable it, so do not expose it bare).
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";
import { compileTrigger } from "./parse.js";
import { validateRule } from "./schema.js";
import { runRule } from "./engine.js";
import { startScheduler } from "./scheduler.js";
import { catalogAsJson } from "./catalog.js";
import { PI_MODEL } from "./pi.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUB = join(HERE, "..", "public");
const MIME = { ".html": "text/html; charset=utf8", ".js": "text/javascript; charset=utf8", ".css": "text/css; charset=utf8", ".json": "application/json" };

const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { "content-type": "application/json; charset=utf8", "content-length": Buffer.byteLength(b) }); res.end(b); };
const readBody = (req) => new Promise((resolve, reject) => {
  let s = "";
  req.on("data", (c) => { s += c; if (s.length > 1e6) reject(new Error("body too large")); });
  req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error("invalid JSON body")); } });
});

export function createServer(dbPath, { quiet = false } = {}) {
  const database = db.open(dbPath);
  const log = (m) => { if (!quiet) console.log(m); };

  const routes = [
    ["GET", /^\/api\/health$/, async () => ({ ok: true, model: PI_MODEL || "pi default", shell: process.env.ALLOW_SHELL === "1", ...db.stats(database) })],
    ["GET", /^\/api\/catalog$/, async () => catalogAsJson()],

    ["POST", /^\/api\/parse$/, async (m, body) => {
      if (!body.text) return send0(400, { error: "text required" });
      const r = await compileTrigger(body.text, { model: body.model });
      return send0(r.ok ? 200 : 422, r.ok ? { rule: r.rule, rendered: r.rendered, note: r.note, missing: r.missing, model: r.model } : { error: "cannot compile", errors: r.errors });
    }],

    ["POST", /^\/api\/rules$/, async (m, body) => {
      if (!body.text) return send0(400, { error: "text required" });
      const r = await compileTrigger(body.text, { model: body.model });
      if (!r.ok) return send0(422, { error: "cannot compile", errors: r.errors });
      const rule = db.insertRule(database, { raw: body.text, rule: r.rule, note: r.note, missing: r.missing, model: r.model });
      log(`created ${rule.id}: ${rule.rendered}`);
      return send0(201, rule);
    }],

    ["GET", /^\/api\/rules$/, async () => db.listRules(database)],

    ["GET", /^\/api\/rules\/([\w-]+)$/, async (m) => getOr404(m[1])],

    ["POST", /^\/api\/rules\/([\w-]+)\/compile$/, async (m, body) => {
      const old = getOr404(m[1]); if (old.__404) return old;
      if (!body.text) return send0(400, { error: "text required" });
      const r = await compileTrigger(body.text, { model: body.model });
      if (!r.ok) return send0(422, { error: "cannot compile", errors: r.errors });
      return send0(200, db.recompile(database, m[1], { raw: body.text, rule: r.rule, note: r.note, missing: r.missing, model: r.model }));
    }],

    ["PUT", /^\/api\/rules\/([\w-]+)$/, async (m, body) => {
      const old = getOr404(m[1]); if (old.__404) return old;
      const v = validateRule(body);            // hand-edited structured rule goes through the same validator
      if (!v.ok) return send0(422, { error: "invalid rule", errors: v.errors });
      return send0(200, db.recompile(database, m[1], { raw: old.raw, rule: v.rule, note: body.note ?? old.note, missing: [], model: old.model }));
    }],

    ["PATCH", /^\/api\/rules\/([\w-]+)$/, async (m, body) => {
      if (!db.getRule(database, m[1])) return send0(404, { error: "no such rule" });
      db.setEnabled(database, m[1], body.enabled !== false);
      return send0(200, db.getRule(database, m[1]));
    }],

    ["DELETE", /^\/api\/rules\/([\w-]+)$/, async (m) => (db.deleteRule(database, m[1]) ? send0(200, { deleted: m[1] }) : send0(404, { error: "no such rule" }))],

    ["POST", /^\/api\/rules\/([\w-]+)\/run$/, async (m, body) => {
      const rule = getOr404(m[1]); if (rule.__404) return rule;
      try { return send0(200, await runRule(database, rule, { dryRun: !!body.dry, force: !!body.force })); }
      catch (e) { return send0(502, { error: e.message }); }
    }],

    ["GET", /^\/api\/fires$/, async (m, b, url) => db.listFires(database, { ruleId: url.searchParams.get("rule") || undefined, limit: Number(url.searchParams.get("limit") || 50) })],
  ];

  function send0(code, obj) { return { code, obj }; }
  function getOr404(id) { const r = db.getRule(database, id); return r || send0(404, { error: "no such rule" }); }

  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";
    try {
      for (const [method, re, handler] of routes) {
        if (req.method !== method) continue;
        const m = url.split("?")[0].match(re); // match on the path only; query goes to url.searchParams
        if (!m) continue;
        const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : {};
        const out = await handler(m, body, new URL(url, "http://x"));
        if (out && out.obj !== undefined) return send(res, out.code ?? 200, out.obj);
        return send(res, 200, out);
      }
      // static
      const path = url === "/" ? "/index.html" : url.split("?")[0];
      const file = join(PUB, normalize(path).replace(/^(\.\.[/\\])+/, ""));
      if (existsSync(file) && file.startsWith(PUB)) {
        res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
        return res.end(readFileSync(file));
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
  return { server, database, startScheduler: (o) => startScheduler(database, { log, ...o }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const { server, startScheduler } = createServer(db.defaultDbPath());
  server.listen(port, host, () => {
    console.log(`llm-trigger on http://${host}:${port}  (model: ${PI_MODEL || "pi default"})`);
    if (process.env.LT_SCHEDULER !== "off") startScheduler();
  });
}
