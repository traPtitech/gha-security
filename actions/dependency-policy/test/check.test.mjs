import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { findWorkflowLockfileViolations, findPackageJsonPinningViolations } from "../src/check.mjs";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(sourceDir, "../src/check.mjs");

function workflow(lines) {
  return { ".github/workflows/ci.yaml": lines.join("\n") };
}

test("findWorkflowLockfileViolations rejects mutable installs and accepts lockfile-enforced commands", () => {
  const violations = findWorkflowLockfileViolations(workflow([
    "jobs:",
    "  test:",
    "    steps:",
    "      - run: npm install",
    "      - run: pnpm install --frozen-lockfile",
    "      - run: pnpm install --frozen-lockfile=true",
    "      - run: yarn install --immutable",
    "      - run: yarn install --frozen-lockfile=true",
    "      - run: bun install --frozen-lockfile",
    "      - run: bun install --frozen-lockfile=true",
    "      - run: python -m pip install -r requirements.txt --require-hashes",
    "      - run: cargo test --locked",
    "      - run: go test -mod=readonly ./...",
  ]));

  assert.deepEqual(violations, [{
    file: ".github/workflows/ci.yaml",
    line: 4,
    command: "npm install",
    reason: "npm install は lockfile を厳密に使用しません。npm ci を使ってください",
  }]);
});

test("findWorkflowLockfileViolations rejects false flags, unhashed pip requirements, and flags from other shell commands", () => {
  const violations = findWorkflowLockfileViolations(workflow([
    "      - run: pnpm install --frozen-lockfile=false",
    "      - run: yarn install --immutable=false",
    "      - run: bun install --frozen-lockfile=false",
    "      - run: pip install -r requirements.txt",
    "      - run: python -m pip install -r requirements.txt --require-hashes",
    "      - run: echo --frozen-lockfile && pnpm install",
    "      - run: pip install -r a.txt --require-hashes && pip install -r b.txt",
  ]));

  assert.deepEqual(violations.map(({ line, command, reason }) => ({ line, command, reason })), [
    { line: 1, command: "pnpm install --frozen-lockfile=false", reason: "pnpm install には --frozen-lockfile が必要です" },
    { line: 2, command: "yarn install --immutable=false", reason: "yarn install には --immutable または --frozen-lockfile が必要です" },
    { line: 3, command: "bun install --frozen-lockfile=false", reason: "bun install には --frozen-lockfile が必要です" },
    { line: 4, command: "pip install -r requirements.txt", reason: "pip install -r には --require-hashes が必要です" },
    { line: 6, command: "pnpm install", reason: "pnpm install には --frozen-lockfile が必要です" },
    { line: 7, command: "pip install -r b.txt", reason: "pip install -r には --require-hashes が必要です" },
  ]);
});

test("findWorkflowLockfileViolations inspects only inline and block run commands", () => {
  const violations = findWorkflowLockfileViolations(workflow([
    "      - name: npm install dependencies",
    "        env:",
    "          MESSAGE: npm install",
    "        with:",
    "          note: npm install",
    "      - run: |",
    "          echo preparing",
    "          npm install",
    "      - run: >-",
    "          pip install -r requirements.txt",
    "      - run: yarn install --immutable",
  ]));

  assert.deepEqual(violations.map(({ line, command }) => ({ line, command })), [
    { line: 8, command: "npm install" },
    { line: 10, command: "pip install -r requirements.txt" },
  ]);
});

test("findWorkflowLockfileViolations recognizes YAML block scalar indentation and chomping indicators", () => {
  const headers = ["|2", ">2-", "|-2"];
  for (const header of headers) {
    const violations = findWorkflowLockfileViolations(workflow([
      `      - run: ${header}`,
      "          npm install",
      "          pip install -r requirements.txt",
    ]));
    assert.deepEqual(violations.map(({ line, command }) => ({ line, command })), [
      { line: 2, command: "npm install" },
      { line: 3, command: "pip install -r requirements.txt" },
    ], header);
  }
});

test("findPackageJsonPinningViolations rejects ranges and dist-tags but permits exact and local specs", () => {
  const violations = findPackageJsonPinningViolations({
    "package.json": JSON.stringify({
      dependencies: {
        exact: "1.2.3",
        ranged: "^2.0.0",
        tagged: "latest",
        alias: "npm:real-package@3.4.5",
        workspace: "workspace:*",
        local: "file:../local",
      },
      devDependencies: { tilde: "~4.0.0" },
      peerDependencies: { wildcard: "*" },
      optionalDependencies: { comparator: ">=5.0.0" },
    }),
  });
  assert.deepEqual(violations, [
    { file: "package.json", section: "dependencies", name: "ranged", spec: "^2.0.0" },
    { file: "package.json", section: "dependencies", name: "tagged", spec: "latest" },
    { file: "package.json", section: "devDependencies", name: "tilde", spec: "~4.0.0" },
    { file: "package.json", section: "peerDependencies", name: "wildcard", spec: "*" },
    { file: "package.json", section: "optionalDependencies", name: "comparator", spec: ">=5.0.0" },
  ]);
});

test("CLI exits 1 for policy violations, exits 0 when clean, and ignores symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "dependency-policy-"));
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/ci.yaml"), "- run: npm install\n");
    symlinkSync(".", join(root, "cycle"));
    let result = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /npm install/);

    writeFileSync(join(root, ".github/workflows/ci.yaml"), "- run: npm ci\n");
    result = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
