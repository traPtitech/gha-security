import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

function commandViolation(file, line, command) {
  if (/\bnpm\s+install\b/.test(command)) {
    return {
      file, line, command,
      reason: "npm install は lockfile を厳密に使用しません。npm ci を使ってください",
    };
  }
  if (/\bpnpm\s+(?:install|i)\b/.test(command) && !/--frozen-lockfile\b/.test(command)) {
    return {
      file, line, command,
      reason: "pnpm install には --frozen-lockfile が必要です",
    };
  }
  if (/\byarn\s+(?:install|i)\b/.test(command) && !/(?:--immutable|--frozen-lockfile)\b/.test(command)) {
    return {
      file, line, command,
      reason: "yarn install には --immutable または --frozen-lockfile が必要です",
    };
  }
  if (/\bbun\s+install\b/.test(command) && !/--frozen-lockfile\b/.test(command)) {
    return {
      file, line, command,
      reason: "bun install には --frozen-lockfile が必要です",
    };
  }
  if (/\bcargo\s+(?:build|check|test|run|clippy|doc|bench)\b/.test(command) && !/--locked\b/.test(command)) {
    return {
      file, line, command,
      reason: "Cargo の依存解決を伴うコマンドには --locked が必要です",
    };
  }
  if (/\bgo\s+(?:build|test|list|vet|run|generate)\b/.test(command) && !/-mod=readonly\b/.test(command)) {
    return {
      file, line, command,
      reason: "Go の依存解決を伴うコマンドには -mod=readonly が必要です",
    };
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

/** Return CI commands that can update or ignore the committed lockfile. */
export function findWorkflowLockfileViolations(files) {
  const violations = [];
  for (const [file, text] of Object.entries(files)) {
    if (!WORKFLOW_PATH.test(file)) continue;
    for (const [index, raw] of text.split("\n").entries()) {
      const line = raw.replace(/\s+#.*$/, "").trim();
      if (!line || line.startsWith("#")) continue;
      const violation = commandViolation(file, index + 1, line.replace(/^[-\s]*run:\s*/, ""));
      if (violation) violations.push(violation);
    }
  }
  return violations;
}

function walk(root, current = root) {
  const out = {};
  for (const name of readdirSync(current)) {
    if ([".git", "node_modules", "vendor", ".venv"].includes(name)) continue;
    const path = join(current, name);
    if (statSync(path).isDirectory()) Object.assign(out, walk(root, path));
    else out[relative(root, path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
  }
  return out;
}

function main() {
  const files = walk(".");
  const lockfileViolations = findWorkflowLockfileViolations(files);
  const pinningViolations = findPackageJsonPinningViolations(files);
  if (lockfileViolations.length === 0 && pinningViolations.length === 0) {
    console.log("dependency-policy: CI の lockfile 強制と package.json の厳密 pinning を確認しました ✅");
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
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) main();
