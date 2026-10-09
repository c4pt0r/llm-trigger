// Agent backend abstraction. The compiler and the runtime judges talk to "an
// agent": any CLI that takes a system prompt + user prompt and prints a reply.
// pi is just the default example; pick another with LT_AGENT (preset name or a
// path to a JSON config):
//
//   { "cmd": "my-agent", "args": ["--system", "{system}", "{user}"],
//     "output": "text", "timeoutMs": 120000 }
//
// Placeholders in args: {system} {user} {thinking} {model} {provider} {modelId}
// ({provider}/{modelId} are the two halves of a "provider/id" model string).
// An arg whose placeholder resolves to nothing is dropped together with the
// flag right before it, so ["--model", "{model}"] vanishes when no model is set.
// output: "text" = stdout is the reply; "pi-jsonl" = pi's --mode json stream.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export const PRESETS = {
  pi: {
    name: "pi",
    cmd: process.env.PI_BIN || "pi",
    // -nt -ns -np -nc: no tools / skills / prompt templates / context files
    args: ["-p", "--mode", "json", "--no-session", "-nt", "-ns", "-np", "-nc",
      "--thinking", "{thinking}", "--system-prompt", "{system}",
      "--provider", "{provider}", "--model", "{modelId}", "--", "{user}"],
    output: "pi-jsonl",
    // LT_MODEL wins, else the current pi session's model (PI_PROVIDER/PI_MODEL,
    // only set inside a pi session), else nothing: the --provider/--model args
    // drop out and pi uses whatever default the local pi config has.
    model: process.env.LT_MODEL || `${process.env.PI_PROVIDER || ""}/${process.env.PI_MODEL || ""}`.replace(/^\//, "") || "",
  },
  claude: {
    name: "claude",
    cmd: "claude",
    args: ["-p", "--append-system-prompt", "{system}", "--model", "{model}", "{user}"],
    output: "text",
    model: process.env.LT_MODEL || "", // empty = the agent's own default model
  },
};

export function loadAgent() {
  const v = process.env.LT_AGENT || "pi";
  if (PRESETS[v]) return PRESETS[v];
  const cfg = JSON.parse(readFileSync(v, "utf8"));
  if (!cfg.cmd || !Array.isArray(cfg.args)) throw new Error(`agent config ${v} needs "cmd" and "args"`);
  return { name: cfg.cmd, output: "text", model: process.env.LT_MODEL || "", ...cfg };
}

export const AGENT = loadAgent();

const PLACEHOLDER = /\{(system|user|thinking|model|provider|modelId)\}/g;

export function buildArgs(agent, { system, user, model, thinking = "off" }) {
  const m = model ?? agent.model ?? "";
  const slash = m.indexOf("/");
  const vals = {
    system, user, thinking,
    model: m,
    provider: slash > 0 ? m.slice(0, slash) : "",
    modelId: slash > 0 ? m.slice(slash + 1) : m,
  };
  const out = [];
  for (const a of agent.args) {
    if (!PLACEHOLDER.test(a)) { out.push(a); PLACEHOLDER.lastIndex = 0; continue; }
    PLACEHOLDER.lastIndex = 0;
    const sub = a.replace(PLACEHOLDER, (_, k) => vals[k] ?? "");
    if (sub === "") { // placeholder resolved to nothing -> drop the arg and its flag
      if (out.length && out.at(-1).startsWith("-")) out.pop();
      continue;
    }
    out.push(sub);
  }
  return out;
}

export function parseAgentOutput(mode, stdout, exitCode, stderr = "") {
  if (mode === "pi-jsonl") {
    const recs = [];
    for (const line of stdout.split("\n")) { // split only on LF: U+2028/2029 may sit inside JSON strings
      const t = line.replace(/\r$/, "").trim();
      if (!t) continue;
      try { recs.push(JSON.parse(t)); } catch { /* ignore non-JSON diagnostics */ }
    }
    const last = recs.filter((r) => r.type === "message_end" && r.message?.role === "assistant").at(-1);
    if (!last) throw new Error(`agent produced no assistant message (exit ${exitCode})${stderr ? `: ${stderr.slice(0, 400)}` : ""}`);
    if (last.message.stopReason === "error") throw new Error(`agent model error: ${last.message.errorMessage || "unknown"} (model: ${last.message.provider || "?"}/${last.message.model || "?"} — override with LT_MODEL=provider/id)`);
    const text = (last.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    if (!text) throw new Error(`agent returned empty text (stopReason=${last.message.stopReason})`);
    return { text, model: last.message.model, provider: last.message.provider, usage: last.message.usage };
  }
  // "text": stdout is the reply
  const text = stdout.trim();
  if (exitCode !== 0) throw new Error(`agent exit ${exitCode}: ${(stderr || stdout).slice(0, 400)}`);
  if (!text) throw new Error(`agent returned empty output${stderr ? `: ${stderr.slice(0, 400)}` : ""}`);
  return { text, model: undefined, provider: undefined, usage: undefined };
}

/** One agent run -> reply text. Throws on agent error / timeout. */
export function agentComplete(opts) {
  const agent = opts.agent ?? AGENT;
  const timeoutMs = opts.timeoutMs ?? agent.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(agent.cmd, buildArgs(agent, opts), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill("SIGKILL"); reject(new Error(`agent ${agent.name} timed out after ${timeoutMs}ms`)); } }, timeoutMs);
    child.stdout.on("data", (b) => (out += b.toString("utf8")));
    child.stderr.on("data", (b) => (err += b.toString("utf8")));
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`cannot spawn ${agent.cmd}: ${e.message}`)); } });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try {
        const r = parseAgentOutput(agent.output, out, code, err);
        resolve({ ...r, model: r.model ?? agent.name });
      } catch (e) { reject(e); }
    });
  });
}

/** Ask the agent for JSON. Tolerates code fences and surrounding prose. */
export async function agentJson(opts) {
  const r = await agentComplete(opts);
  let s = r.text;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  s = s.trim();
  try {
    return { value: JSON.parse(s), raw: r.text, meta: r };
  } catch (e) {
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try { return { value: JSON.parse(s.slice(a, b + 1)), raw: r.text, meta: r }; } catch { /* fallthrough */ }
    }
    throw new Error(`agent output is not JSON (${e.message}): ${r.text.slice(0, 300)}`);
  }
}
