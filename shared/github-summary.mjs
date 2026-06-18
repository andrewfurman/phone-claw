const GITHUB_API_BASE = "https://api.github.com";

export async function githubSummary({
  itemType = "issues",
  scope = "involved",
  maxResults = 5,
  githubToken,
  username,
  fetchImpl = fetch,
}) {
  if (!githubToken) {
    return {
      ok: false,
      status: "github_auth_not_configured",
      message: "GITHUB_READ_TOKEN is not configured.",
      items: [],
    };
  }

  const normalizedType = normalizeItemType(itemType);
  const normalizedScope = normalizeScope(scope, normalizedType);
  const limit = clampInteger(maxResults, 1, 8);
  const account = username || (await fetchAuthenticatedUsername(githubToken, fetchImpl));
  const query = buildSearchQuery({
    itemType: normalizedType,
    scope: normalizedScope,
    username: account,
  });

  const url = new URL(`${GITHUB_API_BASE}/search/issues`);
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(limit));

  const response = await fetchImpl(url.toString(), {
    headers: githubHeaders(githubToken),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      status: "github_search_failed",
      github_status: response.status,
      message: body.message || "GitHub search failed.",
      query,
      items: [],
    };
  }

  const items = (body.items || []).map(summarizeSearchItem);
  return {
    ok: true,
    account,
    item_type: normalizedType,
    scope: normalizedScope,
    total_count: body.total_count || 0,
    returned_count: items.length,
    query,
    source_note:
      "Results come from GitHub issue search over repositories visible to the configured read token.",
    items,
    answer_text: formatGithubAnswer({
      account,
      itemType: normalizedType,
      scope: normalizedScope,
      totalCount: body.total_count || 0,
      items,
    }),
  };
}

async function fetchAuthenticatedUsername(githubToken, fetchImpl) {
  const response = await fetchImpl(`${GITHUB_API_BASE}/user`, {
    headers: githubHeaders(githubToken),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || !body.login) {
    throw new Error(body.message || "Could not resolve GitHub username.");
  }

  return body.login;
}

function githubHeaders(githubToken) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${githubToken}`,
    "user-agent": "phoneclaw/0.1 github-summary",
    "x-github-api-version": "2022-11-28",
  };
}

function buildSearchQuery({ itemType, scope, username }) {
  const typeQualifier = itemType === "pull_requests" ? "is:pr" : "is:issue";
  const scopeQualifier = scopeQualifierFor(scope, username);
  return `state:open ${typeQualifier} ${scopeQualifier} archived:false`;
}

function scopeQualifierFor(scope, username) {
  if (scope === "assigned") return `assignee:${username}`;
  if (scope === "authored") return `author:${username}`;
  if (scope === "mentioned") return `mentions:${username}`;
  if (scope === "review_requested") return `review-requested:${username}`;
  return `involves:${username}`;
}

function normalizeItemType(value) {
  const normalized = String(value || "").toLowerCase().replaceAll("-", "_");
  if (["pull_request", "pull_requests", "pr", "prs"].includes(normalized)) {
    return "pull_requests";
  }
  return "issues";
}

function normalizeScope(value, itemType) {
  const normalized = String(value || "").toLowerCase().replaceAll("-", "_");
  const allowed = new Set([
    "involved",
    "assigned",
    "authored",
    "mentioned",
    "review_requested",
  ]);
  if (!allowed.has(normalized)) return "involved";
  if (normalized === "review_requested" && itemType !== "pull_requests") {
    return "involved";
  }
  return normalized;
}

function summarizeSearchItem(item) {
  return {
    type: item.pull_request ? "pull_request" : "issue",
    repo: repoNameFromApiUrl(item.repository_url),
    number: item.number,
    title: item.title || "",
    url: item.html_url || "",
    author: item.user?.login || "",
    labels: (item.labels || []).map((label) => label.name).filter(Boolean),
    assignees: (item.assignees || []).map((assignee) => assignee.login).filter(Boolean),
    comments: item.comments || 0,
    created_at: item.created_at || "",
    updated_at: item.updated_at || "",
    excerpt: excerpt(item.body || ""),
  };
}

function repoNameFromApiUrl(value) {
  const match = String(value || "").match(/\/repos\/([^/]+\/[^/]+)$/);
  return match?.[1] || "";
}

function formatGithubAnswer({ account, itemType, scope, totalCount, items }) {
  const label = itemType === "pull_requests" ? "open pull requests" : "open issues";
  const scopeLabel = scope.replaceAll("_", " ");

  if (totalCount === 0) {
    return `GitHub shows no ${label} for ${account} matching ${scopeLabel}.`;
  }

  const intro = `GitHub shows ${totalCount} ${label} for ${account} matching ${scopeLabel}. Showing the ${items.length} most recently updated.`;
  const lines = items.map((item, index) => {
    const labels = item.labels.length > 0 ? ` Labels: ${item.labels.join(", ")}.` : "";
    const assignees =
      item.assignees.length > 0 ? ` Assigned to ${item.assignees.join(", ")}.` : "";
    const excerptText = item.excerpt ? ` ${item.excerpt}` : "";
    return `${index + 1}. ${item.repo} #${item.number}: ${item.title}. Updated ${item.updated_at}.${labels}${assignees}${excerptText}`;
  });

  return [intro, ...lines].join("\n");
}

function excerpt(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 220);
}

function clampInteger(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}
