import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const TRUE_FLAG = (name) => new RegExp(`(?:^|\\s)${name}(?:\\s|$|=true(?:\\s|$))`);

function shellCommands(command) {
  return command.split(/\s*(?:&&|\|\||[;|])\s*/).map((part) => part.trim()).filter(Boolean);
}

function commandViolation(file, line, command) {
  if (/\bnpm\s+install\b/.test(command)) {
    return { file, line, command, reason: "npm install は lockfile を厳密に使用しません。npm ci を使ってください" };
  }
  if (/\bpnpm\s+(?:install|i)\b/.test(command) && !TRUE_FLAG("--frozen-lockfile").test(command)) {
    return { file, line, command, reason: "pnpm install には --frozen-lockfile が必要です" };
  }
  if (/\byarn\s+(?:install|i)\b/.test(command)
      && !TRUE_FLAG("--immutable").test(command) && !TRUE_FLAG("--frozen-lockfile").test(command)) {
    return { file, line, command, reason: "yarn install には --immutable または --frozen-lockfile が必要です" };
  }
  if (/\bbun\s+install\b/.test(command) && !TRUE_FLAG("--frozen-lockfile").test(command)) {
    return { file, line, command, reason: "bun install には --frozen-lockfile が必要です" };
  }
  return null;
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LOCAL_OR_WORKSPACE = /^(?:file:|link:|workspace:)/;

function isExactRegistrySpecifier(spec) {
  if (EXACT_SEMVER.test(spec)) return true;
  const alias = spec.match(/^npm:(?:@[^/]+\/)?[^@]+@(.+)$/);
  return Boolean(alias && EXACT_SEMVER.test(alias[1]));
}

/** Return package.json dependencies that are ranges or npm dist-tags. */
export function findPackageJsonPinningViolations(files) {
  const violations = [];
  for (const [file, text] of Object.entries(files)) {
    if (file.split("/").pop() !== "package.json") continue;
    let pkg;
    try { pkg = JSON.parse(text); } catch { continue; }
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
        if (typeof spec !== "string" || LOCAL_OR_WORKSPACE.test(spec) || isExactRegistrySpecifier(spec)) continue;
        violations.push({ file, section, name, spec });
      }
    }
  }
  return violations;
}

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
  "yarn.lock", "bun.lock", "bun.lockb",
]);

/** Return package.json paths with no lockfile in the same directory. */
export function findMissingLockfiles(files) {
  const paths = new Set(Object.keys(files));
  return Object.keys(files)
    .filter((file) => file.split("/").pop() === "package.json")
    .filter((file) => {
      const parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
      return ![...LOCKFILES].some((name) => paths.has(parent + name));
    })
    .sort();
}

/** Return non-blocking warnings for plainly disabled Go checksum verification. */
export function findGoIntegrityWarnings(files) {
  const warnings = [];
  const paths = new Set(Object.keys(files));
  for (const [file, text] of Object.entries(files)) {
    if (file.split("/").pop() === "go.mod" && /^\s*require\s+(?:\(|\S+)/m.test(text)) {
      const parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
      if (!paths.has(parent + "go.sum")) warnings.push({ file, reason: "外部 module を使う go.mod に go.sum がありません" });
    }
    const basename = file.split("/").pop();
    const isWorkflow = WORKFLOW_PATH.test(file);
    const isShell = /\.(?:sh|bash)$/.test(basename);
    const disablesSumdb = isWorkflow
      ? /^\s*GOSUMDB\s*:\s*["']?off["']?\s*(?:#.*)?$/mi.test(text)
      : isShell && /^\s*(?:export\s+)?GOSUMDB\s*=\s*["']?off["']?\s*(?:#.*)?$/mi.test(text);
    if (disablesSumdb) {
      warnings.push({ file, reason: "GOSUMDB=off により Go checksum database が無効化されています" });
    }
  }
  return warnings;
}
function indentation(raw) {
  return raw.length - raw.trimStart().length;
}

/** Return CI commands that can update or ignore the committed lockfile. */
export function findWorkflowLockfileViolations(files) {
  const violations = [];
  for (const [file, text] of Object.entries(files)) {
    if (!WORKFLOW_PATH.test(file)) continue;
    let blockIndent = null;
    for (const [index, raw] of text.split("\n").entries()) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = indentation(raw);
      let command = null;
      if (blockIndent !== null) {
        if (indent > blockIndent) command = trimmed.replace(/\s+#.*$/, "").trim();
        else blockIndent = null;
      }
      if (command === null) {
        const run = raw.match(/^\s*-?\s*run:\s*(.*)$/);
        if (!run) continue;
        if (/^[>|](?:[+-]?[1-9]?|[1-9]?[+-]?)\s*(?:#.*)?$/.test(run[1])) {
          blockIndent = indent;
          continue;
        }
        command = run[1].replace(/\s+#.*$/, "").trim();
      }
      if (!command) continue;
      for (const shellCommand of shellCommands(command)) {
        const violation = commandViolation(file, index + 1, shellCommand);
        if (violation) violations.push(violation);
      }
    }
  }
  return violations;
}

function walk(root, current = root) {
  const out = {};
  for (const name of readdirSync(current)) {
    if ([".git", "node_modules", "vendor", ".venv"].includes(name)) continue;
    const path = join(current, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) Object.assign(out, walk(root, path));
    else out[relative(root, path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
  }
  return out;
}

function escapeWorkflowCommandProperty(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A").replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function escapeWorkflowCommandMessage(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function emitGoWarnings(warnings) {
  for (const warning of warnings) {
    console.log(`::warning file=${escapeWorkflowCommandProperty(warning.file)}::${escapeWorkflowCommandMessage(warning.reason)}`);
    console.log(`⚠️ \`${warning.file}\` — ${warning.reason}`);
  }
}

const GO_WARNING_COMMENT_MARKER = "<!-- gha-security/go-integrity-warning -->";

function warningExcerpt(warning, files) {
  const lines = (files[warning.file] ?? "").split("\n");
  const line = lines.find((value) => warning.reason.startsWith("GOSUMDB") ? /^\s*(?:export\s+)?GOSUMDB\s*[:=]/.test(value) : /^\s*require\b/.test(value));
  return line?.trim() || warning.file;
}

function policyCommentBody({ warnings, lockfileViolations = [], pinningViolations = [], missingLockfiles = [] }, files = {}) {
  const failures = [
    ...lockfileViolations.map((v) => ({ ...v, title: "lockfileを更新しうるJSコマンド", excerpt: v.command, advice: "CIではlockfileを厳密に使うコマンドへ置き換えてください。" })),
    ...pinningViolations.map((v) => ({ ...v, title: "直接dependencyが厳密なバージョンで固定されていない", reason: `${v.name} は厳密なバージョンではありません。完全なversionへ固定してください。`, excerpt: `"${v.name}": "${v.spec}"` })),
    ...missingLockfiles.map((file) => ({ file, title: "対応するlockfileがない", reason: "同じディレクトリにlockfileがありません。", excerpt: "必要: package-lock.json / pnpm-lock.yaml / yarn.lock / bun.lock\n検出: lockfileなし" })),
  ];
  if (warnings.length === 0 && failures.length === 0) return `${GO_WARNING_COMMENT_MARKER}\ndependency-policy の指摘は解消されました ✅`;
  const lines = [GO_WARNING_COMMENT_MARKER];
  if (failures.length > 0) {
    lines.push(`### ❌ dependency-policy: 修正が必要な項目（${failures.length}件）`, "");
    failures.forEach((finding, index) => {
      const position = finding.line ? `:${finding.line}` : "";
      lines.push(`#### ${index + 1}. ${finding.title}`, "", `- 場所: \`${finding.file.replaceAll("`", "\\`")}${position}\``, `- 理由: ${finding.reason}`, "");
      lines.push("```text", finding.excerpt, "```", "");
      if (finding.advice) lines.push(finding.advice, "");
    });
    lines.push("このcheckは失敗しています。上記を修正して再実行してください。", "");
  }
  if (warnings.length > 0) {
    lines.push(`### ⚠️ Go integrity warning（${warnings.length}件）`, "");
    warnings.forEach((finding, index) => {
      lines.push(`#### ${index + 1}. ${finding.reason}`, "", `- 場所: \`${finding.file.replaceAll("`", "\\`")}\``, "");
      lines.push("```text", warningExcerpt(finding, files), "```", "");
    });
    lines.push("この確認はwarning-onlyです。CIは失敗しませんが、go.sumとGOSUMDB設定を確認してください。", "");
  }
  lines.push("このcommentは同一PR上で更新されます。commentの投稿失敗はCI結果を変えません。");
  const body = lines.join("\n");
  const maxCommentChars = 60000;
  if (body.length <= maxCommentChars) return body;
  return `${body.slice(0, maxCommentChars - 120)}\n\n---\n\n⚠️ 指摘が多いため、PR commentは先頭のみを表示しています。完全な一覧はcheck logを確認してください。`;
}

export async function syncGoWarningPrComment({ fetchImpl, api, repo, pr, token, warnings, lockfileViolations = [], pinningViolations = [], missingLockfiles = [], files = {} }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "dependency-policy",
    "content-type": "application/json",
  };
  const body = policyCommentBody({ warnings, lockfileViolations, pinningViolations, missingLockfiles }, files);
  const hasFindings = warnings.length + lockfileViolations.length + pinningViolations.length + missingLockfiles.length > 0;
  const comments = [];
  for (let page = 1; ; page += 1) {
    const listed = await fetchImpl(`${api}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`, { headers });
    if (!listed.ok) throw new Error(`list comments: HTTP ${listed.status}`);
    const currentPage = await listed.json();
    comments.push(...currentPage);
    if (currentPage.length < 100) break;
  }
  const existing = comments.find((comment) => typeof comment.body === "string" && comment.body.startsWith(GO_WARNING_COMMENT_MARKER));
  if (existing) {
    const updated = await fetchImpl(`${api}/repos/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ body }),
    });
    if (!updated.ok) throw new Error(`update comment: HTTP ${updated.status}`);
    return hasFindings ? "updated" : "resolved";
  }
  if (!hasFindings) return "skipped";
  const created = await fetchImpl(`${api}/repos/${repo}/issues/${pr}/comments`, {
    method: "POST", headers, body: JSON.stringify({ body }),
  });
  if (!created.ok) throw new Error(`create comment: HTTP ${created.status}`);
  return "created";
}

async function main() {
  const files = walk(".");
  const lockfileViolations = findWorkflowLockfileViolations(files);
  const pinningViolations = findPackageJsonPinningViolations(files);
  const missingLockfiles = (process.env.REQUIRE_LOCKFILE ?? "true") === "true" ? findMissingLockfiles(files) : [];
  const goWarnings = findGoIntegrityWarnings(files);
  if ((process.env.GO_WARNING_PR_COMMENT ?? "true") === "true"
      && process.env.PR_NUMBER && process.env.GITHUB_REPOSITORY && process.env.GITHUB_TOKEN) {
    try {
      await syncGoWarningPrComment({
        fetchImpl: globalThis.fetch,
        api: process.env.GITHUB_API_URL || "https://api.github.com",
        repo: process.env.GITHUB_REPOSITORY,
        pr: process.env.PR_NUMBER,
        token: process.env.GITHUB_TOKEN,
        warnings: goWarnings,
        lockfileViolations,
        pinningViolations,
        missingLockfiles,
        files,
      });
    } catch (error) {
      console.error(`Go integrity PR コメントの投稿に失敗しました（権限不足の可能性）: ${error.message}`);
    }
  }
  if (lockfileViolations.length === 0 && pinningViolations.length === 0 && missingLockfiles.length === 0) {
    console.log("dependency-policy: CI の lockfile 強制、package.json の厳密 pinning、lockfile の存在を確認しました ✅");
    emitGoWarnings(goWarnings);
    return;
  }
  if (lockfileViolations.length > 0) {
    console.log(`### dependency-policy: lockfile 強制違反が ${lockfileViolations.length} 件あります`);
    for (const v of lockfileViolations) console.log(`- \`${v.file}:${v.line}\` — ${v.reason}\n  \`${v.command}\``);
  }
  if (pinningViolations.length > 0) {
    console.log(`### dependency-policy: package.json の range / tag 指定が ${pinningViolations.length} 件あります`);
    for (const v of pinningViolations) console.log(`- \`${v.file}\` \`${v.section}.${v.name}\` = \`${v.spec}\``);
  }
  if (missingLockfiles.length > 0) {
    console.log(`### dependency-policy: package.json に対応する lockfile がないものが ${missingLockfiles.length} 件あります`);
    for (const file of missingLockfiles) console.log(`- \`${file}\` — package-lock.json / pnpm-lock.yaml / yarn.lock / bun.lock 等を同じディレクトリに追加してください`);
  }
  emitGoWarnings(goWarnings);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((error) => { console.error(error); process.exitCode = 3; });
}
