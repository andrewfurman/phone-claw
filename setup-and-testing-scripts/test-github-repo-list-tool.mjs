const workerBaseUrl =
  process.env.PHONECLAW_WORKER_BASE_URL || "https://webhooks.aifurman.com";
const toolToken = process.env.WEB_SEARCH_TOKEN || process.env.COMMAND_BRIDGE_TOKEN;

if (!toolToken) {
  console.error("Missing WEB_SEARCH_TOKEN or COMMAND_BRIDGE_TOKEN.");
  process.exit(1);
}

const recent = await postGithubCommon({
  action: "repo_list",
  limit: 10,
  sort: "pushed",
});
const coverNode = await postGithubCommon({
  action: "repo_list",
  owner: "cover-node",
  limit: 5,
  sort: "pushed",
});

const recentOwners = new Set((recent.items || []).map((item) => item.owner));
const coverNodeOwners = new Set((coverNode.items || []).map((item) => item.owner));
const checks = {
  recent_ok: recent.ok === true,
  recent_action_repo_list: recent.action === "repo_list",
  recent_returned_items: Number(recent.returned_count || 0) > 0,
  recent_includes_personal_repo: recentOwners.has("andrewfurman"),
  recent_includes_covernode_repo: recentOwners.has("cover-node"),
  recent_limit_not_noisy: Number(recent.returned_count || 0) <= 10,
  covernode_ok: coverNode.ok === true,
  covernode_action_repo_list: coverNode.action === "repo_list",
  covernode_returned_items: Number(coverNode.returned_count || 0) > 0,
  covernode_only_covernode_owner:
    coverNodeOwners.size > 0 && [...coverNodeOwners].every((owner) => owner === "cover-node"),
};

const ok = Object.values(checks).every(Boolean);
console.log(
  JSON.stringify(
    {
      ok,
      recent: summarizeRepoList(recent),
      cover_node: summarizeRepoList(coverNode),
      checks,
    },
    null,
    2
  )
);

process.exit(ok ? 0 : 1);

async function postGithubCommon(body) {
  const response = await fetch(`${workerBaseUrl}/cli/github/common`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${toolToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = parseMaybeJson(text);
  if (!response.ok || parsed?.ok !== true) {
    throw new Error(`github_cli_common failed (${response.status}): ${text}`);
  }
  return parsed;
}

function summarizeRepoList(result) {
  return {
    action: result.action,
    owner: result.owner || "",
    sort: result.sort,
    returned_count: result.returned_count,
    total_count: result.total_count,
    has_more: result.has_more,
    repos: (result.items || []).slice(0, 10).map((item) => ({
      name_with_owner: item.name_with_owner,
      visibility: item.visibility,
      pushed_at: item.pushed_at,
      primary_language: item.primary_language,
    })),
  };
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
