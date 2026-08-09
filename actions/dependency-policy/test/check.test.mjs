import { test } from "node:test";
import assert from "node:assert/strict";
import { findWorkflowLockfileViolations, findPackageJsonPinningViolations } from "../src/check.mjs";

test("findWorkflowLockfileViolations rejects mutable Node installs and accepts frozen installs", () => {
  const violations = findWorkflowLockfileViolations({
    ".github/workflows/ci.yaml": [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: npm install",
      "      - run: pnpm install --frozen-lockfile",
      "      - run: yarn install --immutable",
      "      - run: bun install --frozen-lockfile",
    ].join("\n"),
  });

  assert.deepEqual(violations, [{
    file: ".github/workflows/ci.yaml",
    line: 4,
    command: "npm install",
    reason: "npm install は lockfile を厳密に使用しません。npm ci を使ってください",
  }]);
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
