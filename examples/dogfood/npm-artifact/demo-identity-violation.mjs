import { run } from "../../../actions/cooldown-check/src/check.mjs";

const base = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": { dependencies: { lodash: "4.17.21" } },
    "node_modules/lodash": {
      version: "4.17.21",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      integrity: "sha512-before"
    }
  }
});
const head = base.replace("sha512-before", "sha512-after");
const file = "examples/dogfood/npm-artifact/package-lock.json";
const output = await run({
  changedFiles: [file],
  readFileAt: (sha) => sha === "base" ? base : head,
  baseSha: "base",
  headSha: "head",
  thresholds: { npm: 0, actions: 0 },
  excludePatterns: [],
  lookups: { npm: async () => ({ warn: "unexpected lookup" }), action: async () => ({ warn: "unexpected lookup" }) },
  now: Date.now(),
});

for (const violation of output.violations) console.error(`identity violation: ${violation.name} — ${violation.reason}`);
if (!output.violations.some((v) => v.eco === "identity")) {
  console.error("expected npm artifact identity violation was not detected");
  process.exit(2);
}
process.exit(1);
