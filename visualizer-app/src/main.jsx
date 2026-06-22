import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import "./styles.css";

const AUTO_REFRESH_MS = 5000;

function App() {
  return (
    <BrowserRouter basename="/visualizer">
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/conversation/:conversationId" element={<Dashboard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function Dashboard() {
  const navigate = useNavigate();
  const { conversationId } = useParams();
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [bootstrap, setBootstrap] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");

  const loadBootstrap = async () => {
    const params = new URLSearchParams({ limit: "14" });
    if (submittedQuery) params.set("query", submittedQuery);

    setError("");
    const data = await requestJson(`/visualizer/api/bootstrap?${params}`);
    setBootstrap(data);
    setLoading(false);

    const conversations = mergedConversations(data);
    const nextId = conversationId || conversations[0]?.conversation_id;
    if (!conversationId && nextId) {
      navigate(`/conversation/${encodeURIComponent(nextId)}`, { replace: true });
    }
  };

  useEffect(() => {
    loadBootstrap().catch((err) => {
      setLoading(false);
      setError(err.message);
    });
  }, [submittedQuery]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(() => {
      loadBootstrap().catch((err) => setError(err.message));
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, submittedQuery, conversationId]);

  useEffect(() => {
    if (!conversationId) {
      setSelected(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    requestJson(`/visualizer/api/conversations/${encodeURIComponent(conversationId)}`)
      .then((data) => {
        if (!cancelled) setSelected(data.conversation || null);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const conversations = useMemo(() => mergedConversations(bootstrap), [bootstrap]);
  const selectedConversation =
    selected || conversations.find((item) => item.conversation_id === conversationId) || null;
  const twilioEvents = bootstrap?.twilio_events?.events || [];
  const selectedEvents = selectedConversation?.twilio_call_sid
    ? twilioEvents.filter((event) => event.call_sid === selectedConversation.twilio_call_sid)
    : twilioEvents;
  const draftLinks = extractDraftLinks(selectedConversation);
  const health = bootstrap?.health || {};

  const onSearchSubmit = (event) => {
    event.preventDefault();
    setSubmittedQuery(query.trim());
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Phoneclaw</div>
          <h1>Live conversations</h1>
        </div>
        <div className="topbar-actions">
          <StatusPill label="Bridge" ok={health.cli_bridge_configured} />
          <StatusPill label="Events" ok={health.twilio_event_log_configured} />
          <label className="switch">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            <span>Live</span>
          </label>
          <button className="icon-button" type="button" title="Refresh" onClick={loadBootstrap}>
            ↻
          </button>
          <a className="logout-link" href="/visualizer/logout">
            Logout
          </a>
        </div>
      </header>

      <section className="toolbar" aria-label="Conversation filters">
        <form className="search-form" onSubmit={onSearchSubmit}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search summaries, transcripts, keywords"
          />
          <button type="submit">Search</button>
        </form>
        <button
          className="secondary-button"
          type="button"
          onClick={() =>
            requestJson("/visualizer/api/archive-latest", { method: "POST" })
              .then(loadBootstrap)
              .catch((err) => setError(err.message))
          }
        >
          Archive latest
        </button>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="workspace">
        <aside className="conversation-list" aria-label="Conversations">
          <div className="panel-heading">
            <h2>Recent</h2>
            <span>{loading ? "Loading" : `${conversations.length} shown`}</span>
          </div>
          <div className="list-items">
            {conversations.map((conversation) => (
              <ConversationListItem
                key={`${conversation.source}-${conversation.conversation_id}`}
                conversation={conversation}
                selected={conversation.conversation_id === conversationId}
              />
            ))}
            {!loading && conversations.length === 0 ? (
              <div className="empty-state">No conversations found.</div>
            ) : null}
          </div>
        </aside>

        <section className="conversation-detail" aria-label="Selected conversation">
          {selectedConversation ? (
            <>
              <ConversationHeader conversation={selectedConversation} loading={detailLoading} />
              <div className="detail-grid">
                <section className="transcript-panel">
                  <div className="panel-heading">
                    <h2>Transcript</h2>
                    <span>{turnsFor(selectedConversation).length} turns</span>
                  </div>
                  <Transcript conversation={selectedConversation} />
                </section>
                <aside className="side-panel">
                  <DraftLinks links={draftLinks} />
                  <ToolCalls conversation={selectedConversation} />
                  <TwilioEvents events={selectedEvents} />
                </aside>
              </div>
            </>
          ) : (
            <div className="empty-detail">Select a conversation.</div>
          )}
        </section>
      </section>
    </main>
  );
}

function ConversationListItem({ conversation, selected }) {
  return (
    <Link
      className={`conversation-row ${selected ? "selected" : ""}`}
      to={`/conversation/${encodeURIComponent(conversation.conversation_id)}`}
    >
      <div className="row-title">
        <span>{conversationLabel(conversation)}</span>
        <Badge value={conversation.source === "live" ? "live" : "archive"} />
      </div>
      <div className="row-meta">
        <span>{formatDateTime(conversation.started_at || conversation.updated_at)}</span>
        <span>{conversation.status || "unknown"}</span>
        <span>{toolCount(conversation)} tools</span>
      </div>
      {conversation.summary ? <p>{conversation.summary}</p> : null}
    </Link>
  );
}

function ConversationHeader({ conversation, loading }) {
  return (
    <header className="detail-header">
      <div>
        <div className="eyebrow">{conversation.source === "live" ? "ElevenLabs live" : "Archive"}</div>
        <h2>{conversationLabel(conversation)}</h2>
        <div className="header-meta">
          <span>{formatDateTime(conversation.started_at || conversation.updated_at)}</span>
          <span>{conversation.status || "unknown"}</span>
          {conversation.duration_seconds != null ? (
            <span>{formatDuration(conversation.duration_seconds)}</span>
          ) : null}
          {conversation.twilio_call_sid ? <span>{conversation.twilio_call_sid}</span> : null}
        </div>
      </div>
      {loading ? <Badge value="syncing" /> : <Badge value={conversation.status || "loaded"} />}
    </header>
  );
}

function Transcript({ conversation }) {
  const turns = turnsFor(conversation);
  if (turns.length === 0) return <div className="empty-state">No transcript yet.</div>;

  return (
    <div className="transcript">
      {turns.map((turn, index) => (
        <article className={`turn ${turn.role || "event"}`} key={turn.id || index}>
          <div className="turn-role">{turn.role || "event"}</div>
          <div className="turn-body">
            {turn.message ? <p>{turn.message}</p> : <p className="muted">No spoken text.</p>}
            {Array.isArray(turn.tool_calls) && turn.tool_calls.length > 0 ? (
              <div className="inline-tools">
                {turn.tool_calls.map((call, callIndex) => (
                  <ToolCallCard item={normalizeToolItem(call, "call")} key={call.id || callIndex} />
                ))}
              </div>
            ) : null}
            {Array.isArray(turn.tool_results) && turn.tool_results.length > 0 ? (
              <div className="inline-tools">
                {turn.tool_results.map((result, resultIndex) => (
                  <ToolCallCard
                    item={normalizeToolItem(result, "result")}
                    key={result.id || resultIndex}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function ToolCalls({ conversation }) {
  const items = allToolItems(conversation);
  return (
    <section className="tool-panel">
      <div className="panel-heading">
        <h2>Tool calls</h2>
        <span>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="empty-state">No tool calls recorded.</div>
      ) : (
        <div className="tool-stack">
          {items.map((item, index) => (
            <ToolCallCard item={item} key={`${item.type}-${item.name}-${index}`} />
          ))}
        </div>
      )}
    </section>
  );
}

function ToolCallCard({ item }) {
  return (
    <div className={`tool-card ${item.type}`}>
      <div className="tool-card-header">
        <span>{item.name || "tool"}</span>
        <Badge value={item.type} />
      </div>
      {item.action ? <div className="tool-action">{item.action}</div> : null}
      <pre>{JSON.stringify(item.preview, null, 2)}</pre>
    </div>
  );
}

function DraftLinks({ links }) {
  return (
    <section className="draft-panel">
      <div className="panel-heading">
        <h2>Gmail drafts</h2>
        <span>{links.length}</span>
      </div>
      {links.length === 0 ? (
        <div className="empty-state">No draft tools in this conversation.</div>
      ) : (
        <div className="draft-links">
          {links.map((link, index) => (
            <a href={link.href} target="_blank" rel="noreferrer" key={`${link.href}-${index}`}>
              <span>{link.label}</span>
              <small>{link.subject || link.draftId || "Open in Gmail"}</small>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function TwilioEvents({ events }) {
  return (
    <section className="events-panel">
      <div className="panel-heading">
        <h2>Twilio events</h2>
        <span>{events.length}</span>
      </div>
      {events.length === 0 ? (
        <div className="empty-state">No recent Twilio events.</div>
      ) : (
        <div className="events-list">
          {events.map((event) => (
            <div className="event-row" key={event.id || `${event.received_at}-${event.event_type}`}>
              <div>
                <strong>{event.event_type || event.stream_event || event.call_status}</strong>
                <span>{formatDateTime(event.received_at)}</span>
              </div>
              <small>{event.call_sid || event.stream_sid || event.source}</small>
              {event.stream_error ? <p>{event.stream_error}</p> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function StatusPill({ label, ok }) {
  return <span className={`status-pill ${ok ? "ok" : "warn"}`}>{label}</span>;
}

function Badge({ value }) {
  return <span className="badge">{value}</span>;
}

function mergedConversations(data) {
  if (!data) return [];
  const map = new Map();
  for (const item of data.archived_conversations?.items || []) {
    if (item?.conversation_id) {
      map.set(item.conversation_id, { ...item, source: "archive" });
    }
  }
  for (const item of data.live_conversations?.items || []) {
    if (item?.conversation_id) {
      map.set(item.conversation_id, { ...map.get(item.conversation_id), ...item, source: "live" });
    }
  }
  return [...map.values()].sort((left, right) =>
    String(right.started_at || right.updated_at || "").localeCompare(
      String(left.started_at || left.updated_at || "")
    )
  );
}

function turnsFor(conversation) {
  return (
    conversation?.transcript ||
    conversation?.transcript_excerpt ||
    conversation?.details?.transcript ||
    []
  );
}

function allToolItems(conversation) {
  const turns = turnsFor(conversation);
  const items = [];
  for (const turn of turns) {
    for (const call of turn.tool_calls || []) items.push(normalizeToolItem(call, "call"));
    for (const result of turn.tool_results || []) items.push(normalizeToolItem(result, "result"));
  }
  for (const call of conversation?.tool_calls || []) items.push(normalizeToolItem(call, "call"));
  for (const result of conversation?.tool_results || []) items.push(normalizeToolItem(result, "result"));
  return dedupeToolItems(items);
}

function normalizeToolItem(item, type) {
  const parsedParams = parseJson(item.params_as_json || item.params || item.parameters || {});
  const parsedResult = parseJson(item.result_value || item.result || item.value || {});
  const preview = type === "result" ? parsedResult : parsedParams;
  return {
    type,
    name: item.tool_name || item.name || parsedResult?.tool_name || "",
    action: parsedResult?.action || parsedParams?.action || "",
    preview: compactPreview(preview),
  };
}

function dedupeToolItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.type}:${item.name}:${JSON.stringify(item.preview).slice(0, 500)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractDraftLinks(conversation) {
  const links = [];
  for (const item of allToolItems(conversation)) {
    const value = item.preview || {};
    const action = value.action || item.action || "";
    if (!["draft_created", "reply_draft_created", "forward_draft_created"].includes(action)) {
      continue;
    }
    const subject = value.subject || "";
    const draftId = value.draft_id || value.id || "";
    const search = subject ? `in:drafts "${subject}"` : "in:drafts";
    links.push({
      label:
        action === "forward_draft_created"
          ? "Forward draft"
          : action === "reply_draft_created"
            ? "Reply draft"
            : "New draft",
      subject,
      draftId,
      href: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(search)}`,
    });
  }
  return links;
}

function compactPreview(value) {
  if (!value || typeof value !== "object") return value;
  const allowed = [
    "action",
    "status",
    "ok",
    "to",
    "cc",
    "bcc",
    "subject",
    "id",
    "draft_id",
    "source_folder",
    "draft_folder",
    "query",
    "repo",
    "path",
    "answer_text",
    "error",
    "message",
  ];
  const output = {};
  for (const key of allowed) {
    if (value[key] != null && value[key] !== "") output[key] = value[key];
  }
  return Object.keys(output).length ? output : value;
}

function conversationLabel(conversation) {
  return (
    conversation.summary?.split(".")[0]?.slice(0, 90) ||
    conversation.conversation_id ||
    "Conversation"
  );
}

function toolCount(conversation) {
  return conversation.tool_call_count ?? allToolItems(conversation).filter((item) => item.type === "call").length;
}

function parseJson(value) {
  if (!value || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = parseJson(text);
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.message || body?.status || `Request failed (${response.status})`);
  }
  return body;
}

function formatDateTime(value) {
  if (!value) return "unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total)) return "";
  const minutes = Math.floor(total / 60);
  const rest = Math.round(total % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

createRoot(document.getElementById("root")).render(<App />);
