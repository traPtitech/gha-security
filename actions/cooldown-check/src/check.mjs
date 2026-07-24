#!/usr/bin/env node
// cooldown-check: PR の diff から新規追加/変更された依存を抽出し、
// 公開から min-age 日未満のバージョンが入っていたら fail する。
//
// 対象 (v1): npm (package-lock / pnpm-lock / yarn.lock / bun.lock / package.json の厳密指定),
//            Go (go.mod / go.sum), GitHub Actions (uses:)
// 公開日時はレジストリ側の記録のみを信頼する:
//   npm registry `time` / Go module proxy `.info` / GitHub Releases `published_at`
// コミット日時・タグ日時は作者が偽装できるため使わない。
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- parsers (pure) ----------

function add(map, name, version) {
  if (!name || !version) return;
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(version);
}

export function parsePackageLock(text) {
  const map = new Map();
  let data;
  try { data = JSON.parse(text); } catch { return map; }
  if (data && typeof data.packages === "object" && data.packages) {
    for (const [key, meta] of Object.entries(data.packages)) {
      if (!key || !meta || !meta.version || meta.link) continue;
      const idx = key.lastIndexOf("node_modules/");
      if (idx === -1) continue; // ワークスペース自身など
      add(map, key.slice(idx + "node_modules/".length), meta.version);
    }
  } else if (data && typeof data.dependencies === "object") {
    const walk = (deps) => {
      for (const [name, meta] of Object.entries(deps || {})) {
        if (meta && meta.version) add(map, name, meta.version);
        if (meta && meta.dependencies) walk(meta.dependencies);
      }
    };
    walk(data.dependencies);
  }
  return map;
}

export function parsePnpmLock(text) {
  const map = new Map();
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^(packages|snapshots):\s*$/.test(line)) { inPackages = true; continue; }
    if (/^\S/.test(line)) { inPackages = false; continue; }
    if (!inPackages) continue;
    const m = line.match(/^ {2}(['"]?)(\S[^:]*)\1:\s*$/);
    if (!m) continue;
    let key = m[2].replace(/\(.*$/, ""); // peer サフィックス除去
    if (key.startsWith("/")) key = key.slice(1);
    const at = key.lastIndexOf("@");
    if (at > 0) {
      add(map, key.slice(0, at), key.slice(at + 1));
    } else {
      // pnpm-lock v5: name/1.2.3 または @scope/name/1.2.3
      const parts = key.split("/");
      if (parts.length >= 2) add(map, parts.slice(0, -1).join("/"), parts[parts.length - 1]);
    }
  }
  return map;
}

export function parseYarnLock(text) {
  const map = new Map();
  let currentNames = [];
  for (const line of text.split("\n")) {
    if (/^[^\s#].*:\s*$/.test(line)) {
      currentNames = [];
      for (let token of line.replace(/:\s*$/, "").split(/,\s*/)) {
        token = token.replace(/^["']|["']$/g, "");
        if (token === "__metadata") continue;
        const at = token.startsWith("@") ? token.indexOf("@", 1) : token.indexOf("@");
        if (at > 0) currentNames.push(token.slice(0, at));
      }
      continue;
    }
    const vm = line.match(/^ {2}version:?\s+"?([^"\s]+)"?\s*$/);
    if (vm) for (const name of currentNames) add(map, name, vm[1]);
  }
  return map;
}

export function parseBunLock(text) {
  const map = new Map();
  for (const m of text.matchAll(/"((?:@[^/"]+\/)?[^@/"]+)@(\d[^"]*)"/g)) {
    if (/^\d+\.\d+\.\d+/.test(m[2])) add(map, m[1], m[2]);
  }
  return map;
}

export function parsePackageJsonExact(text) {
  const map = new Map();
  let data;
  try { data = JSON.parse(text); } catch { return map; }
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(data?.[section] ?? {})) {
      if (typeof spec !== "string") continue;
      if (/^\d+\.\d+\.\d+/.test(spec)) { add(map, name, spec); continue; }
      const alias = spec.match(/^npm:(.+)@(\d+\.\d+\.\d+.*)$/); // npm:real-name@1.2.3
      if (alias) add(map, alias[1], alias[2]);
    }
  }
  return map;
}

export function parseGoMod(text) {
  const map = new Map();
  let inRequire = false;
  for (const line of text.split("\n")) {
    if (/^require\s*\(/.test(line)) { inRequire = true; continue; }
    if (inRequire && /^\)/.test(line)) { inRequire = false; continue; }
    const single = line.match(/^require\s+(\S+)\s+(v\S+)/);
    if (single) { add(map, single[1], single[2]); continue; }
    if (inRequire) {
      const m = line.match(/^\s+(\S+)\s+(v\S+)/);
      if (m) add(map, m[1], m[2]);
    }
  }
  return map;
}

export function parseGoSum(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^(\S+)\s+(v\S+?)(\/go\.mod)?\s+h1:/);
    if (m) add(map, m[1], m[2]);
  }
  return map;
}

export function parseWorkflowUses(text) {
  // Set<"spec comment">
  const set = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*-?\s*uses:\s*["']?([^\s"'#]+)["']?(?:\s*#\s*(\S+))?/);
    if (m) set.add(`${m[1]} ${m[2] ?? ""}`);
  }
  return set;
}

export function diffDeps(base, head) {
  const added = [];
  for (const [name, versions] of head) {
    for (const v of versions) {
      if (!base.get(name)?.has(v)) added.push({ name, version: v });
    }
  }
  return added;
}

export function globToRegExp(pattern) {
  return new RegExp("^" + pattern.trim().split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
}

export function matchesAny(name, regexps) {
  return regexps.some((r) => r.test(name));
}

// ---------- registry lookups ----------

function goEscape(s) {
  return s.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());
}

export function makeLookups(fetchImpl, token, apiUrl = "https://api.github.com") {
  const cache = new Map();
  const get = async (url, headers = {}) => {
    if (cache.has(url)) return cache.get(url);
    let result = null;
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
      if (res.ok) result = await res.json();
      else result = { __status: res.status };
    } catch { result = { __error: true }; }
    cache.set(url, result);
    return result;
  };
  return {
    // 返り値: { date: Date } | { warn: string }
    async npm(name, version) {
      const data = await get(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
      const t = data?.time?.[version];
      if (t) return { date: new Date(t) };
      return { warn: `npm registry に ${name}@${version} の公開日時が見つかりません` };
    },
    async go(module_, version) {
      const data = await get(`https://proxy.golang.org/${goEscape(module_)}/@v/${goEscape(version)}.info`);
      if (data?.Time) return { date: new Date(data.Time) };
      return { warn: `Go proxy に ${module_}@${version} の公開日時が見つかりません` };
    },
    async action(owner, repo, tag) {
      const headers = { "user-agent": "cooldown-check", accept: "application/vnd.github+json" };
      if (token) headers.authorization = `Bearer ${token}`;
      for (const t of [tag, tag.startsWith("v") ? tag.slice(1) : `v${tag}`]) {
        const data = await get(`${apiUrl}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(t)}`, headers);
        if (data?.published_at) return { date: new Date(data.published_at) };
      }
      return { warn: `${owner}/${repo} のリリース ${tag} の公開日時が取得できません（リリース未作成の可能性）` };
    },
  };
}

// ---------- main ----------

const NPM_LOCKFILES = new Map([
  ["package-lock.json", parsePackageLock],
  ["npm-shrinkwrap.json", parsePackageLock],
  ["pnpm-lock.yaml", parsePnpmLock],
  ["yarn.lock", parseYarnLock],
  ["bun.lock", parseBunLock],
]);

export async function run(ctx) {
  // thresholds: { npm, go, actions } — 0 以下でそのエコシステムのチェックを無効化
  const { changedFiles, readFileAt, baseSha, headSha, thresholds,
          excludePatterns, lookups, now } = ctx;
  const excludes = excludePatterns.map(globToRegExp);
  const violations = [];
  const warnings = [];
  const targets = []; // {eco, name, version, file, threshold}

  const collect = (file, parser, eco) => {
    const threshold = thresholds[eco];
    if (!(threshold > 0)) return; // 無効化されたエコシステム
    const base = parser(readFileAt(baseSha, file));
    const head = parser(readFileAt(headSha, file));
    for (const { name, version } of diffDeps(base, head)) {
      if (matchesAny(name, excludes)) continue;
      targets.push({ eco, name, version, file, threshold });
    }
  };

  for (const file of changedFiles) {
    const basename = file.split("/").pop();
    if (file.includes("node_modules/")) continue;
    if (NPM_LOCKFILES.has(basename)) {
      collect(file, NPM_LOCKFILES.get(basename), "npm");
    } else if (basename === "package.json") {
      collect(file, parsePackageJsonExact, "npm");
    } else if (basename === "go.mod") {
      collect(file, parseGoMod, "go");
    } else if (basename === "go.sum") {
      collect(file, parseGoSum, "go");
    } else if (/^\.github\/(workflows\/[^/]+\.ya?ml|actions\/.+\/action\.ya?ml)$/.test(file)) {
      if (!(thresholds.actions > 0)) continue; // 無効化されたエコシステム
      const base = parseWorkflowUses(readFileAt(baseSha, file));
      const head = parseWorkflowUses(readFileAt(headSha, file));
      for (const entry of head) {
        if (base.has(entry)) continue;
        const [spec, comment] = entry.split(" ");
        if (spec.startsWith("./") || spec.startsWith("docker://")) continue;
        const [pathPart, ref] = [spec.slice(0, spec.lastIndexOf("@")), spec.slice(spec.lastIndexOf("@") + 1)];
        if (!pathPart || !ref) continue;
        const [owner, repo] = pathPart.split("/");
        if (!owner || !repo || matchesAny(`${owner}/${repo}`, excludes)) continue;
        const isSha = /^[0-9a-f]{40}$/.test(ref);
        const version = isSha ? comment : ref;
        if (!version) {
          warnings.push(`${file}: \`${spec}\` は SHA 固定ですがバージョンコメントがないため公開日時を確認できません`);
          continue;
        }
        targets.push({ eco: "actions", name: `${owner}/${repo}`, version, file, threshold: thresholds.actions });
      }
    }
  }

  // 重複除去して照会
  const seen = new Set();
  for (const t of targets) {
    const key = `${t.eco}:${t.name}@${t.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let result;
    if (t.eco === "npm") result = await lookups.npm(t.name, t.version);
    else if (t.eco === "go") result = await lookups.go(t.name, t.version);
    else result = await lookups.action(...t.name.split("/"), t.version);
    if (result.warn) { warnings.push(`${t.file}: ${result.warn}`); continue; }
    const ageDays = (now - result.date.getTime()) / DAY_MS;
    if (ageDays < t.threshold) {
      violations.push({ ...t, published: result.date.toISOString(), ageDays });
    }
  }
  return { violations, warnings, checked: seen.size };
}

// ---------- PR sticky comment ----------

export const COMMENT_MARKER = "<!-- gha-security/cooldown-check -->";

// 違反があれば sticky コメントを作成/更新し、解消されたら ✅ に更新する。
// クリーンな PR に ✅ コメントを新規作成はしない（ノイズ防止）。
export async function syncPrComment({ fetchImpl, api, repo, pr, token, output, hasViolations }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "cooldown-check",
    "content-type": "application/json",
  };
  const body = hasViolations
    ? `${COMMENT_MARKER}\n${output}`
    : `${COMMENT_MARKER}\ncooldown-check: 指摘した違反は解消されました ✅`;
  const res = await fetchImpl(`${api}/repos/${repo}/issues/${pr}/comments?per_page=100`, { headers });
  if (!res.ok) throw new Error(`list comments: HTTP ${res.status}`);
  const comments = await res.json();
  const mine = comments.find((c) => typeof c.body === "string" && c.body.startsWith(COMMENT_MARKER));
  if (mine) {
    await fetchImpl(`${api}/repos/${repo}/issues/comments/${mine.id}`,
      { method: "PATCH", headers, body: JSON.stringify({ body }) });
    return "updated";
  }
  if (hasViolations) {
    await fetchImpl(`${api}/repos/${repo}/issues/${pr}/comments`,
      { method: "POST", headers, body: JSON.stringify({ body }) });
    return "created";
  }
  return "skipped";
}

// ---------- CLI ----------

function git(...args) {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : "";
}

async function main() {
  const baseSha = process.env.BASE_SHA;
  const headSha = process.env.HEAD_SHA;
  if (!baseSha || !headSha) {
    console.error("BASE_SHA / HEAD_SHA が未設定です");
    process.exit(3);
  }
  const mergeBase = git("merge-base", baseSha, headSha).trim() || baseSha;
  const changedFiles = git("diff", "--name-only", mergeBase, headSha).split("\n").filter(Boolean);

  const result = await run({
    changedFiles,
    readFileAt: (sha, file) => git("show", `${sha}:${file}`),
    baseSha: mergeBase,
    headSha,
    thresholds: {
      npm: Number(process.env.NPM_MIN_AGE_DAYS ?? 7),
      go: Number(process.env.GO_MIN_AGE_DAYS ?? 3),
      actions: Number(process.env.ACTIONS_MIN_AGE_DAYS ?? 3),
    },
    excludePatterns: (process.env.EXCLUDE_PATTERNS ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
    lookups: makeLookups(globalThis.fetch, process.env.GITHUB_TOKEN, process.env.GITHUB_API_URL),
    now: Date.now(),
  });

  const lines = [];
  if (result.violations.length > 0) {
    lines.push(`### ❄️ cooldown-check: 公開から日が浅いバージョンが ${result.violations.length} 件見つかりました`);
    lines.push("", "| 種別 | パッケージ | バージョン | 公開日時 | 経過 | しきい値 | ファイル |", "|---|---|---|---|---|---|---|");
    for (const v of result.violations) {
      lines.push(`| ${v.eco} | \`${v.name}\` | \`${v.version}\` | ${v.published.slice(0, 10)} | ${v.ageDays.toFixed(1)}日 | ${v.threshold}日 | \`${v.file}\` |`);
    }
    lines.push("", "公開直後のバージョンはサプライチェーン攻撃の検知が間に合っていない可能性があります。",
      "しきい値の日数が経過してから再実行するか、緊急の場合は PR に override ラベルを付けてください。");
  } else {
    lines.push(`cooldown-check: 追加/変更された依存 ${result.checked} 件はすべて cooldown を満たしています ✅`);
  }
  if (result.warnings.length > 0) {
    lines.push("", "<details><summary>⚠️ 確認できなかったもの（fail にはしません）</summary>", "");
    lines.push(...result.warnings.map((w) => `- ${w}`));
    lines.push("", "</details>");
  }

  const output = lines.join("\n");
  console.log(output);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, output + "\n");

  if ((process.env.PR_COMMENT ?? "true") === "true"
      && process.env.PR_NUMBER && process.env.GITHUB_REPOSITORY && process.env.GITHUB_TOKEN) {
    try {
      await syncPrComment({
        fetchImpl: globalThis.fetch,
        api: process.env.GITHUB_API_URL || "https://api.github.com",
        repo: process.env.GITHUB_REPOSITORY,
        pr: process.env.PR_NUMBER,
        token: process.env.GITHUB_TOKEN,
        output,
        hasViolations: result.violations.length > 0,
      });
    } catch (e) {
      // fork PR などでは書き込み権限がない。チェック結果自体には影響させない
      console.error(`PR コメントの投稿に失敗しました（権限不足の可能性）: ${e.message}`);
    }
  }
  process.exit(result.violations.length > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((e) => { console.error(e); process.exit(3); });
}
