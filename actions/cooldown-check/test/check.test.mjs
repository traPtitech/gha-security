import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePackageLock, parsePnpmLock, parseYarnLock, parseBunLock,
  parsePackageJsonExact, parseGoMod, parseGoSum, parseWorkflowUses,
  diffDeps, globToRegExp, matchesAny, run,
} from "../src/check.mjs";

const get = (map, name) => [...(map.get(name) ?? [])];

test("parsePackageLock v3", () => {
  const map = parsePackageLock(JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "root", version: "1.0.0" },
      "node_modules/lodash": { version: "4.17.21" },
      "node_modules/@babel/core": { version: "7.24.0" },
      "node_modules/a/node_modules/b": { version: "2.0.0" },
      "packages/workspace-a": { version: "0.0.1" },
      "node_modules/linked": { link: true, version: "9.9.9" },
    },
  }));
  assert.deepEqual(get(map, "lodash"), ["4.17.21"]);
  assert.deepEqual(get(map, "@babel/core"), ["7.24.0"]);
  assert.deepEqual(get(map, "b"), ["2.0.0"]);
  assert.equal(map.has("root"), false);
  assert.equal(map.has("linked"), false);
});

test("parsePackageLock v1", () => {
  const map = parsePackageLock(JSON.stringify({
    lockfileVersion: 1,
    dependencies: { lodash: { version: "4.17.21", dependencies: { nested: { version: "1.0.0" } } } },
  }));
  assert.deepEqual(get(map, "lodash"), ["4.17.21"]);
  assert.deepEqual(get(map, "nested"), ["1.0.0"]);
});

test("parsePnpmLock v9/v6/v5 keys", () => {
  const map = parsePnpmLock([
    "packages:",
    "  'lodash@4.17.21':", "    resolution: {}",
    "  '@babel/core@7.24.0(peer@1.0.0)':", "    resolution: {}",
    "  /vue@3.4.0:", "    resolution: {}",
    "  /@scope/pkg/2.0.0:", "    resolution: {}",
    "  /old-style/1.2.3:", "    resolution: {}",
    "otherSection:",
    "  'not-a-pkg@9.9.9':",
  ].join("\n"));
  assert.deepEqual(get(map, "lodash"), ["4.17.21"]);
  assert.deepEqual(get(map, "@babel/core"), ["7.24.0"]);
  assert.deepEqual(get(map, "vue"), ["3.4.0"]);
  assert.deepEqual(get(map, "@scope/pkg"), ["2.0.0"]);
  assert.deepEqual(get(map, "old-style"), ["1.2.3"]);
  assert.equal(map.has("not-a-pkg"), false);
});

test("parseYarnLock v1 and berry", () => {
  const v1 = parseYarnLock([
    '"@scope/name@^1.0.0", "@scope/name@^1.2.0":',
    '  version "1.2.3"',
    "lodash@^4.0.0:",
    '  version "4.17.21"',
  ].join("\n"));
  assert.deepEqual(get(v1, "@scope/name"), ["1.2.3"]);
  assert.deepEqual(get(v1, "lodash"), ["4.17.21"]);
  const berry = parseYarnLock([
    "__metadata:",
    "  version: 8",
    '"react@npm:^18.0.0":',
    "  version: 18.3.1",
  ].join("\n"));
  assert.deepEqual(get(berry, "react"), ["18.3.1"]);
  assert.equal(berry.has("__metadata"), false);
});

test("parseBunLock", () => {
  const map = parseBunLock('{"packages": {"lodash": ["lodash@4.17.21", {}, "sha"], "x": ["@scope/y@2.0.0-beta.1"], "spec": "^9.9.9"}}');
  assert.deepEqual(get(map, "lodash"), ["4.17.21"]);
  assert.deepEqual(get(map, "@scope/y"), ["2.0.0-beta.1"]);
  assert.equal(map.has("spec"), false);
});

test("parsePackageJsonExact picks only exact versions and npm aliases", () => {
  const map = parsePackageJsonExact(JSON.stringify({
    dependencies: { exact: "1.2.3", range: "^1.2.3", alias: "npm:real-pkg@2.0.0" },
    devDependencies: { dev: "4.5.6-rc.1" },
  }));
  assert.deepEqual(get(map, "exact"), ["1.2.3"]);
  assert.deepEqual(get(map, "dev"), ["4.5.6-rc.1"]);
  assert.deepEqual(get(map, "real-pkg"), ["2.0.0"]);
  assert.equal(map.has("range"), false);
});

test("parseGoMod block and single require", () => {
  const map = parseGoMod([
    "module example.com/m",
    "go 1.22",
    "require github.com/single/dep v1.0.0",
    "require (",
    "\tgithub.com/labstack/echo/v5 v5.3.0",
    "\tgolang.org/x/crypto v0.21.0 // indirect",
    ")",
    "replace github.com/x/y => ../local",
  ].join("\n"));
  assert.deepEqual(get(map, "github.com/single/dep"), ["v1.0.0"]);
  assert.deepEqual(get(map, "github.com/labstack/echo/v5"), ["v5.3.0"]);
  assert.deepEqual(get(map, "golang.org/x/crypto"), ["v0.21.0"]);
  assert.equal(map.has("github.com/x/y"), false);
});

test("parseGoSum strips /go.mod suffix", () => {
  const map = parseGoSum([
    "github.com/a/b v1.2.3 h1:hash=",
    "github.com/a/b v1.2.3/go.mod h1:hash=",
  ].join("\n"));
  assert.deepEqual(get(map, "github.com/a/b"), ["v1.2.3"]);
});

test("parseWorkflowUses", () => {
  const set = parseWorkflowUses([
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        uses: actions/setup-node@v4",
    "      - uses: ./local-action",
    "      - uses: 'traPtitech/thing@v1'",
  ].join("\n"));
  assert.ok(set.has("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 v7.0.1"));
  assert.ok(set.has("actions/setup-node@v4 "));
  assert.ok(set.has("./local-action "));
});

test("diffDeps returns only added name@version", () => {
  const base = new Map([["a", new Set(["1.0.0"])], ["b", new Set(["2.0.0"])]]);
  const head = new Map([["a", new Set(["1.0.0", "1.1.0"])], ["b", new Set(["2.0.0"])], ["c", new Set(["3.0.0"])]]);
  assert.deepEqual(diffDeps(base, head), [
    { name: "a", version: "1.1.0" },
    { name: "c", version: "3.0.0" },
  ]);
});

test("glob exclude", () => {
  const pats = ["@traptitech/*", "traPtitech/*"].map(globToRegExp);
  assert.ok(matchesAny("@traptitech/traq", pats));
  assert.ok(matchesAny("traptitech/gha-security", pats));
  assert.ok(!matchesAny("lodash", pats));
});

test("run(): flags fresh versions, respects thresholds and excludes", async () => {
  const NOW = Date.parse("2026-07-24T00:00:00Z");
  const files = {
    base: {
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {
        "node_modules/old-pkg": { version: "1.0.0" },
      } }),
      ".github/workflows/ci.yaml": "      - uses: actions/checkout@v6\n",
      "go.mod": "require github.com/a/b v1.0.0\n",
    },
    head: {
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: {
        "node_modules/old-pkg": { version: "1.0.0" },
        "node_modules/fresh-pkg": { version: "2.0.0" },
        "node_modules/aged-pkg": { version: "3.0.0" },
        "node_modules/@traptitech/own": { version: "0.0.1" },
      } }),
      ".github/workflows/ci.yaml": "      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v7.0.1\n",
      "go.mod": "require github.com/a/b v1.1.0\n",
    },
  };
  const dates = {
    "npm:fresh-pkg@2.0.0": "2026-07-22T00:00:00Z",   // 2日前 → npm 7日しきい値で違反
    "npm:aged-pkg@3.0.0": "2026-06-01T00:00:00Z",    // 53日前 → OK
    "actions:actions/checkout@v7.0.1": "2026-07-23T00:00:00Z", // 1日前 → 3日しきい値で違反
    "go:github.com/a/b@v1.1.0": "2026-07-01T00:00:00Z", // 23日前 → OK
  };
  const lookups = {
    npm: async (n, v) => dates[`npm:${n}@${v}`] ? { date: new Date(dates[`npm:${n}@${v}`]) } : { warn: "not found" },
    go: async (n, v) => dates[`go:${n}@${v}`] ? { date: new Date(dates[`go:${n}@${v}`]) } : { warn: "not found" },
    action: async (o, r, t) => dates[`actions:${o}/${r}@${t}`] ? { date: new Date(dates[`actions:${o}/${r}@${t}`]) } : { warn: "not found" },
  };
  const result = await run({
    changedFiles: Object.keys(files.head),
    readFileAt: (sha, f) => files[sha]?.[f] ?? "",
    baseSha: "base", headSha: "head",
    minAgeDays: 3, npmMinAgeDays: 7,
    excludePatterns: ["@traptitech/*", "traPtitech/*"],
    lookups, now: NOW,
  });
  const flagged = result.violations.map((v) => `${v.eco}:${v.name}@${v.version}`).sort();
  assert.deepEqual(flagged, ["actions:actions/checkout@v7.0.1", "npm:fresh-pkg@2.0.0"]);
  assert.equal(result.warnings.length, 0);
  // 除外された自 org パッケージは照会もされない
  assert.equal(result.checked, 4);
});
