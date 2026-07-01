#!/usr/bin/env node
const { spawnSync } = require("node:child_process");

const skip = process.env.NENKIN_SKIP_PY_DEPS === "1";
if (skip) {
  process.exit(0);
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasCurlCffi() {
  const result = run("python3", ["-c", "import curl_cffi"]);
  return result.status === 0;
}

if (hasCurlCffi()) {
  process.exit(0);
}

process.stderr.write("[nenkin] Installing Python dependency: curl_cffi\n");
const install = run("python3", ["-m", "pip", "install", "--user", "curl_cffi"]);
if (install.status === 0 && hasCurlCffi()) {
  process.stderr.write("[nenkin] curl_cffi is ready.\n");
  process.exit(0);
}

process.stderr.write(`[nenkin] Could not install curl_cffi automatically.

Please run:
  python3 -m pip install --user curl_cffi

To skip this install hook in CI:
  NENKIN_SKIP_PY_DEPS=1 npm install

pip output:
${install.stderr || install.stdout || "(no output)"}
`);
