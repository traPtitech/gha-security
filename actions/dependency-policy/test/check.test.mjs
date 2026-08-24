import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  findWorkflowLockfileViolations, findPackageJsonPinningViolations,
  findMissingLockfiles, findGoIntegrityWarnings, syncGoWarningPrComment,
} from "../src/check.mjs";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(sourceDir, "../src/check.mjs");

function workflow(lines) {
  return { ".github/workflows/ci.yaml": lines.join("\n") };
}

test("findWorkflowLockfileViolations detects only direct JS install commands", () => {
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
    "      - run: pip install -r requirements.txt",
    "      - run: cargo test",
    "      - run: go test ./...",
  ]));

  assert.deepEqual(violations, [{
    file: ".github/workflows/ci.yaml",
    line: 4,
    command: "npm install",
    reason: "npm install は lockfile を厳密に使用しません。npm ci を使ってください",
  }]);
});

test("findWorkflowLockfileViolations rejects false JS flags and ignores unrelated commands", () => {
  const violations = findWorkflowLockfileViolations(workflow([
    "      - run: pnpm install --frozen-lockfile=false",
    "      - run: yarn install --immutable=false",
    "      - run: bun install --frozen-lockfile=false",
    "      - run: pip install -r requirements.txt",
    "      - run: echo --frozen-lockfile && pnpm install",
  ]));

  assert.deepEqual(violations.map(({ line, command, reason }) => ({ line, command, reason })), [
    { line: 1, command: "pnpm install --frozen-lockfile=false", reason: "pnpm install には --frozen-lockfile が必要です" },
    { line: 2, command: "yarn install --immutable=false", reason: "yarn install には --immutable または --frozen-lockfile が必要です" },
    { line: 3, command: "bun install --frozen-lockfile=false", reason: "bun install には --frozen-lockfile が必要です" },
    { line: 5, command: "pnpm install", reason: "pnpm install には --frozen-lockfile が必要です" },
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
    "          yarn install",
    "      - run: yarn install --immutable",
  ]));

  assert.deepEqual(violations.map(({ line, command }) => ({ line, command })), [
    { line: 8, command: "npm install" },
    { line: 10, command: "yarn install" },
  ]);
});

test("findWorkflowLockfileViolations recognizes YAML block scalar indentation and chomping indicators", () => {
  const headers = ["|2", ">2-", "|-2"];
  for (const header of headers) {
    const violations = findWorkflowLockfileViolations(workflow([
      `      - run: ${header}`,
      "          npm install",
      "          pnpm install",
    ]));
    assert.deepEqual(violations.map(({ line, command }) => ({ line, command })), [
      { line: 2, command: "npm install" },
      { line: 3, command: "pnpm install" },
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


test("findMissingLockfiles requires one supported lockfile beside each package.json", () => {
  const missing = findMissingLockfiles({
    "apps/web/package.json": "{}",
    "apps/api/package.json": "{}",
    "apps/api/pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "packages/lib/package.json": "{}",
    "packages/lib/yarn.lock": "# yarn lockfile v1",
  });
  assert.deepEqual(missing, ["apps/web/package.json"]);
});

test("findGoIntegrityWarnings reports missing go.sum and repository GOSUMDB=off", () => {
  const warnings = findGoIntegrityWarnings({
    "cmd/tool/go.mod": "module example/tool\nrequire example.com/dep v1.2.3\n",
    ".github/workflows/ci.yaml": "env:\n  GOSUMDB: off\n",
    "scripts/build.sh": "export GOSUMDB=off\n",
    "README.md": "GOSUMDB=off はwarningになる、という説明だけです\n",
    "test.mjs": "const sample = 'GOSUMDB=off';\n",
  });
  assert.deepEqual(warnings, [
    { file: "cmd/tool/go.mod", reason: "外部 module を使う go.mod に go.sum がありません" },
    { file: ".github/workflows/ci.yaml", reason: "GOSUMDB=off により Go checksum database が無効化されています" },
    { file: "scripts/build.sh", reason: "GOSUMDB=off により Go checksum database が無効化されています" },
  ]);
});

test("syncGoWarningPrComment creates, updates, and resolves one sticky PR comment", async () => {
  const calls = [];
  const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  let existing = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/comments?per_page=100")) return response(existing);
    if (options.method === "POST") return response({ id: 7 }, true, 201);
    if (options.method === "PATCH") return response({ id: 7 });
    throw new Error(`unexpected request: ${url}`);
  };
  const common = { fetchImpl, api: "https://api.example", repo: "owner/repo", pr: 12, token: "redacted" };
  const warnings = [{ file: "cmd/tool/go.mod", reason: "go.sum がありません" }];

  assert.equal(await syncGoWarningPrComment({ ...common, warnings }), "created");
  assert.match(JSON.parse(calls.at(-1).options.body).body, /cmd\/tool\/go\.mod/);

  existing = [{ id: 7, body: "<!-- gha-security/go-integrity-warning -->\nold" }];
  assert.equal(await syncGoWarningPrComment({ ...common, warnings }), "updated");
  assert.match(JSON.parse(calls.at(-1).options.body).body, /go\.sum がありません/);

  assert.equal(await syncGoWarningPrComment({ ...common, warnings: [] }), "resolved");
  assert.match(JSON.parse(calls.at(-1).options.body).body, /解消されました/);
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

    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { exact: "1.2.3" } }));
    result = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /対応する lockfile/);
    result = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8", env: { ...process.env, REQUIRE_LOCKFILE: "false" } });
    assert.equal(result.status, 0);

    mkdirSync(join(root, "cmd/tool,with:percent%"), { recursive: true });
    writeFileSync(join(root, "cmd/tool,with:percent%/go.mod"), "module example/tool\nrequire example.com/dep v1.2.3\n");
    result = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8", env: { ...process.env, REQUIRE_LOCKFILE: "false" } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /::warning file=cmd\/tool%2Cwith%3Apercent%25\/go\.mod::外部 module を使う go\.mod に go\.sum がありません/);
    assert.match(result.stdout, /⚠️ `cmd\/tool,with:percent%\/go\.mod` — 外部 module を使う go\.mod に go\.sum がありません/);

    writeFileSync(join(root, ".github/workflows/ci.yaml"), "- run: npm install\n");
    result = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8", env: { ...process.env, REQUIRE_LOCKFILE: "false" } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /npm install/);
    assert.match(result.stdout, /::warning file=cmd\/tool%2Cwith%3Apercent%25\/go\.mod::外部 module を使う go\.mod に go\.sum がありません/);
    assert.match(result.stdout, /⚠️ `cmd\/tool,with:percent%\/go\.mod` — 外部 module を使う go\.mod に go\.sum がありません/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
