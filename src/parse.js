// Natural language -> structured {if, then}. pi does the translation;
// validateRule() decides what is allowed. The model never runs at fire time.
import { catalogAsJson } from "./catalog.js";
import { validateRule, renderRule, DEFAULT_EVERY } from "./schema.js";
import { piJson } from "./pi.js";

const CATALOG = catalogAsJson();

const SYSTEM = `You are the compiler of a trigger system. You turn one natural-language sentence into ONE structured rule.

You must output a single JSON object and nothing else. Shape:
{
  "if": {
    "source": "<one of sources>",
    "event": "<one of events>",
    "target": { ...keys required by that source... },
    "when": [ { "field": "<field of that event>", "op": "<one of ops>", "value": ... } ],
    "every": "<5-field cron, UTC>"
  },
  "then": { "action": "<one of actions>", "params": { ...params of that action... } },
  "missing": ["<dotted path of anything the user did not specify and you had to guess>"],
  "note": "<one short sentence in the user's language: what this rule will do>"
}

Hard rules:
1. Only use events, fields, ops and actions that exist in the catalog below. Never invent names.
2. "when" holds the user's filters (e.g. "only if the title mentions OOM" -> {"field":"title","op":"contains","value":"OOM"}). Empty array if none.
3. Pick the event that best matches the described change; dedup is per event key, so prefer the most specific event.
4. "every" is how often to poll. Use "*/10 * * * *" unless the user gave a rhythm ("每天早上" -> "0 8 * * *", "每小时" -> "0 * * * *").
5. If the user did not say where to send the result, use action "log". If they named a webhook URL, use that URL verbatim in then.params.url.
6. In text params, interpolate event fields with {{field}}, e.g. "新 release {{tag}}: {{url}}".
7. If the sentence is not expressible with the catalog, output {"error":"<why, and which event would be needed>"}.

CATALOG:
${JSON.stringify(CATALOG)}`;

export async function compileTrigger(text, { model, thinking = "off", maxRounds = 2 } = {}) {
  const attempts = [];
  let user = `Sentence:\n${text}`;
  let lastErrors = [];

  for (let round = 1; round <= maxRounds; round++) {
    const { value, meta } = await piJson({ system: SYSTEM, user, model, thinking });
    attempts.push({ round, raw: JSON.stringify(value).slice(0, 800), model: meta.model });

    if (value && value.error) return { ok: false, errors: [`model refused: ${value.error}`], draft: null, attempts, note: value.note };

    const v = validateRule(value);
    if (v.ok) return { ok: true, errors: [], rule: v.rule, rendered: v.rendered, missing: value.missing ?? [], note: value.note ?? "", model: meta.model, attempts };

    lastErrors = v.errors;
    user = `Sentence:\n${text}\n\nYour previous JSON was rejected by the validator.\nPrevious JSON:\n${JSON.stringify(value)}\n\nValidator errors:\n- ${v.errors.join("\n- ")}\n\nOutput the corrected JSON object only.`;
  }
  return { ok: false, errors: lastErrors, draft: null, attempts };
}

/** For tests / offline use: same pipeline with an injected compiler instead of pi. */
export function makeOfflineCompiler(fn) {
  return async (text) => {
    const v = validateRule(fn(text));
    return v.ok ? { ok: true, errors: [], rule: v.rule, rendered: v.rendered, missing: [], note: "", model: "offline", attempts: [] } : { ok: false, errors: v.errors, draft: null, attempts: [] };
  };
}

export { renderRule, DEFAULT_EVERY };
