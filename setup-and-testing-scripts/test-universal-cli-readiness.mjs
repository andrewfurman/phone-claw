import { loadPhoneclawEnv } from "../shared/load-env-file.mjs";
import { runUniversalCli, UNIVERSAL_CLI_VERSION } from "../fastify-app/universal-cli.mjs";
import { UNIVERSAL_SMOKE_SCENARIOS, smokeRequest, validateSmokeResult } from "../shared/universal-cli-smoke-scenarios.mjs";

if (!process.env.ELEVENLABS_API_KEY) loadPhoneclawEnv();
const checks = [];
for (const scenario of UNIVERSAL_SMOKE_SCENARIOS) {
  const result = await runUniversalCli({ ...smokeRequest(scenario), timeoutMs: 60_000 });
  const check = { scenario: scenario.id, ok: validateSmokeResult(scenario, result), status: result.status, data_status: result.data?.status || "" };
  checks.push(check);
  console.log(JSON.stringify(check));
}
console.log(JSON.stringify({ runner_version: UNIVERSAL_CLI_VERSION, checks, note: "Read-only provider probes; private result contents omitted." }));
process.exitCode = checks.every(check => check.ok) ? 0 : 1;
