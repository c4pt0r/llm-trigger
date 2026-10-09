// Action executors. log/webhook/shell are deterministic: they only render
// {{field}} from the fact and call out. agent.run is the one exception — it
// hands the event to the local agent WITH TOOLS; like shell.exec it honours
// ALLOW_SHELL=0 (an agent with tools is at least as powerful as a shell).
import { spawnSync } from "node:child_process";
import { renderTemplate } from "./schema.js";
import { shellAllowed } from "./catalog.js";
import { agentComplete } from "./agent.js";

const EXEC_SYSTEM = `You are the executor of a trigger system. A rule just fired on an event; carry out the task below using the tools you have.
Act, don't ask — there is no user to answer questions. Reply in the end with one short line describing what you did (it is logged).`;

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
      if (!shellAllowed()) return { status: "skipped", detail: "shell.exec disabled by ALLOW_SHELL=0" };
      const cmd = r(params.command);
      const p = spawnSync("/bin/bash", ["-c", cmd], { encoding: "utf8", timeout: 60_000 });
      const out = (p.stdout || p.stderr || "").trim().slice(0, 500);
      return p.status === 0 ? { status: "fired", detail: `$ ${cmd} -> ${out || "ok"}` } : { status: "error", detail: `$ ${cmd} -> exit ${p.status} ${out}` };
    }

    case "agent.run": {
      if (!shellAllowed()) return { status: "skipped", detail: "agent.run disabled by ALLOW_SHELL=0 (an agent with tools can run commands)" };
      const task = r(params.task);
      try {
        const res = await agentComplete({ exec: true, system: EXEC_SYSTEM, user: `Task:\n${task}\n\nEvent:\n${JSON.stringify(fact)}` });
        return { status: "fired", detail: `agent: ${res.text.replace(/\s+/g, " ").slice(0, 300)}` };
      } catch (e) {
        return { status: "error", detail: `agent.run failed: ${e.message}` };
      }
    }

    default:
      return { status: "error", detail: `unknown action "${action}"` };
  }
}

const summarize = (fact) => Object.entries(fact).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join(" ");
