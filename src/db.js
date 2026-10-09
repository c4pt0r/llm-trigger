// Storage: one row per rule, with if/then kept as structured JSON *and* flattened
// into queryable columns (source/event/action/every) so "which rules watch X?" is SQL,
// not a JSON scan. node:sqlite is built into Node 22 -> zero dependencies.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rules (
  id           TEXT PRIMARY KEY,
  raw          TEXT NOT NULL,            -- the user's sentence, verbatim
  source       TEXT NOT NULL,
  event        TEXT NOT NULL,
  target_json  TEXT NOT NULL,
  when_json    TEXT NOT NULL,            -- conditions array
  every        TEXT NOT NULL,            -- cron
  action       TEXT NOT NULL,
  params_json  TEXT NOT NULL,
  rendered     TEXT NOT NULL,            -- deterministic "IF ... THEN ..."
  note         TEXT,
  missing_json TEXT NOT NULL DEFAULT '[]',
  model        TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_check_at INTEGER,
  state_json   TEXT NOT NULL DEFAULT '{"seen":[]}'
);
CREATE INDEX IF NOT EXISTS rules_enabled ON rules(enabled);
CREATE INDEX IF NOT EXISTS rules_event ON rules(event);

CREATE TABLE IF NOT EXISTS fires (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id    TEXT NOT NULL,
  key        TEXT NOT NULL,              -- dedup key of the fact
  matched    INTEGER NOT NULL,           -- did conditions pass?
  action     TEXT NOT NULL,
  status     TEXT NOT NULL,              -- fired | dry | error | skipped
  detail     TEXT,
  fact_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fires_rule ON fires(rule_id, created_at DESC);
`;

const SEEN_CAP = 500;

export function open(dbPath) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

const rowToRule = (r) => ({
  id: r.id, raw: r.raw, enabled: !!r.enabled, rendered: r.rendered, note: r.note,
  model: r.model, created_at: r.created_at, updated_at: r.updated_at, last_check_at: r.last_check_at,
  missing: JSON.parse(r.missing_json),
  if: { source: r.source, event: r.event, target: JSON.parse(r.target_json), when: JSON.parse(r.when_json), every: r.every },
  then: { action: r.action, params: JSON.parse(r.params_json) },
});

export function insertRule(db, { raw, rule, note = "", missing = [], model = null }) {
  const now = Math.floor(Date.now() / 1000);
  const id = "r_" + randomUUID().slice(0, 8);
  db.prepare(`INSERT INTO rules
      (id, raw, source, event, target_json, when_json, every, action, params_json, rendered, note, missing_json, model, enabled, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, raw, rule.if.source, rule.if.event, JSON.stringify(rule.if.target), JSON.stringify(rule.if.when),
      rule.if.every, rule.then.action, JSON.stringify(rule.then.params), renderOf(rule), note, JSON.stringify(missing), model, 1, now, now);
  return getRule(db, id);
}

function renderOf(rule) {
  // kept here to avoid a circular import with schema.js at module scope
  const { if: i, then: t } = rule;
  const tgt = Object.entries(i.target ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
  const conds = (i.when ?? []).map((c) => (c.op === "exists" ? `${c.field} exists` : `${c.field} ${c.op} ${JSON.stringify(c.value)}`)).join(" AND ");
  const params = Object.entries(t.params ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  return `IF ${i.event}${tgt ? ` (${tgt})` : ""} WHEN ${conds || "true"} EVERY "${i.every}" THEN ${t.action}(${params})`;
}

export const listRules = (db, { all = true } = {}) =>
  db.prepare(`SELECT * FROM rules ${all ? "" : "WHERE enabled = 1"} ORDER BY created_at DESC`).all().map(rowToRule);

export const getRule = (db, id) => { const r = db.prepare("SELECT * FROM rules WHERE id = ?").get(id); return r ? rowToRule(r) : null; };

export function setEnabled(db, id, enabled) {
  db.prepare("UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, Math.floor(Date.now() / 1000), id);
}

export const deleteRule = (db, id) => { db.prepare("DELETE FROM fires WHERE rule_id = ?").run(id); return db.prepare("DELETE FROM rules WHERE id = ?").run(id).changes > 0; };

export function recompile(db, id, { raw, rule, note, missing, model }) {
  db.prepare(`UPDATE rules SET raw=?, source=?, event=?, target_json=?, when_json=?, every=?, action=?, params_json=?, rendered=?, note=?, missing_json=?, model=?, updated_at=? WHERE id=?`)
    .run(raw, rule.if.source, rule.if.event, JSON.stringify(rule.if.target), JSON.stringify(rule.if.when), rule.if.every,
      rule.then.action, JSON.stringify(rule.then.params), renderOf(rule), note ?? "", JSON.stringify(missing ?? []), model ?? null, Math.floor(Date.now() / 1000), id);
  db.prepare("UPDATE rules SET state_json = '{\"seen\":[]}' WHERE id = ?").run(id); // new semantics -> forget history
  return getRule(db, id);
}

// ---------- dedup state ----------
export function getSeen(db, id) {
  const r = db.prepare("SELECT state_json FROM rules WHERE id = ?").get(id);
  return new Set(JSON.parse(r?.state_json ?? '{"seen":[]}').seen);
}

export function markSeen(db, id, keys) {
  if (!keys.length) return;
  const r = db.prepare("SELECT state_json FROM rules WHERE id = ?").get(id);
  const seen = JSON.parse(r?.state_json ?? '{"seen":[]}').seen;
  for (const k of keys) if (!seen.includes(k)) seen.push(k);
  db.prepare("UPDATE rules SET state_json = ?, last_check_at = ? WHERE id = ?")
    .run(JSON.stringify({ seen: seen.slice(-SEEN_CAP) }), Math.floor(Date.now() / 1000), id);
}

export function touchCheck(db, id) {
  db.prepare("UPDATE rules SET last_check_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), id);
}

export function logFire(db, { rule_id, key, matched, action, status, detail, fact }) {
  db.prepare(`INSERT INTO fires (rule_id, key, matched, action, status, detail, fact_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(rule_id, key, matched ? 1 : 0, action, status, detail ?? null, JSON.stringify(fact), Math.floor(Date.now() / 1000));
}

export function listFires(db, { ruleId, limit = 50 } = {}) {
  const stmt = ruleId
    ? db.prepare("SELECT * FROM fires WHERE rule_id = ? ORDER BY id DESC LIMIT ?")
    : db.prepare("SELECT * FROM fires ORDER BY id DESC LIMIT ?");
  const out = (ruleId ? stmt.all(ruleId, limit) : stmt.all(limit));
  return out.map((f) => ({ ...f, matched: !!f.matched, fact: JSON.parse(f.fact_json), created_at: new Date(f.created_at * 1000).toISOString() }));
}

export function stats(db) {
  const q = (sql) => db.prepare(sql).get().n;
  return {
    rules: q("SELECT COUNT(*) n FROM rules"),
    enabled: q("SELECT COUNT(*) n FROM rules WHERE enabled = 1"),
    fires: q("SELECT COUNT(*) n FROM fires WHERE status = 'fired'"),
    by_event: db.prepare("SELECT event, COUNT(*) n FROM rules GROUP BY event ORDER BY n DESC").all(),
  };
}
