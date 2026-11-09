#!/usr/bin/env node
// shipcast: turn a repo's git history into posts, schedule them through Zernio,
// then learn which kinds of code changes your audience actually cares about.
//
//   shipcast plan     <repo> [--since 2026-11-01] [--max 6] [--no-llm]   -> writes shipcast.plan.json
//   shipcast schedule [--plan shipcast.plan.json] [--publish]            -> drafts (default) or scheduled posts
//   shipcast report                                                      -> engagement by kind of change
//
// Env: ZERNIO_API_KEY (or run with --mock for an in-process fake Zernio), ZERNIO_BASE (default https://zernio.com/api)

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const PLATFORMS = ["twitter", "linkedin", "bluesky"];
const LIMITS = { twitter: 280, linkedin: 3000, bluesky: 300 };
const KINDS = ["feature", "performance", "fix", "infra", "docs"];

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(all[i - 1] || "").startsWith("--"));
const log = (...a) => console.error("·", ...a);

// ---------- Zernio client ----------
let BASE = process.env.ZERNIO_BASE || "https://zernio.com/api";
let KEY = process.env.ZERNIO_API_KEY;

async function z(method, route, body, query) {
  if (!KEY) throw new Error("ZERNIO_API_KEY is not set (or pass --mock)");
  const url = new URL(BASE + route);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok && res.status !== 207) {
    const err = new Error(`${method} ${route} -> ${res.status} ${data.code || ""} ${data.error || text.slice(0, 200)}`);
    err.status = res.status;
    err.requestId = res.headers.get("x-request-id");
    throw err;
  }
  return data;
}

// ---------- git ----------
function gitCommits(repo, since, max) {
  const fmt = "%H%x1f%h%x1f%ad%x1f%s%x1f%b%x1e";
  const args = ["-C", repo, "log", `--format=${fmt}`, "--date=short", "--no-merges"];
  if (since) args.push(`--since=${since}`);
  const raw = execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  const commits = raw.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, short, date, subject, body] = r.split("\x1f");
    const stat = execFileSync("git", ["-C", repo, "show", "--stat", "--format=", sha], { encoding: "utf8" }).trim();
    const files = stat.split("\n").slice(0, -1).map((l) => l.split("|")[0].trim()).filter(Boolean);
    const summary = stat.split("\n").pop() || "";
    const clean = (body || "").split("\n").filter((l) => !/^[A-Z][A-Za-z-]+: .+/.test(l.trim())).join("\n").trim(); // drop git trailers (Co-Authored-By, Signed-off-by, ...)
    return { sha, short, date, subject, body: clean, files, summary };
  });
  return commits.slice(0, Number(max) || 6);
}

function repoMeta(repo) {
  let remote = "";
  try { remote = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" }).trim(); } catch {}
  const web = remote.replace(/^git@github.com:/, "https://github.com/").replace(/\.git$/, "");
  let readme = "";
  for (const f of ["README.md", "readme.md", "README"]) {
    const p = path.join(repo, f);
    if (existsSync(p)) { readme = readFileSync(p, "utf8").slice(0, 1500); break; }
  }
  return { name: path.basename(path.resolve(repo)), web, readme };
}

// ---------- writing ----------
// The subject line decides; the body only breaks ties (bodies mention everything).
function classify(c) {
  const s = c.subject.toLowerCase();
  if (/optimi|perf|faster|speed|bench|latency/.test(s)) return "performance";
  if (/^(fix|bug|hotfix)|\bfix(es|ed)?\b|crash|regress/.test(s)) return "fix";
  if (/^(add|implement|support|introduce|finish|new)\b/.test(s)) return "feature";
  if (/^(ci|build|bump|chore|release)\b|\bci\b|runner|workflow/.test(s)) return "infra";
  if (/readme|docs?\b|typo/.test(s)) return "docs";
  if (/^(remove|clean|rename|refactor)\b/.test(s)) return "infra";
  return "feature";
}

function templatePosts(c, meta) {
  const link = meta.web ? `${meta.web}/commit/${c.short}` : "";
  const head = `${meta.name}: ${c.subject}`;
  const x = trimTo(`${head}\n\n${link}`, LIMITS.twitter);
  return {
    twitter: x,
    bluesky: trimTo(`${head}\n\n${link}`, LIMITS.bluesky),
    linkedin: `Shipped in ${meta.name} today: ${c.subject}.\n\n${c.body || c.summary}\n\n${link}`.trim(),
  };
}

function trimTo(s, n) {
  // X counts URLs as 23 chars; keep this conservative and let Zernio's validator be the judge.
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

function llmPosts(c, meta, kind) {
  const prompt = `You write build-in-public posts for a solo engineer. Be concrete, technical, no hype words (no "excited", "thrilled", "game-changer"), no hashtags, no emojis.

Project: ${meta.name} (${meta.web})
Project README excerpt:
${meta.readme}

Commit ${c.short} (${c.date}), classified as: ${kind}
Subject: ${c.subject}
Body: ${c.body || "(none)"}
Files changed: ${c.files.join(", ")}
Diffstat: ${c.summary}

Return ONLY a JSON object with keys "twitter", "bluesky", "linkedin".
- twitter: at most 250 characters including the link ${meta.web}/commit/${c.short}
- bluesky: at most 280 characters including the same link
- linkedin: 3-6 short sentences explaining what changed and why it is interesting to another engineer, then the link.`;
  const r = spawnSync("claude", ["-p", prompt, "--output-format", "text"], { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) throw new Error(`claude -p failed: ${(r.stderr || "").slice(0, 200)}`);
  const m = r.stdout.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("claude -p returned no JSON");
  const j = JSON.parse(m[0]);
  for (const p of PLATFORMS) if (typeof j[p] !== "string") throw new Error(`missing ${p}`);
  return j;
}

// Validate with Zernio's weighted counter when we have a key; local count otherwise.
async function validate(text) {
  if (KEY) {
    const r = await z("POST", "/v1/tools/validate/post-length", { text });
    return r.platforms || {};
  }
  return Object.fromEntries(PLATFORMS.map((p) => [p, { count: text.length, limit: LIMITS[p], valid: text.length <= LIMITS[p] }]));
}

// ---------- commands ----------
async function plan() {
  const repo = positional[0] || ".";
  const meta = repoMeta(repo);
  const commits = gitCommits(repo, flag("since"), flag("max", 6));
  log(`${meta.name}: ${commits.length} commits`);
  const items = [];
  for (const c of commits) {
    const kind = classify(c);
    let posts;
    if (flag("no-llm")) posts = templatePosts(c, meta);
    else {
      try { posts = llmPosts(c, meta, kind); log(`wrote posts for ${c.short} (${kind})`); }
      catch (e) { log(`LLM failed for ${c.short}: ${e.message}; using template`); posts = templatePosts(c, meta); }
    }
    const checks = {};
    for (const p of PLATFORMS) {
      const v = (await validate(posts[p]))[p];
      checks[p] = v;
      if (v && !v.valid) {
        log(`${c.short} ${p}: ${v.count}/${v.limit} too long, trimming`);
        posts[p] = trimTo(posts[p], v.limit - 10);
        checks[p] = (await validate(posts[p]))[p];
      }
    }
    items.push({ sha: c.sha, short: c.short, date: c.date, subject: c.subject, kind, posts, checks });
  }
  const out = flag("out", "shipcast.plan.json");
  writeFileSync(out, JSON.stringify({ repo: meta, createdAt: new Date().toISOString(), items }, null, 2));
  for (const it of items) {
    console.log(`\n[${it.kind}] ${it.short} ${it.subject}`);
    for (const p of PLATFORMS) console.log(`  ${p.padEnd(8)} ${String(it.checks[p]?.count).padStart(4)}/${it.checks[p]?.limit}  ${it.posts[p].split("\n")[0].slice(0, 90)}`);
  }
  console.log(`\nwrote ${out}`);
}

// Pick the next N slots ranked by Zernio's historical engagement for this account,
// falling back to sensible weekday defaults when there is no history yet.
async function slotsFor(platform, accountId, n) {
  let ranked = [];
  try {
    const r = await z("GET", "/v1/analytics/best-time", null, { platform, accountId, source: "all" });
    ranked = (r.slots || []).sort((a, b) => b.avg_engagement - a.avg_engagement);
  } catch (e) {
    log(`best-time unavailable for ${platform} (${e.status || e.message}); using defaults`);
  }
  if (!ranked.length) ranked = [{ day_of_week: 1, hour: 15 }, { day_of_week: 2, hour: 15 }, { day_of_week: 3, hour: 15 }, { day_of_week: 0, hour: 16 }, { day_of_week: 4, hour: 14 }];
  const out = [];
  const now = new Date();
  for (let week = 0; out.length < n && week < 8; week++) {
    for (const s of ranked) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), s.hour));
      const today = (now.getUTCDay() + 6) % 7; // 0 = Monday, like Zernio
      d.setUTCDate(d.getUTCDate() + ((s.day_of_week - today + 7) % 7) + 7 * week);
      if (d > new Date(now.getTime() + 30 * 60e3) && !out.some((x) => +x === +d)) out.push(d);
      if (out.length >= n) break;
    }
  }
  return out.sort((a, b) => a - b).map((d) => d.toISOString());
}

async function schedule() {
  const planFile = flag("plan", "shipcast.plan.json");
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  const accounts = (await z("GET", "/v1/accounts")).accounts || [];
  const byPlatform = {};
  for (const a of accounts) if (PLATFORMS.includes(a.platform) && a.isActive !== false && !byPlatform[a.platform]) byPlatform[a.platform] = a;
  const targets = Object.keys(byPlatform);
  if (!targets.length) throw new Error(`no connected ${PLATFORMS.join("/")} accounts in Zernio`);
  log(`accounts: ${targets.map((p) => `${p}=@${byPlatform[p].username || byPlatform[p]._id}`).join(", ")}`);

  const slots = {};
  for (const p of targets) slots[p] = await slotsFor(p, byPlatform[p]._id, plan.items.length);

  const publish = !!flag("publish");
  const results = [];
  // Oldest commit first, so the story reads in order.
  for (const [i, it] of [...plan.items].reverse().entries()) {
    const body = {
      content: it.posts.twitter,
      title: `${plan.repo.name} ${it.short}`,
      platforms: targets.map((p) => ({ platform: p, accountId: byPlatform[p]._id, customContent: it.posts[p], scheduledFor: slots[p][i] })),
      tags: ["shipcast", `kind:${it.kind}`, `repo:${plan.repo.name}`],
      metadata: { shipcast: true, sha: it.sha, kind: it.kind, repo: plan.repo.web },
    };
    if (publish) body.scheduledFor = slots[targets[0]][i];
    else body.isDraft = true;
    const r = await z("POST", "/v1/posts", body);
    const post = r.post || r;
    results.push({ sha: it.short, kind: it.kind, id: post._id, status: post.status, when: body.platforms.map((x) => `${x.platform}@${x.scheduledFor}`).join(" ") });
    console.log(`${publish ? "scheduled" : "drafted  "} ${it.short} [${it.kind}] -> ${post._id} ${body.platforms.map((x) => `${x.platform} ${x.scheduledFor.slice(0, 16)}Z`).join(" | ")}`);
  }
  writeFileSync(planFile.replace(/\.json$/, ".scheduled.json"), JSON.stringify(results, null, 2));
  if (!publish) console.log("\nSaved as drafts. Review them in Zernio, or rerun with --publish to schedule at the best-time slots.");
}

async function report() {
  const r = await z("GET", "/v1/analytics", null, { tags: "shipcast", source: "late", limit: 100, sortBy: "engagement", order: "desc" });
  const posts = r.posts || [];
  const agg = {};
  for (const p of posts) {
    const kind = (p.tags || []).find((t) => t.startsWith("kind:"))?.slice(5) || p.metadata?.kind || "unknown";
    const a = p.analytics || {};
    const e = (a.likes || 0) + (a.comments || 0) + (a.shares || 0) + (a.saves || 0);
    const g = (agg[kind] ||= { posts: 0, impressions: 0, engagement: 0, best: null });
    g.posts++; g.impressions += a.impressions || 0; g.engagement += e;
    if (!g.best || e > g.best.e) g.best = { e, content: (p.content || "").split("\n")[0].slice(0, 70), url: p.platformPostUrl };
  }
  const rows = Object.entries(agg).sort((a, b) => b[1].engagement / b[1].posts - a[1].engagement / a[1].posts);
  console.log(`kind of change   posts  avg impressions  avg engagement  best post`);
  for (const [k, g] of rows) console.log(`${k.padEnd(16)} ${String(g.posts).padStart(5)}  ${String(Math.round(g.impressions / g.posts)).padStart(15)}  ${(g.engagement / g.posts).toFixed(1).padStart(14)}  ${g.best?.content || ""}`);
  if (rows.length) console.log(`\n=> Your audience responds most to "${rows[0][0]}" changes. Lead with those.`);
  else console.log("No shipcast posts with analytics yet.");
}

// ---------- mock Zernio (for demos without a key) ----------
async function startMock() {
  const posts = [];
  const accounts = [
    { _id: "acc_tw", platform: "twitter", username: "udaysehgal", isActive: true },
    { _id: "acc_li", platform: "linkedin", username: "uday-sehgal", isActive: true },
    { _id: "acc_bs", platform: "bluesky", username: "uday.bsky.social", isActive: true },
  ];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const ch of req) body += ch;
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json", "x-request-id": "mock" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer mock") return send(401, { code: "unauthorized", error: "bad key" });
    if (url.pathname === "/api/v1/accounts") return send(200, { accounts });
    if (url.pathname === "/api/v1/tools/validate/post-length") {
      const t = JSON.parse(body).text;
      const xc = t.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;
      return send(200, { text: t, platforms: { twitter: { count: xc, limit: 280, valid: xc <= 280 }, linkedin: { count: t.length, limit: 3000, valid: t.length <= 3000 }, bluesky: { count: t.length, limit: 300, valid: t.length <= 300 } } });
    }
    if (url.pathname === "/api/v1/analytics/best-time") return send(200, { slots: [{ day_of_week: 1, hour: 16, avg_engagement: 88, post_count: 9 }, { day_of_week: 3, hour: 4, avg_engagement: 61, post_count: 7 }, { day_of_week: 5, hour: 9, avg_engagement: 40, post_count: 4 }] });
    if (url.pathname === "/api/v1/posts" && req.method === "POST") {
      const b = JSON.parse(body);
      const p = { _id: `post_${posts.length + 1}`, status: b.isDraft ? "draft" : "scheduled", ...b };
      posts.push(p);
      return send(201, { post: p });
    }
    if (url.pathname === "/api/v1/analytics") {
      const rng = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
      const weight = { performance: 3, feature: 2, fix: 1, infra: 0.6, docs: 0.4 };
      return send(200, { posts: posts.map((p) => {
        const kind = p.metadata.kind, r = rng(p.metadata.sha);
        const imp = Math.round((800 + (r % 900)) * weight[kind]);
        return { ...p, platformPostUrl: `https://x.com/udaysehgal/status/${r}`, analytics: { impressions: imp, likes: Math.round(imp * 0.03), comments: Math.round(imp * 0.004), shares: Math.round(imp * 0.006) } };
      }) });
    }
    send(404, { code: "not_found", error: url.pathname });
  });
  await new Promise((r) => server.listen(0, r));
  BASE = `http://127.0.0.1:${server.address().port}/api`;
  KEY = "mock";
  log(`mock Zernio on ${BASE}`);
  return server;
}

// ---------- main ----------
const commands = { plan, schedule, report };
const main = async () => {
  if (!commands[cmd] && cmd !== "demo") {
    console.log("usage: shipcast plan <repo> [--since DATE] [--max N] [--no-llm] | schedule [--publish] | report | demo <repo>   (add --mock to use a fake Zernio)");
    process.exit(1);
  }
  const server = flag("mock") || cmd === "demo" ? await startMock() : null;
  try {
    if (cmd === "demo") { await plan(); await schedule(); console.log(); await report(); }
    else await commands[cmd]();
  } finally { server?.close(); }
};
main().catch((e) => { console.error("shipcast:", e.message, e.cause?.code || e.cause?.message || "", e.requestId ? `(request ${e.requestId})` : ""); process.exit(1); });
