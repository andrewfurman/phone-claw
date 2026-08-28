const apiBase = process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io";
const agentId = process.env.ELEVENLABS_AGENT_ID;
const apiKey = process.env.ELEVENLABS_API_KEY;

if (!agentId || !apiKey) {
  console.error("Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY.");
  process.exit(1);
}

const agent = await requestJson(`${apiBase}/v1/convai/agents/${agentId}`);
const promptConfig = agent.conversation_config?.agent?.prompt || {};
const prompt = String(promptConfig.prompt || "");
const tools = Array.isArray(promptConfig.tools) ? promptConfig.tools : [];
const claudeTool = tools.find((tool) => tool.name === "claude_code");
const urlFetchTool = tools.find((tool) => tool.name === "url_fetch");
const emailListTool = tools.find((tool) => tool.name === "himalaya_email_list");
const emailReadTool = tools.find((tool) => tool.name === "himalaya_email_read");
const claudeResponseProperties =
  claudeTool?.api_schema?.response_body_schema?.properties || {};

const checks = {
  claude_code_tool_configured: Boolean(claudeTool),
  claude_code_schema_has_auth_probe: Boolean(claudeResponseProperties.auth_probe),
  url_fetch_tool_configured: Boolean(urlFetchTool),
  email_lookup_tools_configured: Boolean(emailListTool && emailReadTool),
  prompt_has_unsubscribe_workflow: /Email unsubscribe and interactive link workflows:/i.test(
    prompt
  ),
  prompt_requires_email_identification:
    /identify the exact email/i.test(prompt) && /unsubscribe.*preference URL/i.test(prompt),
  prompt_requires_confirmation:
    /ask Andrew to confirm/i.test(prompt) && /Do not set confirmed=true/i.test(prompt),
  prompt_uses_url_fetch_for_verification:
    /Use url_fetch with purpose="unsubscribe" and confirmed=true/i.test(prompt),
  prompt_escalates_interactive_pages_to_claude:
    /JavaScript-heavy content, a form, buttons, multiple choices/i.test(prompt) &&
    /claude_code action="submit_task"/i.test(prompt),
  prompt_tells_claude_to_use_playwright:
    /use Playwright or another headless browser/i.test(prompt) &&
    /inspect the DOM and screenshots/i.test(prompt),
  prompt_records_async_status:
    /job_id/i.test(prompt) &&
    /job_status/i.test(prompt) &&
    /Treat the unsubscribe as confirmed only when job_status returns completed/i.test(prompt),
  prompt_has_stop_conditions:
    /login wall/i.test(prompt) &&
    /CAPTCHA/i.test(prompt) &&
    /payment\/checkout/i.test(prompt) &&
    /account deletion/i.test(prompt),
};

const ok = Object.values(checks).every(Boolean);
console.log(
  JSON.stringify(
    {
      ok,
      agent_id: agentId,
      claude_code_url: claudeTool?.api_schema?.url || null,
      url_fetch_url: urlFetchTool?.api_schema?.url || null,
      checks,
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 1);

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`ElevenLabs request failed (${response.status}): ${text}`);
  }

  return JSON.parse(text);
}
