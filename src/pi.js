// LLM backend = pi itself. No OpenAI SDK, no extra API key.
//
// We spawn a one-shot, tool-less pi run and read its JSONL event stream.
// Model defaults to the *current* pi session model (PI_PROVIDER/PI_MODEL),
// so the app always compiles triggers with the same local model you are talking to.
import { spawn } from "node:child_process";

export const PI_BIN = process.env.PI_BIN || "pi";
// Outside a pi session PI_PROVIDER/PI_MODEL are unset and pi's default provider
// errors out on this machine, so fall back to the known-good local model.
export const DEFAULT_MODEL = "strata/qwen3.8-flash-next-iq3_s";
export const PI_MODEL = process.env.LT_MODEL || `${process.env.PI_PROVIDER || ""}/${process.env.PI_MODEL || ""}`.replace(/^\//, "") || DEFAULT_MODEL;

export function piArgs({ system, user, model, thinking = "off" }) {
  const args = [
    "-p", "--mode", "json", "--no-session",
    "-nt", "-ns", "-np", "-nc",           // no tools / skills / prompt-templates / context files
    "--thinking", thinking,
    "--system-prompt", system,
  ];
  const m = model ?? PI_MODEL;
  if (m) {
    const i = m.indexOf("/"); // "provider/id" -> pi's canonical --provider X --model Y
    if (i > 0) args.push("--provider", m.slice(0, i), "--model", m.slice(i + 1));
    else args.push("--model", m);
  }
  args.push("--", user);
  return args;
}

/** One pi run -> assistant text. Throws on provider error / timeout. */
export function piComplete(opts) {
  const { timeoutMs = 120_000 } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, piArgs(opts), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill("SIGKILL"); reject(new Error(`pi timed out after ${timeoutMs}ms`)); } }, timeoutMs);

    // Docs: split only on LF (readline would also break on U+2028/2029 inside JSON strings).
    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b) => { err += b.toString("utf8"); });

    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`cannot spawn ${PI_BIN}: ${e.message}`)); } });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const recs = [];
      for (const line of out.split("\n")) {
        const t = line.replace(/\r$/, "").trim();
        if (!t) continue;
        try { recs.push(JSON.parse(t)); } catch { /* ignore non-JSON diagnostics */ }
      }
      const finals = recs.filter((r) => r.type === "message_end" && r.message?.role === "assistant");
      const last = finals.at(-1);
      if (!last) return reject(new Error(`pi produced no assistant message (exit ${code})${err ? `: ${err.slice(0, 400)}` : ""}`));
      if (last.message.stopReason === "error") return reject(new Error(`pi model error: ${last.message.errorMessage || "unknown"} (model: ${last.message.provider || "?"}/${last.message.model || "?"} — override with LT_MODEL=provider/id)`));
      const text = (last.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (!text) return reject(new Error(`pi returned empty text (stopReason=${last.message.stopReason})`));
      resolve({ text, model: last.message.model, provider: last.message.provider, usage: last.message.usage });
    });
  });
}

/** Ask pi for JSON. Tolerates code fences and surrounding prose. */
export async function piJson(opts) {
  const r = await piComplete(opts);
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
    throw new Error(`model output is not JSON (${e.message}): ${r.text.slice(0, 300)}`);
  }
}
