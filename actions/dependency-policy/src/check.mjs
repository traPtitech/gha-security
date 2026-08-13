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
    if (/\bGOSUMDB\s*(?:=|:)\s*(?:["']?off["']?)(?:\s|$|#)/mi.test(text)) {
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

function main() {
  const files = walk(".");
  const lockfileViolations = findWorkflowLockfileViolations(files);
  const pinningViolations = findPackageJsonPinningViolations(files);
  const missingLockfiles = (process.env.REQUIRE_LOCKFILE ?? "true") === "true" ? findMissingLockfiles(files) : [];
  const goWarnings = findGoIntegrityWarnings(files);
  if (lockfileViolations.length === 0 && pinningViolations.length === 0 && missingLockfiles.length === 0) {
    console.log("dependency-policy: CI の lockfile 強制、package.json の厳密 pinning、lockfile の存在を確認しました ✅");
    for (const warning of goWarnings) console.log(`⚠️ \`${warning.file}\` — ${warning.reason}`);
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
  for (const warning of goWarnings) console.log(`⚠️ \`${warning.file}\` — ${warning.reason}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
