// Slow judges — the conditions the engine cannot evaluate as a pure expression.
// Two kinds, both run only on fresh facts that already passed the deterministic ops:
//   op "script": a local command; fact JSON on stdin, exit code 0 = pass. ALLOW_SHELL=1 gated.
//   op "agent" : the local model answers yes/no questions about the fact.
// Scripts run first (cheap, local) and short-circuit; the model is asked last.
// Dedup guarantees at most one judgement per fact per rule.
import { spawn } from "node:child_process";
import { piJson } from "./pi.js";

const SYSTEM = `You are a strict yes/no judge inside a trigger system. You get one event (JSON) and numbered questions about it.
Answer ONLY with {"answers":[{"n":1,"yes":true|false,"why":"<short reason, user's language>"}, ...]} — one entry per question, same order.
Judge only from the event content. When unsure, answer no.`;

/** Model judge: all agent conditions of one fact in a single pi call. */
export async function judgeFact(conds, fact, { model } = {}) {
  const questions = conds.map((c, i) => `${i + 1}. ${c.field === "*" ? "" : `[关于字段 ${c.field}] `}${c.value}`);
  const user = `Event:\n${JSON.stringify(fact)}\n\nQuestions:\n${questions.join("\n")}`;
  const { value } = await piJson({ system: SYSTEM, user, model });
  const answers = Array.isArray(value?.answers) ? value.answers : [];
  if (answers.length !== conds.length) throw new Error(`judge returned ${answers.length} answers for ${conds.length} questions`);
  const yes = answers.every((a) => a?.yes === true);
  const why = answers.map((a, i) => `Q${i + 1}:${a?.yes ? "yes" : "no"}${a?.why ? `(${a.why})` : ""}`).join(" ");
  return { yes, why };
}

/** Script judge: fact JSON on stdin, LT_EVENT/LT_FIELD in env, exit 0 = pass. */
export function runScriptJudge(cond, fact, { event = "", timeoutMs = 30_000 } = {}) {
  if (process.env.ALLOW_SHELL !== "1") throw new Error(`script condition needs ALLOW_SHELL=1 (command: ${cond.value})`);
  return new Promise((resolve, reject) => {
    const child = spawn(cond.value, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LT_EVENT: event, LT_FIELD: cond.field },
    });
    let out = "", err = "", settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill("SIGKILL"); reject(new Error(`script timed out after ${timeoutMs}ms: ${cond.value}`)); } }, timeoutMs);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const note = (out || err).trim().slice(0, 200);
      resolve({ yes: code === 0, why: `exit ${code}${note ? ` (${note})` : ""}` });
    });
    child.stdin.end(JSON.stringify(fact));
  });
}

/** Dispatch: script conditions first (short-circuit), then one model call for the agent ones. */
export async function judgeConditions(conds, fact, opts = {}) {
  const parts = [];
  for (const c of conds.filter((c) => c.op === "script")) {
    const r = await runScriptJudge(c, fact, opts);
    parts.push(`script ${c.value.slice(0, 40)}: ${r.why}`);
    if (!r.yes) return { yes: false, why: parts.join("; ") };
  }
  const agents = conds.filter((c) => c.op === "agent");
  if (agents.length) {
    const r = await judgeFact(agents, fact, opts);
    parts.push(r.why);
    if (!r.yes) return { yes: false, why: parts.join("; ") };
  }
  return { yes: true, why: parts.join("; ") };
}
