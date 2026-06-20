const apiBase = process.env.NEON_API_BASE || "https://console.neon.tech/api/v2";
const apiKey = process.env.NEON_API_KEY;
const projectName = process.env.NEON_PROJECT_NAME || "phoneclaw-conversations";
const regionId = process.env.NEON_REGION_ID || "aws-us-east-1";
const pgVersion = Number(process.env.NEON_PG_VERSION || 17);

if (!apiKey) {
  console.error("Missing NEON_API_KEY. Export it in the shell before running this script.");
  process.exit(1);
}

const existing = await findProjectByName(projectName);
const project = existing || (await createProject());
const connectionUri = await getConnectionUri(project);

console.log(
  JSON.stringify(
    {
      ok: true,
      project_id: project.id,
      project_name: project.name,
      region_id: project.region_id,
      default_branch_id: project.default_branch_id || project.branch?.id || "",
      database_url_config_name: "CONVERSATION_DATABASE_URL",
      connection_uri_redacted: redactConnectionUri(connectionUri),
      next_step:
        "Set CONVERSATION_DATABASE_URL to the unredacted URI in /etc/phoneclaw/bridge.env, then restart phoneclaw-bridge.",
    },
    null,
    2
  )
);

async function findProjectByName(name) {
  const body = await neonJson("/projects");
  return (body.projects || []).find((project) => project.name === name) || null;
}

async function createProject() {
  const body = await neonJson("/projects", {
    method: "POST",
    body: JSON.stringify({
      project: {
        name: projectName,
        region_id: regionId,
        pg_version: pgVersion,
      },
    }),
  });

  await waitForOperations(body.project?.id, body.operations || []);
  return body.project;
}

async function getConnectionUri(project) {
  const url = new URL(`${apiBase}/projects/${encodeURIComponent(project.id)}/connection_uri`);
  url.searchParams.set("pooled", "true");
  const body = await neonJson(url);
  return body.uri || body.connection_uri || body.connectionUri || "";
}

async function waitForOperations(projectId, operations) {
  if (!projectId) return;
  const ids = operations.map((operation) => operation.id).filter(Boolean);
  for (const id of ids) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const body = await neonJson(
        `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(id)}`
      );
      const status = body.operation?.status || body.status;
      if (["finished", "completed", "succeeded"].includes(status)) break;
      if (["failed", "error"].includes(status)) {
        throw new Error(`Neon operation ${id} failed.`);
      }
      await wait(2_000);
    }
  }
}

async function neonJson(pathOrUrl, options = {}) {
  const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(`${apiBase}${pathOrUrl}`);
  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = parseMaybeJson(text);
  if (!response.ok) {
    throw new Error(`Neon API failed (${response.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactConnectionUri(value) {
  return String(value || "").replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:[redacted]@");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
