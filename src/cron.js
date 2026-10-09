// Minimal 5-field cron (UTC): minute hour day-of-month month day-of-week.
// Supports *, a, a-b, a,b,c, */n, a-b/n. No "L", "W", "#", names.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(field, [min, max]) {
  const set = new Set();
  for (const part of field.split(",")) {
    const [rangeText, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new Error(`bad step in "${part}"`);
    let lo = min, hi = max;
    if (rangeText !== "*") {
      if (rangeText.includes("-")) { [lo, hi] = rangeText.split("-").map(Number); }
      else { lo = hi = Number(rangeText); }
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`bad range "${part}"`);
    for (let v = lo; v <= hi; v += step) set.add(v === 7 && max === 7 ? 0 : v);
  }
  return set;
}

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}" must have 5 fields`);
  return parts.map((p, i) => parseField(p, RANGES[i]));
}

export function cronMatch(expr, d = new Date()) {
  const [mi, h, dom, mon, dow] = parseCron(expr);
  return mi.has(d.getUTCMinutes()) && h.has(d.getUTCHours()) && dom.has(d.getUTCDate()) &&
    mon.has(d.getUTCMonth() + 1) && dow.has(d.getUTCDay());
}

/** Did the cron fire at least once in (from, to]? Used to decide "is this rule due". */
export function cronDue(expr, from, to = new Date()) {
  if (!from) return true;
  const [mi, h, dom, mon, dow] = parseCron(expr);
  for (let t = Math.floor(from.getTime() / 60000) * 60000 + 60000; t <= to.getTime(); t += 60000) {
    const d = new Date(t);
    if (mi.has(d.getUTCMinutes()) && h.has(d.getUTCHours()) && dom.has(d.getUTCDate()) && mon.has(d.getUTCMonth() + 1) && dow.has(d.getUTCDay())) return true;
  }
  return false;
}

/** Human hint for the UI. */
export function cronHint(expr) {
  try {
    parseCron(expr);
    return expr;
  } catch (e) { return `invalid cron: ${e.message}`; }
}
