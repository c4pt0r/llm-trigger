// One process, one tick every LT_TICK_MS (default 60s). A rule runs only if its
// cron matched some minute since its last check, so "0 8 * * *" costs one request
// per day, not per tick. Ticking faster than 60s buys nothing (cron granularity
// is one minute); slower is fine — the due-window catches skipped minutes.
import { listRules } from "./db.js";
import { cronDue } from "./cron.js";
import { runRule } from "./engine.js";

export function startScheduler(db, { intervalMs = Number(process.env.LT_TICK_MS) || 60_000, log = (m) => console.error(m) } = {}) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    const now = new Date();
    for (const rule of listRules(db, { all: false })) {
      const last = rule.last_check_at ? new Date(rule.last_check_at * 1000) : null;
      let due = false;
      try { due = cronDue(rule.if.every, last, now); } catch (e) { log(`rule ${rule.id}: bad cron "${rule.if.every}" (${e.message})`); continue; }
      if (!due) continue;
      try {
        const s = await runRule(db, rule);
        if (s.baseline) log(`[${rule.id}] baseline: ${s.checked} existing ${rule.if.event} recorded, nothing fired`);
        else if (s.fired || s.errors) log(`[${rule.id}] fresh=${s.fresh} matched=${s.matched} fired=${s.fired} errors=${s.errors}`);
      } catch (e) {
        log(`[${rule.id}] check failed: ${e.message}`);
      }
    }
    busy = false;
  };
  tick();
  const t = setInterval(tick, intervalMs);
  return () => clearInterval(t);
}
