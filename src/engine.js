// The fire loop: fetch facts -> drop already-seen keys -> evaluate conditions -> run action.
// Slow judges (op "script" = local command, op "agent" = local model) only run for rules
// that opted in, and only on fresh facts that already passed the deterministic conditions.
import { fetchFacts } from "./sources.js";
import { evalRule, judgedConditions, factKey } from "./schema.js";
import { judgeConditions } from "./judge.js";
import { runAction } from "./actions.js";
import { getSeen, markSeen, logFire, touchCheck, getSnapshot, saveSnapshot, setEnabled } from "./db.js";

export async function runRule(db, rule, { dryRun = false, force = false, judge = judgeConditions } = {}) {
  const isObserve = rule.if.source === "observe";
  const facts = await fetchFacts(rule, { previous: isObserve ? getSnapshot(db, rule.id) : undefined });
  const judgedWhen = judgedConditions(rule);
  // The snapshot advances exactly when dedup state does (baseline always; otherwise not on dry runs).
  const keepSnapshot = () => { if (isObserve && facts.length) saveSnapshot(db, rule.id, facts[0].content); };
  const seen = force ? new Set() : getSeen(db, rule.id); // --all = replay history, ignore dedup
  const summary = { checked: facts.length, fresh: 0, matched: 0, fired: 0, errors: 0, skipped: 0, baseline: false, results: [] };

  // First ever check: record what already exists instead of blasting the user
  // with every historical release. `force` (CLI --all / API force) replays them instead.
  // Baseline skips the slow judges: history is only recorded, never fired, so paying
  // a model/script call per historical fact would buy nothing.
  if (rule.last_check_at == null && !force) {
    summary.baseline = true;
    const keys = [];
    for (const f of facts) {
      const key = factKey(rule, f);
      const matched = evalRule(rule, f);
      logFire(db, { rule_id: rule.id, key, matched, action: rule.then.action, status: "baseline", detail: "first check: recorded as history, not fired", fact: f });
      keys.push(key);
      summary.results.push({ key, matched, status: "baseline", fact: f });
    }
    markSeen(db, rule.id, keys);
    keepSnapshot();
    touchCheck(db, rule.id);
    return summary;
  }

  const keys = [];
  for (const f of facts) {
    const key = factKey(rule, f);
    if (seen.has(key)) continue;
    summary.fresh++;
    let matched = evalRule(rule, f);
    let status = matched ? "dry" : "no_match", detail = matched ? "dry run" : "conditions not met";

    // Slow judges: once per fresh fact, only after the cheap filters passed.
    let judgeWhy = "";
    if (matched && judgedWhen.length) {
      try {
        const j = await judge(judgedWhen, f, { event: rule.if.event });
        matched = j.yes;
        judgeWhy = j.why;
        status = matched ? "dry" : "no_match";
        detail = matched ? `dry run (judge: ${j.why})` : `judge said no: ${j.why}`;
      } catch (e) {
        matched = false;
        status = "error"; detail = `judge failed: ${e.message}`;
        summary.errors++;
      }
    }
    if (matched) summary.matched++;

    if (matched && !dryRun) {
      const out = await runAction(rule, f);
      status = out.status; detail = judgeWhy ? `${out.detail} (judge: ${judgeWhy})` : out.detail;
      if (status === "fired") summary.fired++;
      else if (status === "error") summary.errors++;
      else summary.skipped++;
    }
    logFire(db, { rule_id: rule.id, key, matched, action: rule.then.action, status, detail, fact: f });
    keys.push(key);
    summary.results.push({ key, matched, status, detail, fact: f });
  }
  if (!dryRun) { markSeen(db, rule.id, keys); keepSnapshot(); touchCheck(db, rule.id); }
  // mode "once": the rule fired, its job is done — disable it (re-enable with `on <id>`)
  if (!dryRun && summary.fired > 0 && rule.if.mode === "once") { setEnabled(db, rule.id, false); summary.disabled = true; }
  return summary;
}
