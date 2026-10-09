// Rule shape, validation, rendering ("IF ... THEN ...") and deterministic evaluation.
import { EVENTS, SOURCES, OPS, ACTIONS } from "./catalog.js";

// Default poll cadence for rules whose sentence gave no rhythm. LT_EVERY must be
// 5-field cron; an invalid value is caught by validateRule on the first compile.
export const DEFAULT_EVERY = process.env.LT_EVERY || "*/10 * * * *";

/** Validate an untrusted object (LLM output / user JSON edit) against the catalog. */
export function validateRule(input) {
  const errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["rule must be an object"], rule: null };

  const i = input.if ?? {};
  const t = input.then ?? {};

  if (!SOURCES[i.source]) errors.push(`if.source must be one of: ${Object.keys(SOURCES).join(", ")}`);
  const ev = EVENTS[i.event];
  if (!ev) errors.push(`if.event must be one of: ${Object.keys(EVENTS).join(", ")}`);
  else if (i.source && ev.source !== i.source) errors.push(`if.event ${i.event} belongs to source "${ev.source}", not "${i.source}"`);

  const target = i.target ?? {};
  if (ev) {
    const spec = SOURCES[ev.source];
    for (const k of spec.required) {
      if (!target[k]) errors.push(`if.target.${k} is required for source "${ev.source}"`);
    }
    for (const k of Object.keys(target)) {
      if (!spec.required.includes(k) && !spec.optional.includes(k)) errors.push(`if.target.${k} is not allowed for source "${ev.source}"`);
    }
    if (ev.source === "github" && target.repo && !/^[\w.-]+\/[\w.-]+$/.test(String(target.repo)))
      errors.push(`if.target.repo must look like "owner/name", got "${target.repo}"`);
    if ((ev.source === "http" || ev.source === "observe") && target.url && !/^https?:\/\//.test(String(target.url)))
      errors.push(`if.target.url must start with http(s)://`);
    if (ev.source === "observe" && !target.url && !target.command)
      errors.push(`if.target needs "url" or "command" for source "observe"`);
  }

  const when = i.when ?? [];
  if (!Array.isArray(when)) errors.push("if.when must be an array of conditions");
  else {
    when.forEach((c, n) => {
      if (!c || typeof c !== "object") return errors.push(`if.when[${n}] must be an object`);
      if (!ev) return;
      const judged = c.op === "agent" || c.op === "script"; // slow judges may look at the whole event
      if (!Object.hasOwn(ev.fields, c.field) && !(judged && c.field === "*"))
        errors.push(`if.when[${n}].field "${c.field}" is not a field of ${i.event}; allowed: ${Object.keys(ev.fields).join(", ")}${judged ? ", *" : ""}`);
      if (!OPS[c.op]) errors.push(`if.when[${n}].op must be one of: ${Object.keys(OPS).join(", ")}`);
      else if (OPS[c.op].args === 1 && c.value === undefined) errors.push(`if.when[${n}].value is required for op "${c.op}"`);
      if (c.op === "matches" && c.value !== undefined) {
        try { new RegExp(String(c.value)); } catch (e) { errors.push(`if.when[${n}].value is not a valid regex: ${e.message}`); }
      }
      if (judged && (typeof c.value !== "string" || !c.value.trim()))
        errors.push(`if.when[${n}].value must be a non-empty ${c.op === "agent" ? "yes/no question" : "command"} for op "${c.op}"`);
    });
  }

  const every = i.every ?? DEFAULT_EVERY;
  if (typeof every !== "string" || every.trim().split(/\s+/).length !== 5)
    errors.push(`if.every must be a 5-field cron expression, got "${every}"`);

  const ac = ACTIONS[t.action];
  if (!ac) errors.push(`then.action must be one of: ${Object.keys(ACTIONS).join(", ")}`);
  else {
    const params = t.params ?? {};
    for (const k of ac.required ?? []) if (!params[k]) errors.push(`then.params.${k} is required for action "${t.action}"`);
    for (const k of Object.keys(params))
      if (!Object.hasOwn(ac.params, k)) errors.push(`then.params.${k} is not a param of "${t.action}"; allowed: ${Object.keys(ac.params).join(", ")}`);
  }

  if (errors.length) return { ok: false, errors, rule: null };

  const rule = {
    if: {
      source: i.source,
      event: i.event,
      target: target,
      when: when.map((c) => ({ field: c.field, op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) })),
      every,
    },
    then: { action: t.action, params: t.params ?? {} },
  };
  return { ok: true, errors: [], rule, rendered: renderRule(rule) };
}

/** Deterministic, human-readable IF/THEN string. Never LLM-generated. */
export function renderRule(rule) {
  const { if: i, then: t } = rule;
  const tgt = Object.entries(i.target ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
  const head = `${i.event}${tgt ? ` (${tgt})` : ""}`;
  const conds = (i.when ?? []).map(condText).join(" AND ");
  const params = Object.entries(t.params ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  return `IF ${head} WHEN ${conds || "true"} EVERY "${i.every}" THEN ${t.action}(${params})`;
}

function condText(c) {
  if (c.op === "exists") return `${c.field} exists`;
  return `${c.field} ${c.op} ${JSON.stringify(c.value)}`;
}

// ---------- deterministic evaluation ----------

function coerce(op, actual, expected) {
  if (typeof actual === "number" || typeof expected === "number") {
    const a = Number(actual), b = Number(expected);
    return Number.isNaN(a) || Number.isNaN(b) ? [null, null] : [a, b];
  }
  if (typeof actual === "boolean") return [actual, expected === true || String(expected) === "true"];
  const ds = Date.parse(actual), de = Date.parse(expected);
  if (!Number.isNaN(ds) && !Number.isNaN(de)) return [ds, de];
  return [String(actual ?? "").toLowerCase(), String(expected ?? "").toLowerCase()];
}

export function evalCondition(cond, fact) {
  const actual = fact[cond.field];
  switch (cond.op) {
    case "exists": return actual !== undefined && actual !== null && actual !== "";
    case "eq": { const [a, b] = coerce("eq", actual, cond.value); return a !== null && a === b; }
    case "ne": { const [a, b] = coerce("ne", actual, cond.value); return a !== null && a !== b; }
    case "contains": {
      if (Array.isArray(actual)) return actual.some((x) => String(x).toLowerCase() === String(cond.value).toLowerCase());
      return String(actual ?? "").toLowerCase().includes(String(cond.value).toLowerCase());
    }
    case "not_contains": return !evalCondition({ ...cond, op: "contains" }, fact);
    case "matches": return new RegExp(String(cond.value), "i").test(String(actual ?? ""));
    case "gt": case "gte": case "lt": case "lte": {
      const [a, b] = coerce(cond.op, actual, cond.value);
      if (a === null) return false;
      return cond.op === "gt" ? a > b : cond.op === "gte" ? a >= b : cond.op === "lt" ? a < b : a <= b;
    }
    case "in": return Array.isArray(cond.value) && cond.value.some((v) => { const [a, b] = coerce("in", actual, v); return a !== null && a === b; });
    default: return false;
  }
}

const JUDGED_OPS = new Set(["agent", "script"]);

/** Slow conditions judged at check time (local model / local script), not by evalCondition. */
export function judgedConditions(rule) {
  return (rule.if.when ?? []).filter((c) => JUDGED_OPS.has(c.op));
}

/** Deterministic conditions only; judged conditions run separately in the engine. */
export function evalRule(rule, fact) {
  return (rule.if.when ?? []).filter((c) => !JUDGED_OPS.has(c.op)).every((c) => evalCondition(c, fact));
}

export function factKey(rule, fact) {
  const keys = EVENTS[rule.if.event]?.key ?? [];
  return keys.map((k) => String(fact[k])).join("|");
}

/** Replace {{field}} with values from fact. Values are stringified. */
export function renderTemplate(tpl, fact) {
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = fact[k];
    return v === undefined || v === null ? "" : Array.isArray(v) ? v.join(",") : String(v);
  });
}
