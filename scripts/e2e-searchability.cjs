const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const dir = mkdtempSync(join(tmpdir(), "nenkin-e2e-"));
const inputPath = join(dir, "companies.csv");
const outputPath = join(dir, "enriched.csv");

writeFileSync(
  inputPath,
  [
    "カナ,都道府県,住所",
    "フィールドエックス,東京都,神泉町",
    "スペース,東京都,中野区新井",
  ].join("\n"),
  "utf8",
);

execFileSync(
  process.execPath,
  ["dist/cli.js", "enrich", inputPath, "--out", outputPath, "--delay-ms", "100"],
  {
    cwd: join(__dirname, ".."),
    stdio: "inherit",
  },
);

const output = readFileSync(outputPath, "utf8");
const singleResolve = execFileSync(
  process.execPath,
  ["dist/cli.js", "resolve", "--kana", "フィールドエックス", "--pref", "東京都", "--address", "神泉町"],
  {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const singleEnrich = execFileSync(
  process.execPath,
  ["dist/cli.js", "enrich", "--kana", "スペース", "--pref", "東京都", "--address", "中野区新井"],
  {
    cwd: join(__dirname, ".."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const expectations = [
  ["Field X corporate number", "3011001176197"],
  ["Field X insured count", '"2",""'],
  ["Space corporate number", "9011201002742"],
  ["Space insured count", '"45",""'],
];

const missing = expectations.filter(([, value]) => !output.includes(value));
if (missing.length > 0) {
  console.error(output);
  throw new Error(`Missing E2E expectations: ${missing.map(([label]) => label).join(", ")}`);
}

if (!singleResolve.includes("3011001176197")) {
  console.error(singleResolve);
  throw new Error("Missing single resolve expectation: Field X corporate number");
}

if (!singleEnrich.includes("9011201002742") || !singleEnrich.includes("被保険者数: 45")) {
  console.error(singleEnrich);
  throw new Error("Missing single enrich expectation: Space insured count");
}

console.log(`ok: searchability E2E passed (${outputPath})`);
