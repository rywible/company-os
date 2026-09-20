import { DiscoveryPage } from "./discovery";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { MarkdownNode } from "../markdown-types";
import {
  Inbox,
  Briefcase,
  Brain,
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Command,
  ExternalLink,
  FileText,
  GitBranch,
  History,
  Layers3,
  Loader2,
  Menu,
  MoreHorizontal,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  Terminal,
  X,
} from "lucide-react";
import type { Document } from "../contracts";
import type {
  CompanyState,
  Command as CompanyCommand,
  Thread,
  Work,
  Run,
  Context,
  Policy,
  Settings,
} from "../domain/model";
type Knowledge = Document & { policy: Policy };
type Workspace = CompanyState & {
  documents: Knowledge[];
  configured: boolean;
  deliveryErrors: { id: string; error: string; attempts: number }[];
  workflows: { name: string; steps: string[] }[];
};
import "./styles.css";
import {
  ConnectionNotice,
  InstallCard,
  useConnection,
  useMobileViewport,
} from "./platform";
import "./pwa";

async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (response.status === 401 && path !== "/login")
    window.dispatchEvent(new Event("workspace-locked"));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const names: Record<string, string> = {
  constitution: "Foundation",
  product: "Product",
  architecture: "Architecture",
  execution: "Sequence",
};
const eventName = (type: string) =>
  type
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (s) => s.toUpperCase());

function Diagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setError(false);
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: {
          primaryColor: "#f5f5f5",
          secondaryColor: "#ffffff",
          tertiaryColor: "#eeeeee",
          primaryTextColor: "#171717",
          primaryBorderColor: "#888888",
          lineColor: "#555555",
          fontFamily: "system-ui",
          fontSize: "13px",
        },
      });
      try {
        const { svg } = await mermaid.render(
          "diagram-" + crypto.randomUUID().replaceAll("-", ""),
          source,
        );
        if (active && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (active) setError(true);
      }
    });
    return () => {
      active = false;
    };
  }, [source]);
  return error ? (
    <pre className="diagram-error">
      Diagram could not render. Source:
      {source}
    </pre>
  ) : (
    <div className="diagram-frame">
      <div
        className="diagram"
        ref={ref}
        role="region"
        tabIndex={0}
        aria-label="Architecture diagram"
      />
      <p className="diagram-hint">Swipe to explore the diagram</p>
    </div>
  );
}
const markdownCache = new Map<string, Promise<MarkdownNode[]>>();
window.addEventListener("workspace-locked", () => markdownCache.clear());
function loadMarkdown(source: string) {
  let pending = markdownCache.get(source);
  if (!pending) {
    pending = api<{ nodes: MarkdownNode[] }>("/markdown", {
      method: "POST",
      body: JSON.stringify({ source }),
    })
      .then((result) => result.nodes)
      .catch((error) => {
        markdownCache.delete(source);
        throw error;
      });
    if (markdownCache.size >= 64)
      markdownCache.delete(markdownCache.keys().next().value!);
    markdownCache.set(source, pending);
  }
  return pending;
}
function markdownText(nodes: MarkdownNode[]): string {
  return nodes
    .map((n) => (typeof n === "string" ? n : markdownText(n.children)))
    .join("");
}
function markdownElement(node: MarkdownNode, key: number): React.ReactNode {
  if (typeof node === "string") return node;
  const { tag, props, children } = node;
  const content = children.map(markdownElement);
  if (tag === "pre")
    return props.language === "mermaid" ? (
      <Diagram key={key} source={markdownText(children).trim()} />
    ) : (
      <div key={key} className="code-container">
        <code>{markdownText(children)}</code>
      </div>
    );
  if (tag === "a")
    return (
      <a
        key={key}
        href={props.href as string | undefined}
        title={props.title as string | undefined}
        target="_blank"
        rel="noopener noreferrer"
      >
        {content}
      </a>
    );
  if (tag === "li" && typeof props.checked === "boolean")
    return (
      <li key={key} className="task-list-item">
        <input
          type="checkbox"
          checked={props.checked}
          disabled
          aria-label={props.checked ? "Completed task" : "Incomplete task"}
        />
        {content}
      </li>
    );
  if (tag === "img")
    return (
      <img
        key={key}
        src={props.src as string}
        alt={(props.alt as string) || ""}
        title={props.title as string | undefined}
        loading="lazy"
      />
    );
  if (tag === "hr" || tag === "br") return React.createElement(tag, { key });
  return React.createElement(tag, { ...props, key }, ...content);
}
function Markdown({ children }: { children: string }) {
  const [result, setResult] = useState<{
    source: string;
    nodes: MarkdownNode[];
  } | null>(null);
  useEffect(() => {
    let active = true;
    void loadMarkdown(children)
      .then((nodes) => {
        if (active) setResult({ source: children, nodes });
      })
      .catch(() => {
        /* Plain source stays readable if rendering is unavailable. */
      });
    return () => {
      active = false;
    };
  }, [children]);
  return (
    <div className="markdown">
      {result?.source === children ? (
        result.nodes.map(markdownElement)
      ) : (
        <div className="markdown-source">{children}</div>
      )}
    </div>
  );
}

const pages = [
  { name: "Foreman", icon: Terminal },
  { name: "Inbox", icon: Inbox },
  { name: "Work", icon: Briefcase },
  { name: "Discovery", icon: Search },
  { name: "Documents", icon: BookOpen },
  { name: "Understanding", icon: Brain },
  { name: "Settings", icon: Settings2 },
];
const freshPolicy: Policy = {
  inclusion: "relevant",
  status: "active",
  scope: "company",
  kind: "document",
};
function App() {
  useMobileViewport();
  const online = useConnection();
  const [session, setSession] = useState<boolean | null>(null),
    [readOnly, setReadOnly] = useState(false),
    [password, setPassword] = useState("");
  const [state, setState] = useState<Workspace | null>(null),
    [page, setPage] = useState(location.hash.slice(1) || "Inbox"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null),
    [docId, setDocId] = useState("architecture"),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [attachment, setAttachment] = useState<
      { id: string; version: number } | undefined
    >();
  const [editor, setEditor] = useState<Partial<Knowledge> | null>(null),
    [audit, setAudit] = useState<any>(null),
    [context, setContext] = useState<Context | null>(null),
    [contextQuery, setContextQuery] = useState(""),
    [previewOpen, setPreviewOpen] = useState(false),
    [contextBusy, setContextBusy] = useState(false);
  const [selectedIdea, setSelectedIdea] = useState<string | null>(null);
  const [workForm, setWorkForm] = useState(false),
    [selectedWork, setSelectedWork] = useState<string | null>(null),
    [trackFilter, setTrackFilter] = useState("all"),
    [inboxFilter, setInboxFilter] = useState("open"),
    [query, setQuery] = useState(""),
    [searchIds, setSearchIds] = useState<string[] | null>(null),
    [history, setHistory] = useState<any[] | null>(null);
  const currentThread = state?.threads.find((t) => t.id === threadId),
    currentDoc = state?.documents.find((d) => d.id === docId),
    work = state?.work.find((w) => w.id === selectedWork);
  const refresh = async () => {
    setState(await api<Workspace>("/company"));
    setStale(false);
  };
  useEffect(() => {
    api("/session")
      .then((r) => {
        setSession(r.authenticated);
        setReadOnly(r.readOnly || false);
      })
      .catch((e) => setError(e.message));
    const lock = () => {
      setSession(false);
      setState(null);
      setDrafts({});
      markdownCache.clear();
    };
    window.addEventListener("workspace-locked", lock);
    return () => window.removeEventListener("workspace-locked", lock);
  }, []);
  useEffect(() => {
    if (!session) return;
    const sync = () => {
      if (navigator.onLine && !document.hidden)
        void refresh().catch(() => setStale(true));
    };
    sync();
    const timer = setInterval(sync, 3500);
    window.addEventListener("online", sync);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", sync);
    };
  }, [session]);
  useEffect(() => {
    const sync = () => {
      const p = location.hash.slice(1);
      if (pages.some((x) => x.name === p)) setPage(p);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  function navigate(name: string) {
    setPage(name);
    location.hash = name;
    setThreadId(null);
    setSelectedWork(null);
    setError("");
  }
  async function act(command: CompanyCommand) {
    if (!online || readOnly)
      throw Error(
        readOnly
          ? "Inspection is read-only."
          : "Reconnect before making changes.",
      );
    return api("/commands", { method: "POST", body: JSON.stringify(command) });
  }
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || !online || readOnly;
  function openThread(t: Thread) {
    setPage(t.kind === "inbox" ? "Inbox" : "Foreman");
    location.hash = t.kind === "inbox" ? "Inbox" : "Foreman";
    setThreadId(t.id);
    if (t.unread && !readOnly)
      void perform(async () => {
        await act({ type: "ReadThread", threadId: t.id });
      });
  }
  function discuss(d: Knowledge) {
    navigate("Foreman");
    setAttachment({ id: d.id, version: d.version });
    setDrafts((ds) => ({ ...ds, new: `Discuss ${d.title}: ` }));
  }
  async function send() {
    const key = currentThread?.id || "new",
      content = drafts[key]?.trim();
    if (!content) return;
    await perform(async () => {
      const result = currentThread
        ? await act({ type: "Reply", threadId: currentThread.id, content })
        : await act({
            type: "StartConversation",
            subject: content.split("\n")[0]!.slice(0, 120),
            content,
            attachment,
          });
      setThreadId(result.threadId);
      setDrafts((d) => ({ ...d, [key]: "" }));
      setAttachment(undefined);
    });
  }
  async function preview() {
    setContextBusy(true);
    setError("");
    try {
      setContext(
        await api(
          "/context?q=" +
            encodeURIComponent(
              contextQuery || currentDoc?.title || "Company OS",
            ) +
            "&thread=" +
            (currentThread?.id || ""),
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setContextBusy(false);
    }
  }
  const heading = (
    <header className="page-header">
      <h1>{page}</h1>
      <div className="actions">
        {page === "Foreman" && (
          <button
            onClick={() => {
              setThreadId(null);
              setAttachment(undefined);
            }}
          >
            <Plus size={16} /> New conversation
          </button>
        )}
        {page === "Documents" && (
          <button
            disabled={disabled}
            onClick={() =>
              setEditor({
                level: "product",
                policy: { ...freshPolicy },
                content: "",
                title: "",
              })
            }
          >
            <Plus size={16} /> New document
          </button>
        )}
        {page === "Understanding" && (
          <button
            disabled={disabled}
            onClick={() =>
              setEditor({
                level: "knowledge",
                policy: { ...freshPolicy, kind: "observation" },
                content: "",
                title: "",
              })
            }
          >
            <Plus size={16} /> New record
          </button>
        )}
        {page === "Work" && (
          <button disabled={disabled} onClick={() => setWorkForm(true)}>
            <Plus size={16} /> New work
          </button>
        )}
      </div>
    </header>
  );
  if (session === null)
    return <div className="loading">{error || "Loading…"}</div>;
  if (!session)
    return (
      <main className="login">
        <Brand />
        <h1>Sign in</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              await api("/login", {
                method: "POST",
                body: JSON.stringify({ password }),
              });
              setSession(true);
              setPassword("");
            });
          }}
        >
          <label>
            Access key
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <button className="primary" disabled={busy}>
            Sign in
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  return (
    <div
      className="workspace"
      data-workspace-ready={state ? "true" : undefined}
    >
      <aside className="navigation">
        <Brand />
        <nav aria-label="Workspace navigation">
          {pages.map((p) => (
            <button
              key={p.name}
              aria-label={"Open " + p.name}
              aria-current={page === p.name ? "page" : undefined}
              className={page === p.name ? "active" : ""}
              onClick={() => navigate(p.name)}
            >
              <p.icon size={19} />
              <span>
                {p.name === "Understanding"
                  ? "Memory"
                  : p.name === "Discovery"
                    ? "Discover"
                    : p.name}
              </span>
              {p.name === "Inbox" &&
                !!state?.threads.filter(
                  (t) =>
                    t.kind === "inbox" && t.unread && t.status !== "resolved",
                ).length && (
                  <b className="count">
                    {
                      state.threads.filter(
                        (t) =>
                          t.kind === "inbox" &&
                          t.unread &&
                          t.status !== "resolved",
                      ).length
                    }
                  </b>
                )}
            </button>
          ))}
        </nav>
        <div className="nav-bottom">
          <span>Ryan’s workspace</span>
          <button
            aria-label="Lock workspace"
            onClick={() =>
              void perform(async () => {
                await api("/logout", { method: "POST" });
                setSession(false);
                setState(null);
                setDrafts({});
                markdownCache.clear();
              })
            }
          >
            <Shield size={16} />
          </button>
        </div>
      </aside>
      <div className="main-workspace">
        <div className="mobile-brand">
          <Brand />
        </div>
        <ConnectionNotice online={online} stale={stale} />
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {readOnly && <p className="inspection-notice">Read-only inspection</p>}
        {!state ? (
          <p className="loading">Loading workspace…</p>
        ) : (
          <main>
            {heading}
            {(page === "Foreman" || page === "Inbox") && (
              <div
                className={
                  "thread-layout " +
                  page.toLowerCase() +
                  " " +
                  (currentThread ? "thread-selected" : "")
                }
              >
                <section
                  className="thread-list"
                  aria-label={
                    page === "Inbox" ? "Inbox threads" : "Conversations"
                  }
                >
                  {page === "Inbox" && (
                    <div className="filters">
                      {["open", "resolved", "all"].map((f) => (
                        <button
                          key={f}
                          className={inboxFilter === f ? "active" : ""}
                          onClick={() => setInboxFilter(f)}
                        >
                          {f === "open" ? "Needs attention" : f}
                        </button>
                      ))}
                    </div>
                  )}
                  {state.threads
                    .filter(
                      (t) =>
                        t.kind ===
                          (page === "Inbox" ? "inbox" : "conversation") &&
                        (page !== "Inbox" ||
                          inboxFilter === "all" ||
                          (inboxFilter === "open"
                            ? t.status !== "resolved"
                            : t.status === "resolved")),
                    )
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .map((t) => (
                      <button
                        className={
                          "thread-row " + (threadId === t.id ? "selected" : "")
                        }
                        key={t.id}
                        onClick={() => openThread(t)}
                      >
                        <div>
                          <strong>{t.subject}</strong>
                          {t.unread && (
                            <span className="unread" aria-label="Unread" />
                          )}
                        </div>
                        <p>
                          {t.reason || t.messages.at(-1)?.content.slice(0, 95)}
                        </p>
                        <small>
                          {t.status} · {date(t.updatedAt)}
                        </small>
                      </button>
                    ))}
                  {!state.threads.some(
                    (t) =>
                      t.kind === (page === "Inbox" ? "inbox" : "conversation"),
                  ) && (
                    <Empty
                      title={
                        page === "Inbox"
                          ? "Inbox empty"
                          : "No conversations yet"
                      }
                      text={
                        page === "Inbox"
                          ? "Questions, blockers, and reviews appear here."
                          : "Start a conversation with Foreman."
                      }
                    />
                  )}
                </section>
                <section
                  className="conversation"
                  aria-label="Foreman conversation"
                >
                  <div className="conversation-header">
                    <div>
                      {currentThread && (
                        <button
                          className="back"
                          onClick={() => setThreadId(null)}
                        >
                          ← Threads
                        </button>
                      )}
                      <h2>
                        {currentThread?.subject ||
                          (page === "Inbox"
                            ? "Select a thread"
                            : "New conversation")}
                      </h2>
                    </div>
                    {currentThread && (
                      <div className="actions">
                        <button
                          aria-label="Inspect thread history"
                          onClick={() =>
                            void api("/events?entity=" + currentThread.id).then(
                              setHistory,
                            )
                          }
                        >
                          History
                        </button>
                        <button
                          disabled={disabled}
                          onClick={() =>
                            void perform(async () => {
                              await act({
                                type: "ThreadStatus",
                                threadId: currentThread.id,
                                status:
                                  currentThread.status === "resolved"
                                    ? "open"
                                    : "resolved",
                              });
                            })
                          }
                        >
                          {currentThread.status === "resolved"
                            ? "Reopen"
                            : "Resolve"}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="conversation-messages">
                    {currentThread?.reason && (
                      <div className="request">
                        <span className="eyebrow">Needs your input</span>
                        <Markdown>{currentThread.reason}</Markdown>
                        {currentThread.recommendation && (
                          <>
                            <h3>Recommendation</h3>
                            <Markdown>{currentThread.recommendation}</Markdown>
                          </>
                        )}
                        <Evidence
                          refs={currentThread.evidence}
                          open={(id) => {
                            setDocId(id);
                            navigate("Documents");
                          }}
                        />
                        {currentThread.discoveryId && (
                          <button
                            onClick={() => {
                              setSelectedIdea(currentThread.discoveryId!);
                              navigate("Discovery");
                            }}
                          >
                            Review discovery ↗
                          </button>
                        )}
                        {currentThread.workId && (
                          <button
                            onClick={() => {
                              navigate("Work");
                              setSelectedWork(currentThread.workId!);
                            }}
                          >
                            Open linked work <ArrowRight size={14} />
                          </button>
                        )}
                      </div>
                    )}
                    {currentThread?.attachment && (
                      <p className="attachment">
                        Context:{" "}
                        {
                          state.documents.find(
                            (d) => d.id === currentThread.attachment!.id,
                          )?.title
                        }{" "}
                        · v{currentThread.attachment.version}
                      </p>
                    )}
                    {currentThread?.messages.map((m) => (
                      <article key={m.id} className={"message " + m.role}>
                        <div className="message-meta">
                          <b>
                            {m.role === "human"
                              ? "You"
                              : m.role === "system"
                                ? "System"
                                : "Foreman"}
                          </b>
                          <time>{date(m.at)}</time>
                          {m.runId && (
                            <button
                              onClick={() =>
                                setContext(
                                  state.runs.find((r) => r.id === m.runId)
                                    ?.context || null,
                                )
                              }
                            >
                              Context
                            </button>
                          )}
                        </div>
                        <Markdown>{m.content}</Markdown>
                      </article>
                    ))}
                    {currentThread?.proposals.map((p) => (
                      <div className="revision-proposal" key={p.id}>
                        <h3>
                          {
                            state.documents.find((d) => d.id === p.documentId)
                              ?.title
                          }{" "}
                          · v{p.version}
                        </h3>
                        <Markdown>{p.reason}</Markdown>
                        <Evidence
                          refs={p.evidence}
                          open={(id) => {
                            navigate("Documents");
                            setDocId(id);
                          }}
                        />
                        <details>
                          <summary>Proposed revision</summary>
                          <Markdown>{p.content}</Markdown>
                        </details>
                        <div className="actions">
                          {p.status === "pending" ? (
                            <>
                              <button
                                className="primary"
                                disabled={disabled}
                                onClick={() =>
                                  void perform(async () => {
                                    await act({
                                      type: "ResolveProposal",
                                      threadId: currentThread.id,
                                      proposalId: p.id,
                                      action: "accept",
                                    });
                                  })
                                }
                              >
                                Accept revision
                              </button>
                              <button
                                disabled={disabled}
                                onClick={() =>
                                  void perform(async () => {
                                    await act({
                                      type: "ResolveProposal",
                                      threadId: currentThread.id,
                                      proposalId: p.id,
                                      action: "dismiss",
                                    });
                                  })
                                }
                              >
                                Dismiss
                              </button>
                            </>
                          ) : (
                            <span className="badge">{p.status}</span>
                          )}
                        </div>
                      </div>
                    ))}
                    {state.runs
                      .filter((r) => r.threadId === threadId)
                      .slice(-4)
                      .map((r) => (
                        <div className="run-status" key={r.id}>
                          {r.status === "queued" || r.status === "running" ? (
                            <span>
                              Foreman{" "}
                              {r.status === "queued" ? "queued" : "working"}…
                            </span>
                          ) : r.status === "failed" ? (
                            <>
                              <span role="alert">{r.error}</span>
                              <button
                                disabled={disabled}
                                onClick={() =>
                                  void perform(async () => {
                                    await act({
                                      type: "RetryRun",
                                      runId: r.id,
                                    });
                                  })
                                }
                              >
                                Retry
                              </button>
                            </>
                          ) : null}
                        </div>
                      ))}
                    {!currentThread && page === "Foreman" && (
                      <Empty
                        title="Foreman"
                        text="Discuss the product, investigate a problem, or set direction."
                      />
                    )}
                  </div>
                  {(currentThread || page === "Foreman") && (
                    <form
                      className="composer"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void send();
                      }}
                    >
                      {attachment && !currentThread && (
                        <p className="attachment">
                          Attached:{" "}
                          {
                            state.documents.find((d) => d.id === attachment.id)
                              ?.title
                          }{" "}
                          · v{attachment.version}
                          <button
                            type="button"
                            onClick={() => setAttachment(undefined)}
                          >
                            Remove
                          </button>
                        </p>
                      )}
                      <textarea
                        aria-label="Message Foreman"
                        placeholder="Message Foreman…"
                        value={drafts[currentThread?.id || "new"] || ""}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [currentThread?.id || "new"]: e.target.value,
                          }))
                        }
                        maxLength={12000}
                        rows={3}
                        disabled={readOnly}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            void send();
                          }
                        }}
                      />
                      <div>
                        <button
                          type="button"
                          onClick={() => {
                            setContext(null);
                            setPreviewOpen(true);
                            setContextQuery(
                              drafts[currentThread?.id || "new"] || "",
                            );
                          }}
                        >
                          Preview context
                        </button>
                        <button
                          className="primary"
                          aria-label="Send message"
                          disabled={
                            disabled ||
                            !drafts[currentThread?.id || "new"]?.trim() ||
                            state.runs.some(
                              (r) =>
                                !!currentThread &&
                                r.threadId === currentThread.id &&
                                ["queued", "running"].includes(r.status),
                            )
                          }
                        >
                          <ArrowUp size={18} />
                        </button>
                      </div>
                    </form>
                  )}
                </section>
              </div>
            )}
            {page === "Discovery" && (
              <DiscoveryPage
                state={state}
                disabled={disabled}
                selected={selectedIdea}
                select={setSelectedIdea}
                command={async (cmd) => {
                  let ok = false;
                  await perform(async () => {
                    const result = await act(cmd);
                    if (result.skipped) throw Error(result.skipped);
                    ok = true;
                  });
                  return ok;
                }}
                openWork={(id) => {
                  navigate("Work");
                  setSelectedWork(id);
                }}
                openThread={(id) => {
                  const t = state.threads.find((t) => t.id === id);
                  if (t) openThread(t);
                }}
                inspect={setContext}
                openKnowledge={(id) => {
                  navigate("Understanding");
                  setDocId(id);
                  void perform(async () => {
                    setAudit(await api("/knowledge/" + id));
                  });
                }}
              />
            )}
            {page === "Work" && (
              <>
                <div className="autonomy-strip">
                  <span
                    className={
                      "status-dot " + (state.settings.enabled ? "enabled" : "")
                    }
                  />
                  <span>
                    Autonomy {state.settings.enabled ? "on" : "paused"} · every{" "}
                    {state.settings.intervalMinutes} min ·{" "}
                    {
                      state.runs.filter(
                        (r) =>
                          r.automatic &&
                          r.createdAt.slice(0, 10) ===
                            new Date().toISOString().slice(0, 10),
                      ).length
                    }
                    /{state.settings.dailyBudget} runs today
                  </span>
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void perform(async () => {
                        const r = await act({ type: "Heartbeat" });
                        if (r.skipped) throw Error(r.skipped);
                      })
                    }
                  >
                    Check now
                  </button>
                  <button onClick={() => navigate("Settings")}>
                    Configure
                  </button>
                </div>
                <div className="filters">
                  {["all", "research", "bug", "feature"].map((t) => (
                    <button
                      key={t}
                      className={trackFilter === t ? "active" : ""}
                      onClick={() => setTrackFilter(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                {work ? (
                  <article className="work-detail">
                    <button onClick={() => setSelectedWork(null)}>
                      ← All work
                    </button>
                    <div className="detail-title">
                      <h2>{work.title}</h2>
                      {work.discoveryId && (
                        <button
                          onClick={() => {
                            setSelectedIdea(work.discoveryId!);
                            navigate("Discovery");
                          }}
                        >
                          Discovery · {work.discoveryPhase} ↗
                        </button>
                      )}
                      <span className="badge">
                        {work.track} · {work.status}
                      </span>
                    </div>
                    <p className="muted">
                      {work.mode === "ui-inspection"
                        ? "Browser inspection"
                        : "Investigation"}{" "}
                      · {work.origin} · attempt {work.attempts}
                    </p>
                    <h3>Assignment</h3>
                    <Markdown>{work.instruction}</Markdown>
                    <h3>Completion criteria</h3>
                    <Markdown>{work.criteria}</Markdown>
                    {work.result && (
                      <>
                        <h3>Result</h3>
                        <Markdown>{work.result}</Markdown>
                      </>
                    )}
                    <Evidence
                      refs={work.evidence}
                      open={(id) => {
                        navigate("Documents");
                        setDocId(id);
                      }}
                    />
                    <ReviewPanel
                      work={work}
                      state={state}
                      disabled={disabled}
                      link={(repository, number) =>
                        void perform(async () => {
                          await act({
                            type: "LinkPullRequest",
                            workId: work.id,
                            repository,
                            number,
                          });
                        })
                      }
                    />
                    <div className="actions">
                      {work.status === "blocked" &&
                        state.reviewRounds.some(
                          (r) =>
                            r.workId === work.id &&
                            r.status === "changes_requested",
                        ) && (
                          <button
                            disabled={disabled}
                            onClick={() =>
                              void perform(async () => {
                                await act({
                                  type: "ResumeCorrections",
                                  workId: work.id,
                                });
                              })
                            }
                          >
                            Resume corrections
                          </button>
                        )}
                      {work.threadId && (
                        <button
                          onClick={() =>
                            openThread(
                              state.threads.find(
                                (t) => t.id === work.threadId,
                              )!,
                            )
                          }
                        >
                          Open inbox thread
                        </button>
                      )}
                      {["blocked", "review"].includes(work.status) && (
                        <>
                          <button
                            disabled={disabled}
                            onClick={() =>
                              void perform(async () => {
                                await act({
                                  type: "WorkStatus",
                                  workId: work.id,
                                  status: "queued",
                                });
                              })
                            }
                          >
                            Run again
                          </button>
                          <button
                            disabled={disabled}
                            onClick={() =>
                              void perform(async () => {
                                await act({
                                  type: "WorkStatus",
                                  workId: work.id,
                                  status: "done",
                                });
                              })
                            }
                          >
                            Mark done
                          </button>
                        </>
                      )}
                      {!["done", "cancelled"].includes(work.status) && (
                        <button
                          disabled={disabled}
                          onClick={() =>
                            void perform(async () => {
                              await act({
                                type: "WorkStatus",
                                workId: work.id,
                                status: "cancelled",
                              });
                            })
                          }
                        >
                          Cancel
                        </button>
                      )}
                      <button
                        onClick={() =>
                          void api("/events?entity=" + work.id).then(setHistory)
                        }
                      >
                        Workflow history
                      </button>
                    </div>
                    {state.runs
                      .filter((r) => r.workId === work.id)
                      .map((r) => (
                        <RunRow
                          key={r.id}
                          run={r}
                          inspect={() => setContext(r.context)}
                          retry={() =>
                            void perform(async () => {
                              await act({ type: "RetryRun", runId: r.id });
                            })
                          }
                        />
                      ))}
                  </article>
                ) : (
                  <div className="work-list">
                    {state.work
                      .filter(
                        (w) => trackFilter === "all" || w.track === trackFilter,
                      )
                      .slice()
                      .reverse()
                      .map((w) => (
                        <button
                          className="work-row"
                          key={w.id}
                          onClick={() => setSelectedWork(w.id)}
                        >
                          <span className="badge">{w.track}</span>
                          <div>
                            <strong>{w.title}</strong>
                            <p>{w.criteria}</p>
                          </div>
                          <span className="badge">{w.status}</span>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                    {!state.work.length && (
                      <Empty
                        title="No work yet"
                        text="Create an investigation or let Foreman assess the objective on its next heartbeat."
                      />
                    )}
                  </div>
                )}
                <details className="workflow-guide">
                  <summary>Workflows</summary>
                  {state.workflows.map((w) => (
                    <div key={w.name}>
                      <h3>{w.name}</h3>
                      <p className="workflow-steps">{w.steps.join(" → ")}</p>
                    </div>
                  ))}
                </details>
                <h2 className="section-title">Recent runs</h2>
                {state.runs
                  .slice(-12)
                  .reverse()
                  .map((r) => (
                    <RunRow
                      key={r.id}
                      run={r}
                      inspect={() => setContext(r.context)}
                      retry={() =>
                        void perform(async () => {
                          await act({ type: "RetryRun", runId: r.id });
                        })
                      }
                    />
                  ))}
                {state.deliveryErrors.length > 0 && (
                  <details>
                    <summary>
                      Delivery failures ({state.deliveryErrors.length})
                    </summary>
                    {state.deliveryErrors.map((e) => (
                      <div key={e.id}>
                        <p>{e.error}</p>
                        <button
                          disabled={disabled}
                          onClick={() =>
                            void perform(async () => {
                              await act({
                                type: "RetryDelivery",
                                deliveryId: e.id,
                              });
                            })
                          }
                        >
                          Retry delivery
                        </button>
                      </div>
                    ))}
                  </details>
                )}
              </>
            )}
            {page === "Documents" && (
              <div className="document-layout">
                <div className="document-list">
                  {state.documents
                    .filter((d) => d.level !== "knowledge")
                    .map((d) => (
                      <button
                        key={d.id}
                        className={docId === d.id ? "selected" : ""}
                        onClick={() => setDocId(d.id)}
                      >
                        <small>{d.level}</small>
                        <strong>{d.title}</strong>
                        <span>
                          {d.policy.inclusion} · {d.policy.status}
                        </span>
                      </button>
                    ))}
                </div>
                {currentDoc && (
                  <article className="document-reader">
                    <div className="detail-title">
                      <h2>{currentDoc.title}</h2>
                      <button
                        disabled={disabled}
                        onClick={() => setEditor(currentDoc)}
                      >
                        <Pencil size={15} /> Edit
                      </button>
                    </div>
                    <p className="muted">
                      v{currentDoc.version} · {date(currentDoc.updated_at)}
                    </p>
                    <div className="context-contract">
                      <span className="eyebrow">Context policy</span>
                      <div className="badges">
                        <span className="badge">
                          {currentDoc.policy.inclusion}
                        </span>
                        <span className="badge">
                          {currentDoc.policy.status}
                        </span>
                        <span className="badge">{currentDoc.policy.scope}</span>
                        <span className="badge">
                          {currentDoc.indexed_version === currentDoc.version
                            ? "Indexed v" + currentDoc.version
                            : "Reindexing v" + currentDoc.version}
                        </span>
                      </div>
                      <p>
                        {currentDoc.policy.status !== "active"
                          ? "Excluded from automatic context while " +
                            currentDoc.policy.status +
                            "."
                          : currentDoc.policy.inclusion === "always"
                            ? "Included in every matching-scope run, subject to the visible context limit."
                            : currentDoc.policy.inclusion === "reference"
                              ? "Only included when explicitly attached to a conversation."
                              : "Eligible for retrieval when relevant. Creating it does not put it in every prompt."}
                      </p>
                      <div className="actions">
                        <button
                          onClick={() => {
                            setContext(null);
                            setPreviewOpen(true);
                            setContextQuery(currentDoc.title);
                          }}
                        >
                          Preview selection
                        </button>
                        <button
                          onClick={() =>
                            void api("/knowledge/" + currentDoc.id).then(
                              setAudit,
                            )
                          }
                        >
                          Records & usage
                        </button>
                        <button onClick={() => discuss(currentDoc)}>
                          Discuss with Foreman
                        </button>
                      </div>
                    </div>
                    <Markdown>{currentDoc.content}</Markdown>
                  </article>
                )}
              </div>
            )}
            {page === "Understanding" && (
              <>
                <p className="page-description">
                  Human-readable records used to assemble context. Documents and
                  standalone findings share the same revisioned source.
                </p>
                <form
                  className="search-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void perform(async () => {
                      const result = await api(
                        "/search?q=" + encodeURIComponent(query),
                      );
                      setSearchIds(result.results.map((d: Document) => d.id));
                    });
                  }}
                >
                  <input
                    aria-label="Search understanding"
                    placeholder="Search by meaning or keyword"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      if (!e.target.value) setSearchIds(null);
                    }}
                  />
                  <button className="primary" disabled={busy || !online}>
                    Search
                  </button>
                </form>
                <div className="knowledge-list">
                  {state.documents
                    .filter((d) => !searchIds || searchIds.includes(d.id))
                    .map((d) => (
                      <button
                        key={d.id}
                        className="knowledge-row"
                        onClick={() =>
                          void api("/knowledge/" + d.id).then(setAudit)
                        }
                      >
                        <div>
                          <strong>{d.title}</strong>
                          <p>{d.content.replace(/^#+ /gm, "").slice(0, 170)}</p>
                        </div>
                        <div className="badges">
                          <span className="badge">{d.policy.kind}</span>
                          <span className="badge">{d.policy.status}</span>
                          <span className="badge">
                            v{d.version} /{" "}
                            {d.indexed_version === d.version
                              ? "indexed"
                              : "pending index"}
                          </span>
                        </div>
                      </button>
                    ))}
                </div>
                <button
                  onClick={() => {
                    setContext(null);
                    setPreviewOpen(true);
                    setContextQuery(query);
                  }}
                >
                  Test context retrieval
                </button>
              </>
            )}
            {page === "Settings" && (
              <>
                <AutonomySettings
                  settings={state.settings}
                  disabled={disabled}
                  save={(settings) =>
                    void perform(async () => {
                      await act({ type: "ConfigureAutonomy", ...settings });
                    })
                  }
                />
                <ReviewSettings
                  settings={state.settings}
                  disabled={disabled}
                  save={(requiredReviews, allowCodeChanges) =>
                    void perform(async () => {
                      await act({
                        type: "ConfigureReviews",
                        requiredReviews,
                        allowCodeChanges,
                      });
                    })
                  }
                />
                <p className="muted">
                  One agent run at a time. Autonomous work is bounded by the
                  daily run budget and open-work limit. Research and browser
                  inspection run here. Linked PRs support independent review and
                  verified source corrections. PR creation, merging and
                  deployment remain manual.
                </p>
                <InstallCard />
              </>
            )}
          </main>
        )}
      </div>
      {editor && (
        <Modal
          title={
            editor.id
              ? "Edit record"
              : editor.level === "knowledge"
                ? "New record"
                : "New document"
          }
          close={() => setEditor(null)}
        >
          <form
            className="editor"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const result = await act({
                  type: "SaveKnowledge",
                  id: editor.id,
                  title: editor.title || "",
                  content: editor.content || "",
                  level: editor.level || "product",
                  expectedVersion: editor.version,
                  policy: editor.policy || freshPolicy,
                });
                setDocId(result.id);
                setEditor(null);
              });
            }}
          >
            <label>
              Title
              <input
                required
                maxLength={160}
                value={editor.title || ""}
                onChange={(e) =>
                  setEditor({ ...editor, title: e.target.value })
                }
              />
            </label>
            {!editor.id && (
              <label>
                Type
                <select
                  value={editor.level}
                  onChange={(e) =>
                    setEditor({
                      ...editor,
                      level: e.target.value as Document["level"],
                    })
                  }
                >
                  {["product", "architecture", "execution", "knowledge"].map(
                    (x) => (
                      <option key={x}>{x}</option>
                    ),
                  )}
                </select>
              </label>
            )}
            <label>
              Content
              <textarea
                required
                rows={12}
                maxLength={24000}
                value={editor.content || ""}
                onChange={(e) =>
                  setEditor({ ...editor, content: e.target.value })
                }
              />
            </label>
            <PolicyFields
              policy={editor.policy || freshPolicy}
              protectedRecord={editor.level === "constitution"}
              change={(policy) => setEditor({ ...editor, policy })}
            />
            <p className="muted">
              Saving creates a revision, invalidates the old embedding, and
              queues a new index. Past run contexts stay unchanged.
            </p>
            <button className="primary" disabled={disabled}>
              Save revision
            </button>
          </form>
        </Modal>
      )}
      {audit && (
        <Modal title="Understanding record" close={() => setAudit(null)}>
          <div className="detail-title">
            <h2>{audit.document.title}</h2>
            <button
              disabled={disabled}
              onClick={() => {
                setEditor({ ...audit.document, policy: audit.policy });
                setAudit(null);
              }}
            >
              Edit source
            </button>
          </div>
          <p>
            Source: {audit.document.source} · v{audit.document.version} ·{" "}
            {audit.policy.kind}
          </p>
          <Markdown>{audit.document.content}</Markdown>
          <h3>Embedding chunks</h3>
          {audit.chunks.length ? (
            audit.chunks.map((c: any) => (
              <details key={c.id}>
                <summary>
                  Chunk {c.id} · v{c.version} · {c.model}
                </summary>
                <pre>{c.text}</pre>
              </details>
            ))
          ) : (
            <p>Pending indexing. Current text remains keyword-searchable.</p>
          )}
          <h3>Used in context</h3>
          {audit.usedBy.length ? (
            audit.usedBy.map((r: any) => (
              <button
                className="list-link"
                key={r.id}
                onClick={() => {
                  setContext(state!.runs.find((x) => x.id === r.id)!.context);
                  setAudit(null);
                }}
              >
                {date(r.at)} · {r.trigger} · v{r.entry.version} ·{" "}
                {r.entry.reason}
              </button>
            ))
          ) : (
            <p>Not included in a run yet.</p>
          )}
          <h3>Revision history</h3>
          {audit.history.map((r: any) => (
            <details key={r.version}>
              <summary>
                v{r.version} · {r.actor} · {date(r.created_at)}
              </summary>
              <Markdown>{r.content}</Markdown>
            </details>
          ))}
        </Modal>
      )}
      {previewOpen && (
        <Modal
          title="Context preview"
          close={() => {
            setPreviewOpen(false);
            setContext(null);
          }}
        >
          <p>
            Same selection rules as execution. Actual runs also receive
            repository evidence and any browser results.
          </p>
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              void preview();
            }}
          >
            <input
              aria-label="Context query"
              value={contextQuery}
              onChange={(e) => setContextQuery(e.target.value)}
              placeholder="Describe the task"
            />
            <button className="primary" disabled={contextBusy || !online}>
              {contextBusy ? "Selecting…" : "Preview"}
            </button>
          </form>
          {context && <ContextView context={context} />}
        </Modal>
      )}
      {context && !previewOpen && (
        <Modal title="Run context" close={() => setContext(null)}>
          <ContextView context={context} />
        </Modal>
      )}
      {history && (
        <Modal title="Workflow history" close={() => setHistory(null)}>
          {history.length ? (
            history.map((e) => (
              <details key={e.id}>
                <summary>
                  #{e.sequence} {e.type} · {date(e.at)}
                </summary>
                <pre>{JSON.stringify(e, null, 2)}</pre>
              </details>
            ))
          ) : (
            <p>No events yet.</p>
          )}
        </Modal>
      )}
      {workForm && (
        <Modal title="New work" close={() => setWorkForm(false)}>
          <WorkForm
            disabled={disabled}
            save={(cmd) =>
              void perform(async () => {
                const r = await act(cmd);
                setSelectedWork(r.workId);
                setWorkForm(false);
              })
            }
          />
        </Modal>
      )}
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      company<span>os</span>
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button aria-label="Close dialog" onClick={close}>
          <X size={19} />
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
function Evidence({
  refs,
  open,
}: {
  refs: string[];
  open: (id: string) => void;
}) {
  return (
    <div className="evidence">
      {[...new Set(refs)].map((ref) =>
        ref.startsWith("document:") ? (
          <button key={ref} onClick={() => open(ref.slice(9).split("@")[0]!)}>
            {ref}
          </button>
        ) : (
          <span key={ref}>{ref}</span>
        ),
      )}
    </div>
  );
}
function RunRow({
  run,
  inspect,
  retry,
}: {
  run: Run;
  inspect: () => void;
  retry: () => void;
}) {
  return (
    <div className="run-row">
      <span>{run.trigger}</span>
      <span className="badge">{run.status}</span>
      <time>{date(run.createdAt)}</time>
      {run.context && <button onClick={inspect}>Context & evidence</button>}
      {run.status === "failed" && <button onClick={retry}>Retry</button>}
      {run.result && (
        <details className="run-result">
          <summary>Worker result</summary>
          <Markdown>{run.result.message}</Markdown>
          {run.result.changes.map((f) => (
            <details key={f.path}>
              <summary>{f.path}</summary>
              <pre>{f.content}</pre>
            </details>
          ))}
        </details>
      )}
      {run.error && <p>{run.error}</p>}
    </div>
  );
}
function ContextView({ context }: { context: Context }) {
  const total = context.entries.reduce((s, e) => s + e.characters, 0);
  return (
    <div className="context-view">
      <p className="muted">
        {date(context.assembledAt)} · {context.searchMode} · {context.scope}
      </p>
      <p>{context.query}</p>
      <p>
        {total.toLocaleString()} characters in knowledge context. This shows
        supplied material, not model influence.
      </p>
      {context.externalSources?.map((s) => (
        <details key={s.repository}>
          <summary>
            External source · {s.repository} · {date(s.fetchedAt)}
          </summary>
          {s.error && <p>{s.error}</p>}
          {!s.error && !s.releases.length && (
            <p>No published releases returned.</p>
          )}
          {s.releases.map((r) => (
            <section key={r.ref}>
              <h3>
                <a href={r.url} target="_blank" rel="noreferrer">
                  {r.title}
                </a>
              </h3>
              <p>
                {r.publishedAt} · {r.ref}
              </p>
              <Markdown>{r.content}</Markdown>
            </section>
          ))}
        </details>
      ))}
      {context.discovery && (
        <details open>
          <summary>
            Discovery · {context.discovery.lens.name} ·{" "}
            {context.discovery.phase}
          </summary>
          <p>{context.discovery.lens.question}</p>
          <p>
            {context.discovery.signals.length} signals ·{" "}
            {context.discovery.previousIdeas.length} prior ideas checked for
            duplication
          </p>
          {context.discovery.signals.map((s) => (
            <p key={s.id}>
              {s.title}: {s.detail}
            </p>
          ))}
          {context.discovery.idea && (
            <p>Hypothesis: {context.discovery.idea.hypothesis}</p>
          )}
        </details>
      )}
      {context.entries.map((e) => (
        <details key={e.id} className={e.included ? "included" : "excluded"}>
          <summary>
            <span>
              {e.title} · v{e.version}
            </span>
            <b>{e.included ? "Included" : "Excluded"}</b>
          </summary>
          <p>{e.reason}</p>
          {e.included && (
            <>
              <div className="context-meter">
                <span
                  style={{
                    width:
                      Math.max(1, (100 * e.characters) / Math.max(total, 1)) +
                      "%",
                  }}
                />
              </div>
              <small>
                {e.characters.toLocaleString()} characters · indexed{" "}
                {e.indexedVersion === e.version
                  ? "at this revision"
                  : "at another revision or pending"}
              </small>
              <Markdown>
                {context.documents.find((d) => d.id === e.id)?.content || ""}
              </Markdown>
            </>
          )}
        </details>
      ))}
      {context.review && (
        <details>
          <summary>
            PR review context · {context.review.pullRequest.head.slice(0, 8)}
          </summary>
          <pre>{JSON.stringify(context.review, null, 2)}</pre>
        </details>
      )}
      {context.repositoryError && <p>Repository: {context.repositoryError}</p>}
      {!!context.repository && (
        <details>
          <summary>Repository snapshot</summary>
          <pre>{JSON.stringify(context.repository, null, 2)}</pre>
        </details>
      )}
      {context.browser && (
        <details open>
          <summary>Browser inspection · {date(context.browser.at)}</summary>
          {context.browser.steps.map((s, i) => (
            <figure key={i}>
              <figcaption>
                {s.action} ·{" "}
                {s.overflow
                  ? "Horizontal overflow detected"
                  : "No horizontal overflow"}
              </figcaption>
              <a
                href={"/api/artifacts/" + s.screenshot}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src={"/api/artifacts/" + s.screenshot}
                  alt={s.action}
                  loading="lazy"
                />
              </a>
              <details>
                <summary>Observed text</summary>
                <pre>{s.text}</pre>
              </details>
            </figure>
          ))}
          {context.browser.errors.map((e, i) => (
            <p key={i}>{e}</p>
          ))}
        </details>
      )}
      <details>
        <summary>Conversation and objective</summary>
        <pre>
          {JSON.stringify(
            {
              objective: context.objective,
              messages: context.messages,
              work: context.work,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
function PolicyFields({
  policy,
  change,
  protectedRecord = false,
}: {
  policy: Policy;
  change: (p: Policy) => void;
  protectedRecord?: boolean;
}) {
  return (
    <fieldset>
      <legend>Context policy</legend>
      <div className="form-grid">
        <label>
          Inclusion
          <select
            disabled={protectedRecord}
            value={policy.inclusion}
            onChange={(e) =>
              change({
                ...policy,
                inclusion: e.target.value as Policy["inclusion"],
              })
            }
          >
            <option value="relevant">Retrieve when relevant</option>
            <option value="always">Always include in scope</option>
            <option value="reference">Reference only</option>
          </select>
        </label>
        <label>
          Status
          <select
            disabled={protectedRecord}
            value={policy.status}
            onChange={(e) =>
              change({ ...policy, status: e.target.value as Policy["status"] })
            }
          >
            {["active", "draft", "retired"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Scope
          <input
            disabled={protectedRecord}
            value={policy.scope}
            required
            onChange={(e) => change({ ...policy, scope: e.target.value })}
          />
        </label>
        <label>
          Knowledge kind
          <select
            value={policy.kind}
            onChange={(e) =>
              change({ ...policy, kind: e.target.value as Policy["kind"] })
            }
          >
            {["document", "observation", "hypothesis", "decision"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      </div>
    </fieldset>
  );
}
function WorkForm({
  disabled,
  save,
}: {
  disabled: boolean;
  save: (c: Extract<CompanyCommand, { type: "CreateWork" }>) => void;
}) {
  const [value, set] = useState<
    Extract<CompanyCommand, { type: "CreateWork" }>
  >({
    type: "CreateWork",
    title: "",
    track: "research",
    mode: "analysis",
    instruction: "",
    criteria: "",
  });
  return (
    <form
      className="editor"
      onSubmit={(e) => {
        e.preventDefault();
        save(value);
      }}
    >
      <label>
        Title
        <input
          required
          value={value.title}
          onChange={(e) => set({ ...value, title: e.target.value })}
        />
      </label>
      <div className="form-grid">
        <label>
          Track
          <select
            value={value.track}
            onChange={(e) =>
              set({ ...value, track: e.target.value as Work["track"] })
            }
          >
            {["research", "bug", "feature"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Execution
          <select
            value={value.mode}
            onChange={(e) =>
              set({ ...value, mode: e.target.value as Work["mode"] })
            }
          >
            <option value="analysis">Investigation</option>
            <option value="ui-inspection">Browser inspection</option>
          </select>
        </label>
      </div>
      <label>
        Assignment
        <textarea
          required
          rows={5}
          value={value.instruction}
          onChange={(e) => set({ ...value, instruction: e.target.value })}
        />
      </label>
      <label>
        Completion criteria
        <textarea
          required
          rows={3}
          value={value.criteria}
          onChange={(e) => set({ ...value, criteria: e.target.value })}
        />
      </label>
      <p className="muted">
        Investigations can produce research, bug reports, and feature plans.
        They do not commit code. Browser inspection navigates the live app using
        a read-only session.
      </p>
      <button disabled={disabled} className="primary">
        Create work
      </button>
    </form>
  );
}
function AutonomySettings({
  settings,
  disabled,
  save,
}: {
  settings: Settings;
  disabled: boolean;
  save: (s: Omit<Settings, "nextHeartbeatAt">) => void;
}) {
  const [value, set] = useState(settings);
  return (
    <form
      className="editor settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        save(value);
      }}
    >
      <h2>Foreman autonomy</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => set({ ...value, enabled: e.target.checked })}
        />{" "}
        Heartbeat enabled
      </label>
      <label>
        Objective
        <textarea
          rows={5}
          required
          value={value.objective}
          onChange={(e) => set({ ...value, objective: e.target.value })}
        />
      </label>
      <label>
        Repository scope
        <input
          required
          value={value.scope}
          onChange={(e) => set({ ...value, scope: e.target.value })}
        />
      </label>
      <div className="form-grid">
        <label>
          Heartbeat minutes
          <input
            type="number"
            min={15}
            max={1440}
            required
            value={value.intervalMinutes}
            onChange={(e) =>
              set({ ...value, intervalMinutes: Number(e.target.value) })
            }
          />
        </label>
        <label>
          Autonomous runs per day
          <input
            type="number"
            min={1}
            max={24}
            required
            value={value.dailyBudget}
            onChange={(e) =>
              set({ ...value, dailyBudget: Number(e.target.value) })
            }
          />
        </label>
        <label>
          Open work limit
          <input
            type="number"
            min={1}
            max={10}
            required
            value={value.maxOpenWork}
            onChange={(e) =>
              set({ ...value, maxOpenWork: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <p className="muted">
        Next heartbeat: {date(settings.nextHeartbeatAt)}. Pausing prevents new
        autonomous execution; a running invocation can finish.
      </p>
      <button className="primary" disabled={disabled}>
        Save autonomy settings
      </button>
    </form>
  );
}

function ReviewSettings({
  settings,
  disabled,
  save,
}: {
  settings: Settings;
  disabled: boolean;
  save: (count: number, allow: boolean) => void;
}) {
  const [count, setCount] = useState(settings.requiredReviews),
    [allow, setAllow] = useState(settings.allowCodeChanges);
  return (
    <form
      className="editor settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        save(count, allow);
      }}
    >
      <h2>Pull request reviews</h2>
      <label>
        Required independent reviews
        <input
          type="number"
          required
          min={1}
          max={5}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={allow}
          onChange={(e) => setAllow(e.target.checked)}
        />{" "}
        Allow verified corrections to linked codex/ branches
      </label>
      <p className="muted">
        Every reviewer must approve the same commit. New commits restart review.
        The original assignment receives the combined findings; three
        unsuccessful rounds reach your inbox. This limit applies separately from
        the heartbeat budget. Changes to the review count apply to the next
        round.
      </p>
      <p className="muted">
        Reviews are separate agent invocations using the same model, published
        as GitHub review comments. They are not separate GitHub account
        approvals or branch protection checks. Corrections must pass type
        checking, unit tests, a build and Chrome tests. Nothing merges
        automatically.
      </p>
      <button className="primary" disabled={disabled}>
        Save review policy
      </button>
    </form>
  );
}
function ReviewPanel({
  work,
  state,
  disabled,
  link,
}: {
  work: Work;
  state: CompanyState;
  disabled: boolean;
  link: (repo: string, n: number) => void;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const rounds = state.reviewRounds.filter((r) => r.workId === work.id);
  return (
    <section className="review-panel">
      <h3>Pull request</h3>
      {work.pullRequest ? (
        <p>
          <a href={work.pullRequest.url} target="_blank" rel="noreferrer">
            {work.pullRequest.repository} #{work.pullRequest.number}
          </a>{" "}
          · <code>{work.pullRequest.head.slice(0, 8)}</code>
        </p>
      ) : (
        work.status !== "cancelled" && (
          <form
            className="editor"
            onSubmit={(e) => {
              e.preventDefault();
              const match = url.match(
                /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/,
              );
              if (!match) {
                setError("Enter a GitHub pull request URL.");
                return;
              }
              setError("");
              link(match[1]!, Number(match[2]));
            }}
          >
            <label>
              PR URL
              <input
                type="url"
                required
                placeholder="https://github.com/owner/repo/pull/123"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <button
              disabled={
                disabled ||
                state.runs.some(
                  (r) =>
                    r.workId === work.id &&
                    ["running", "queued"].includes(r.status),
                )
              }
            >
              Link PR & start review
            </button>
            {error && <p role="alert">{error}</p>}
            <p className="muted">
              Link the completed work to start {state.settings.requiredReviews}{" "}
              independent reviews. Wait for any running investigation to finish
              first.
            </p>
          </form>
        )
      )}
      {rounds.map((round, i) => (
        <details key={round.id} open={i === rounds.length - 1}>
          <summary>
            Round {i + 1} · {round.pullRequest.head.slice(0, 8)} ·{" "}
            {round.reviews.filter((r) => r.status === "completed").length}/
            {round.required} reviews · {round.status.replaceAll("_", " ")}
          </summary>
          {round.reviews.map((r, j) => (
            <article key={r.id}>
              <h3>
                Reviewer {j + 1}{" "}
                <span className="badge">
                  {r.verdict?.replaceAll("_", " ") || r.status}
                </span>
              </h3>
              <Markdown>{r.summary}</Markdown>
              {r.findings.length > 0 && (
                <ul>
                  {r.findings.map((f, k) => (
                    <li key={k}>{f}</li>
                  ))}
                </ul>
              )}
            </article>
          ))}
          {round.workerRunId && (
            <small>Original worker run: {round.workerRunId}</small>
          )}
        </details>
      ))}
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
