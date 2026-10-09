// Action executors. Everything here is deterministic: it only renders {{field}}
// from the fact and calls out. No model in the loop.
import { spawnSync } from "node:child_process";
import { renderTemplate } from "./schema.js";

const UA = "llm-trigger/0.1";

export async function runAction(rule, fact) {
  const { action, params } = rule.then;
  const r = (v) => renderTemplate(v ?? "", fact);

  switch (action) {
    case "log":
      return { status: "fired", detail: r(params.text) || summarize(fact) };

    case "webhook.post": {
      const url = r(params.url);
      let body = r(params.body) || JSON.stringify(fact);
      try { body = JSON.parse(body); } catch { body = { text: body }; }
      const res = await fetch(url, { method: "POST", headers: { "user-agent": UA, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      return res.ok ? { status: "fired", detail: `POST ${url} -> ${res.status}` } : { status: "error", detail: `POST ${url} -> ${res.status} ${text.slice(0, 200)}` };
    }

    case "lark.webhook": {
      const url = r(params.url);
      const text = r(params.text) || summarize(fact);
      const res = await fetch(url, { method: "POST", headers: { "user-agent": UA, "content-type": "application/json" }, body: JSON.stringify({ msg_type: "text", content: { text } }), signal: AbortSignal.timeout(15_000) });
      const body = await res.text();
      // Lark custom bots answer 200 with {"code":19021...} on bad signature/url, so check the payload.
      const ok = res.ok && !/"code":\s*(?!0)\d/.test(body);
      return ok ? { status: "fired", detail: `lark -> ${body.slice(0, 160)}` } : { status: "error", detail: `lark ${res.status} -> ${body.slice(0, 200)}` };
    }

    case "shell.exec": {
      if (process.env.ALLOW_SHELL !== "1") return { status: "skipped", detail: "shell.exec needs ALLOW_SHELL=1 on the server" };
      const cmd = r(params.command);
      const p = spawnSync("/bin/bash", ["-c", cmd], { encoding: "utf8", timeout: 60_000 });
      const out = (p.stdout || p.stderr || "").trim().slice(0, 500);
      return p.status === 0 ? { status: "fired", detail: `$ ${cmd} -> ${out || "ok"}` } : { status: "error", detail: `$ ${cmd} -> exit ${p.status} ${out}` };
    }

    default:
      return { status: "error", detail: `unknown action "${action}"` };
  }
}

const summarize = (fact) => Object.entries(fact).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join(" ");
