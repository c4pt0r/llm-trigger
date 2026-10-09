// Fact providers. Each returns an array of plain fact objects (newest first)
// whose keys are exactly the fields declared in catalog.js for that event.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const UA = "llm-trigger/0.1";
const SNAP_CAP = 20_000; // chars kept per snapshot; both previous+content go into the judge prompt

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/vnd.github+json", ...headers }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`GET ${url} -> not JSON: ${text.slice(0, 200)}`); }
}

const ghHeaders = () => (process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {});
const firstLine = (s) => String(s ?? "").split("\n")[0];

async function github(target, event) {
  const repo = String(target.repo).replace(/^https?:\/\/github\.com\//, "");
  const base = `https://api.github.com/repos/${repo}`;
  const H = ghHeaders();

  switch (event) {
    case "github.release.published": {
      const rows = await getJson(`${base}/releases?per_page=10`, H);
      return rows.map((r) => ({ tag: r.tag_name, name: r.name ?? r.tag_name, url: r.html_url, published_at: r.published_at, prerelease: !!r.prerelease, body: firstLine(r.body) }));
    }
    case "github.issue.opened": {
      const rows = await getJson(`${base}/issues?state=open&sort=created&direction=desc&per_page=20`, H);
      return rows.filter((r) => !r.pull_request).map((r) => ({ number: r.number, title: r.title, author: r.user?.login, url: r.html_url, labels: (r.labels ?? []).map((l) => l.name), created_at: r.created_at, body: firstLine(r.body) }));
    }
    case "github.pr.opened": {
      const rows = await getJson(`${base}/pulls?state=open&sort=created&direction=desc&per_page=20`, H);
      return rows.map((r) => ({ number: r.number, title: r.title, author: r.user?.login, url: r.html_url, draft: !!r.draft, created_at: r.created_at }));
    }
    case "github.pr.merged": {
      const rows = await getJson(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=20`, H);
      return rows.filter((r) => r.merged_at).map((r) => ({ number: r.number, title: r.title, author: r.user?.login, url: r.html_url, merged_at: r.merged_at }));
    }
    case "github.commit.pushed": {
      const rows = await getJson(`${base}/commits?per_page=15`, H);
      return rows.map((r) => ({ sha: r.sha.slice(0, 12), message: firstLine(r.commit?.message), author: r.commit?.author?.name ?? r.author?.login ?? "unknown", url: r.html_url, date: r.commit?.author?.date }));
    }
    case "github.star.count": {
      const r = await getJson(base, H);
      return [{ stars: r.stargazers_count, url: r.html_url }];
    }
    default: throw new Error(`no github provider for event "${event}"`);
  }
}

function pickPath(obj, path) {
  if (!path) return obj;
  return String(path).split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

async function http(target) {
  const res = await fetch(String(target.url), { headers: { "user-agent": UA, ...(target.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let value = text;
  try { value = pickPath(JSON.parse(text), target.path); } catch { /* keep raw text */ }
  return [{ value, status: res.status, url: String(target.url) }];
}

function time() {
  const d = new Date();
  const iso = d.toISOString();
  return [{ now: iso.slice(0, 16) + "Z", date: iso.slice(0, 10), time: iso.slice(11, 16), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] }];
}

// Good-enough HTML -> text so the judge reads prose, not markup.
function stripHtml(s) {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " }[m]))
    .replace(/\s+/g, " ");
}

function runCommand(command, timeoutMs = 30_000) {
  if (process.env.ALLOW_SHELL !== "1") throw new Error(`observe command needs ALLOW_SHELL=1 (command: ${command})`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill("SIGKILL"); reject(new Error(`observe command timed out after ${timeoutMs}ms`)); } }, timeoutMs);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) return reject(new Error(`observe command exit ${code}: ${(err || out).slice(0, 200)}`));
      resolve(out);
    });
  });
}

// Open-world observation: snapshot whatever the url/command yields, diff against the
// previous snapshot (passed in by the engine from rule state). One fact per check;
// its digest is the dedup key, so an unchanged snapshot never reaches the judges.
async function observe(target, previous) {
  let content;
  if (target.url) {
    const res = await fetch(String(target.url), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
    content = await res.text();
    if (/html/i.test(res.headers?.get?.("content-type") ?? "") || /^\s*<(!doctype|html)/i.test(content)) content = stripHtml(content);
  } else {
    content = await runCommand(String(target.command));
  }
  content = content.trim().slice(0, SNAP_CAP);
  const digest = createHash("sha1").update(content).digest("hex").slice(0, 12);
  return [{
    what: target.what,
    content,
    previous: previous ?? "",
    changed: previous !== undefined && previous !== content,
    digest,
    url: String(target.url ?? target.command),
  }];
}

export async function fetchFacts(rule, { previous } = {}) {
  const { source, event, target } = rule.if;
  if (source === "github") return github(target, event);
  if (source === "http") return http(target);
  if (source === "time") return time();
  if (source === "observe") return observe(target, previous);
  throw new Error(`no provider for source "${source}"`);
}
