import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { loadPhoneclawEnv } from "../shared/load-env-file.mjs";
import { universalCliTool, universalPrompt, endCallTool } from "../shared/universal-cli-agent.mjs";
import { UNIVERSAL_CLI_VERSION } from "../fastify-app/universal-cli.mjs";

if (!process.env.ELEVENLABS_API_KEY) loadPhoneclawEnv();
const env = process.env;
const token = env.WEB_SEARCH_TOKEN || env.COMMAND_BRIDGE_TOKEN;
const base = env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const url = new URL("/cli/run", base).toString();
const agentId = env.ELEVENLABS_AGENT_ID;
const apiKey = env.ELEVENLABS_API_KEY;
if (!token || !agentId || !apiKey) throw new Error("Missing ElevenLabs agent credentials or Worker tool token.");
const guide = await readFile(new URL("../elevenlabs-setup/prompt-templates/universal-cli.md", import.meta.url), "utf8");
const config = universalCliTool({ url, token });
async function api(path, method = "GET", body) {
  const r = await fetch(`https://api.elevenlabs.io/v1/convai${path}`, { method, headers: { "xi-api-key": apiKey, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`ElevenLabs ${method} returned HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}
const original = await api(`/agents/${agentId}`);
const oldPrompt = original.conversation_config.agent.prompt;
const prompt = universalPrompt(oldPrompt.prompt || "", guide);
const builtins = { ...oldPrompt.built_in_tools, end_call: endCallTool };
const summary = { agent_id: agentId, application_tools: ["run_cli"], system_tools: Object.keys(builtins), tool_url: url, guide_sha256: createHash("sha256").update(guide).digest("hex"), previous_tool_count: oldPrompt.tool_ids?.length || 0 };
if (!process.argv.includes("--apply")) {
  console.log(JSON.stringify({ ...summary, applied: false, next: "Deploy and validate the matching bridge/Worker, then rerun with --apply." }, null, 2));
} else {
  if (new URL(url).protocol !== "https:") throw new Error("Agent tool must use HTTPS.");
  const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ command: "phoneclaw", args: ["help"] }), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Bridge preflight returned HTTP ${r.status}`);
  const preflight = await r.json();
  if (!preflight.ok || preflight.runner_version !== UNIVERSAL_CLI_VERSION) throw new Error("Deploy the matching universal runner before changing the agent.");
  // A private backup lives outside the checkout; never export auth-bearing JSON
  // to the repository. A new tool record also avoids mutating other agents.
  const backupDir = await mkdtemp(join(tmpdir(), "phoneclaw-agent-backup-"));
  const backupPath = join(backupDir, "agent.json");
  await writeFile(backupPath, JSON.stringify(original), { mode: 0o600, flag: "wx" });
  let created;
  try {
    created = await api("/tools", "POST", { tool_config: config });
    await api(`/agents/${agentId}`, "PATCH", { conversation_config: { agent: { prompt: { prompt, tool_ids: [created.id], built_in_tools: builtins } } }, version_description: "Issue 106: universal CLI and Markdown command guide" });
    const actual = await api(`/agents/${agentId}`);
    const next = actual.conversation_config.agent.prompt;
    if (next.prompt !== prompt || !isDeepStrictEqual(next.tool_ids, [created.id])) throw new Error("Agent tool/prompt verification failed.");
    const before = structuredClone(original.conversation_config), after = structuredClone(actual.conversation_config);
    for (const value of [before, after]) for (const key of ["prompt", "tools", "tool_ids", "built_in_tools"]) delete value.agent.prompt[key];
    if (!isDeepStrictEqual(before, after) || !isDeepStrictEqual(original.platform_settings, actual.platform_settings)) throw new Error("Unrelated agent settings changed.");
    console.log(JSON.stringify({ ...summary, applied: true, tool_id: created.id, backup_path: backupPath, other_settings_preserved: true }, null, 2));
  } catch (error) {
    if (created) {
      // Tool IDs and inline tools are mutually exclusive on PATCH. Restore IDs.
      try {
        const { tools: ignored, ...restore } = oldPrompt;
        await api(`/agents/${agentId}`, "PATCH", { conversation_config: { agent: { prompt: restore } }, version_description: "Restore configuration after universal CLI migration failure" });
        await api(`/tools/${created.id}`, "DELETE");
      } catch {
        console.error(`Automatic agent restoration needs attention. Protected backup: ${backupPath}`);
      }
    }
    throw error;
  }
}
