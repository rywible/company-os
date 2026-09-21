import { InboxReview, OperatingStatus, systemGroups, type OperationsProps } from "./operations";
import type { OperatingSummary } from "../application/operations";
import { KnowledgeLibrary, ContextUsed } from "./library";
import { RevisionHistory } from "./revision-history";
import { MarkdownEditor } from "./markdown-editor";
import { SettingsPage } from "./settings";
import { MilestonesPage, MilestoneActions } from "./milestones";
import { AutomationPage } from "./automation";
import { DiscoveryPage } from "./discovery";
import { Modal } from "./modal";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { MarkdownNode } from "../markdown-types";
import {
  Inbox,
  Briefcase,
  Brain,
  Activity,
  ArrowDownLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FileText,
  GitBranch,
  Layers3,
  Loader2,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
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
} from "../domain/model";
import type { AgentCatalog, AgentProvider } from "../domain/agents";
type Knowledge = Document & { policy: Policy };
type Workspace = CompanyState & {
  operations?: OperatingSummary;
  documents: Knowledge[];
  configured: boolean;
  agentCatalog: AgentCatalog;
  availableAgentProviders: AgentProvider[];
  deliveryErrors: { id: string; error: string; attempts: number }[];
  workflows: { name: string; steps: string[] }[];
};
import "./styles.css";
import "./writing.css";
import "./preferences.css";
import { ConnectionNotice, useConnection, useMobileViewport } from "./platform";
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
  { name: "Inbox", icon: Inbox },
  { name: "Constitution", icon: BookOpen },
  { name: "Knowledge", icon: Brain },
  { name: "Work", icon: Briefcase },
  { name: "Status", icon: Activity },
  { name: "Settings", icon: Settings2, bottom: true },
];
const freshPolicy: Policy = {
  inclusion: "relevant",
  status: "active",
};
function route(name: string) {
  const workViews: Record<string, string> = {
    Work: "milestones",
    Assignments: "work",
    Automation: "automations",
    Discovery: "ideas",
    "Work/assignments": "work",
    "Work/automations": "automations",
    "Work/ideas": "ideas",
  };
  const view = workViews[name];
  if (view)
    return {
      page: "Work",
      view,
      hash:
        view === "milestones"
          ? "Work"
          : "Work/" +
            (
              {
                work: "assignments",
                automations: "automations",
                ideas: "ideas",
              } as Record<string, string>
            )[view],
    };
  const page = ["Understanding", "Documents"].includes(name)
    ? "Knowledge"
    : name === "Foreman" || !name
      ? "Inbox"
      : name;
  return { page, view: "requests", hash: page };
}
function App() {
  useMobileViewport();
  const online = useConnection();
  const [session, setSession] = useState<boolean | null>(null),
    [readOnly, setReadOnly] = useState(false),
    [password, setPassword] = useState("");
  const [state, setState] = useState<Workspace | null>(null),
    [page, setPage] = useState(route(location.hash.slice(1)).page),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false);
  const [inboxView, setInboxView] = useState(
    route(location.hash.slice(1)).view,
  );
  const [threadId, setThreadId] = useState<string | null>(null),
    [docId, setDocId] = useState<string | null>(null),
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
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [draftSubject, setDraftSubject] = useState("");
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [selectedMilestone, setSelectedMilestone] = useState<string | null>(
    null,
  );
  const [selectedIdea, setSelectedIdea] = useState<string | null>(null);
  const [selectedWork, setSelectedWork] = useState<string | null>(null),
    [trackFilter, setTrackFilter] = useState("all"),
    [inboxFilter, setInboxFilter] = useState("open"),
    [constitutionHistory, setConstitutionHistory] = useState<any[] | null>(
      null,
    ),
    [history, setHistory] = useState<any[] | null>(null);
  const [runHistory, setRunHistory] = useState<{runs:Run[];nextCursor:string|null} | null>(null);
  const [historyBusy,setHistoryBusy] = useState(false);
  async function loadRuns(before?: string) {
    setHistoryBusy(true);
    try {
      const page = await api<{runs:Run[];nextCursor:string|null}>("/runs" + (before ? "?before=" + encodeURIComponent(before) : ""));
      setRunHistory(old => ({...page,runs:before && old ? [...old.runs,...page.runs] : page.runs}));
    } catch (error) { setError(error instanceof Error ? error.message : "History unavailable."); }
    finally { setHistoryBusy(false); }
  }
  async function inspectRun(run: Run) {
    try { setContext(run.context || (await api<Run>("/run/" + encodeURIComponent(run.id))).context); }
    catch (error) { setError(error instanceof Error ? error.message : "Context unavailable."); }
  }
  const [eventEntity,setEventEntity] = useState("");
  const [eventsMore,setEventsMore] = useState(false);
  async function loadEvents(entity: string, before?: number) {
    try {
      const page = await api<any[]>("/events?" + new URLSearchParams({entity,...(before ? {before:String(before)} : {})}));
      setEventEntity(entity);setEventsMore(page.length===100);
      setHistory(old => before && old ? [...old,...page] : page);
    } catch (error) {setError(error instanceof Error ? error.message : "History unavailable.");}
  }
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const currentThread = state?.threads.find((t) => t.id === threadId),
    currentDoc = state?.documents.find((d) => d.level === "constitution"),
    work = state?.work.find((w) => w.id === selectedWork);
  const latestConversationRun = threadId
    ? state?.runs.filter((run) => run.threadId === threadId).at(-1)
    : undefined;
  const foremanResponding = ["queued", "running"].includes(
    latestConversationRun?.status || "",
  );
  const isSourceEvidence = (id: string) =>
    Boolean(
      state?.documents.find((document) => document.id === id)?.level ===
        "knowledge" && !state.library.pages[id],
    );
  const refresh = async () => {
    setState(await api<Workspace>("/company?" + new URLSearchParams({...(threadId ? {thread:threadId} : {}), ...(selectedWork ? {work:selectedWork} : {})})));
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
      setDraftSubject("");
      setComposeOpen(false);
      setAttachment(undefined);
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
    const timer = setInterval(sync, foremanResponding ? 1250 : 3500);
    window.addEventListener("online", sync);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", sync);
    };
  }, [session, foremanResponding, threadId, selectedWork]);
  useEffect(() => {
    const sync = () => {
      const next = route(location.hash.slice(1));
      setPage(next.page);
      setInboxView(next.view);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    if (!threadId) return;
    const frame = requestAnimationFrame(() =>
      conversationEndRef.current?.scrollIntoView({ block: "end" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [
    threadId,
    currentThread?.messages.length,
    latestConversationRun?.status,
  ]);
  function navigate(name: string) {
    const next = route(name);
    setInboxView(next.view);
    setPage(next.page);
    setDocId(null);
    location.hash = next.hash;
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
    setInboxView("requests");
    setPage("Inbox");
    location.hash = "Inbox";
    setThreadId(t.id);
    if (t.unread && !readOnly)
      void perform(async () => {
        await act({ type: "ReadThread", threadId: t.id });
      });
  }
  function discuss(d: Knowledge) {
    navigate("Inbox");
    setComposeOpen(true);
    setDraftSubject(`Discuss ${d.title}`.slice(0, 160));
    setAttachment({ id: d.id, version: d.version });
    setDrafts((ds) => ({ ...ds, new: `Discuss ${d.title}: ` }));
  }
  async function send(newMessage = false) {
    if (disabled) return;
    const thread = newMessage ? undefined : currentThread;
    const key = thread?.id || "new",
      content = drafts[key]?.trim();
    if (!content) return;
    await perform(async () => {
      const result = thread
        ? await act({ type: "Reply", threadId: thread.id, content })
        : await act({
            type: "StartConversation",
            subject:
              draftSubject.trim() || content.split("\n")[0]!.slice(0, 120),
            content,
            attachment,
          });
      setThreadId(result.threadId);
      setInboxView("requests");
      setPage("Inbox");
      location.hash = "Inbox";
      if (newMessage) {
        setDraftSubject("");
        setComposeOpen(false);
        setAttachment(undefined);
      }
      setDrafts((d) => ({ ...d, [key]: "" }));
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
  async function command(cmd: CompanyCommand) {
    let ok = false;
    await perform(async () => {
      const result = await act(cmd);
      if (result.skipped) throw Error(result.skipped);
      ok = true;
    });
    return ok;
  }
  const renderDiscovery = (mode: "archive" | "idea", ideaId = selectedIdea) =>
    state ? (
      <DiscoveryPage
        mode={mode}
        state={state}
        disabled={disabled}
        selected={ideaId}
        select={setSelectedIdea}
        command={command}
        openWork={(id) => {
          navigate("Assignments");
          setSelectedWork(id);
        }}
        openThread={(id) => {
          const t = state.threads.find((t) => t.id === id);
          if (t) openThread(t);
        }}
        inspect={setContext}
        openKnowledge={(id) => {
          const document = state.documents.find((d) => d.id === id);
          navigate(
            document?.level === "constitution" ? "Constitution" : "Knowledge",
          );
          setDocId(id);
        }}
      />
    ) : null;
  const operationsProps: OperationsProps | null = state ? {
    summary: state.operations, state, deliveryErrors: state.deliveryErrors, disabled, command,
    retryDelivery: (id) => command({ type: "RetryDelivery", deliveryId: id }),
    thread: (id) => { const t = state.threads.find(t => t.id === id); if (t) openThread(t); },
    history: () => void loadRuns(),
    work: (id) => { navigate("Assignments"); setSelectedWork(id); },
    milestone: (id) => { navigate("Work"); setSelectedMilestone(id || null); },
    automations: () => navigate("Automation"),
    inbox: (itemId) => {
      if (itemId) try { sessionStorage.setItem("inbox:review", itemId); } catch { /* Fall back to the first item. */ }
      navigate("Inbox"); setInboxFilter("open");
    },
  } : null;
  const inboxNotifications = (state?.threads.filter(t => t.unread && t.status !== "resolved").length || 0)
    + (state?.operations ? systemGroups(state.operations).filter(group => group.alerts.length).length : 0);
  const pageActions =
    page === "Inbox" && inboxView === "requests" && !currentThread ? (
      <div className="page-actions">
        <button
          className="primary"
          disabled={disabled}
          onClick={() => setComposeOpen(true)}
        >
          <Plus size={16} /> New message
        </button>
      </div>
    ) : page === "Constitution" && !currentDoc ? (
      <div className="page-actions">
        <button
          className="primary"
          disabled={disabled}
          onClick={() =>
            setEditor({
              level: "constitution",
              policy: { ...freshPolicy, inclusion: "always" },
              content: "",
              title: "Constitution",
            })
          }
        >
          <Plus size={16} /> Write constitution
        </button>
      </div>
    ) : page === "Knowledge" ? (
      <div className="page-actions">
        <button
          className="primary"
          disabled={disabled}
          onClick={() =>
            setEditor({
              level: "knowledge",
              policy: { ...freshPolicy },
              content: "",
              title: "",
            })
          }
        >
          <Plus size={16} /> New document
        </button>
      </div>
    ) : page === "Work" ? (
      <div className="page-actions">
        <button
          className="primary"
          disabled={disabled}
          onClick={() => setScheduleOpen(true)}
        >
          <Plus size={16} /> Schedule work
        </button>
      </div>
    ) : null;
  if (session === null)
    return <div className="loading">{error || "Loading…"}</div>;
  if (!session)
    return (
      <main className="login">
        <Brand />
        <h1>Sign in</h1>
        <p className="login-sub">Your company, on call. One key opens it.</p>
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
              title={p.name}
              aria-current={page === p.name ? "page" : undefined}
              className={
                (page === p.name ? "active " : "") +
                (p.bottom ? "settings-link" : "")
              }
              onClick={() => navigate(p.name)}
            >
              <p.icon size={19} />
              <span>{p.name}</span>
              {p.name === "Inbox" && inboxNotifications > 0 && <b className="count">{inboxNotifications}</b>}
            </button>
          ))}
        </nav>
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
            {pageActions}
            {page === "Work" && (
              <div
                className="section-tabs work-tabs"
                role="tablist"
                aria-label="Work sections"
              >
                {[
                  ["Milestones", "milestones", "Work"],
                  ["Automations", "automations", "Automation"],
                ].map(([label, view, target]) => (
                  <button
                    key={view}
                    type="button"
                    role="tab"
                    aria-selected={inboxView === view}
                    onClick={() => navigate(target!)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {page === "Status" && operationsProps && <OperatingStatus {...operationsProps} />}
            {page === "Work" && inboxView === "milestones" && (
              <MilestonesPage
                state={state}
                documents={state.documents}
                selected={selectedMilestone}
                select={setSelectedMilestone}
                command={command}
                disabled={disabled}
                markdown={(text) => <Markdown>{text}</Markdown>}
                openWork={(id) => {
                  navigate("Assignments");
                  setSelectedWork(id);
                }}
                openThread={(id) => {
                  const t = state.threads.find((t) => t.id === id);
                  if (t) openThread(t);
                }}
                openKnowledge={(id) => {
                  navigate(
                    state.documents.find((d) => d.id === id)?.level ===
                      "constitution"
                      ? "Constitution"
                      : "Knowledge",
                  );
                  setDocId(id);
                }}
              />
            )}
            {page === "Inbox" && inboxView === "requests" && (
              <div
                className={
                  "thread-layout " +
                  page.toLowerCase() +
                  " " +
                  (currentThread ? "thread-selected" : "")
                }
              >
                {page === "Inbox" && !currentThread && (
                  <section className="thread-list" aria-label="Inbox threads">
                    {page === "Inbox" && (
                      <div className="filters">
                        {["open", "unread", "read", "resolved"].map((f) => (
                          <button
                            key={f}
                            className={inboxFilter === f ? "active" : ""}
                            onClick={() => setInboxFilter(f)}
                          >
                            {f === "open" ? "Open" : f === "resolved"
                              ? "Archived"
                              : f === "unread"
                                ? "Unread"
                                : "Read"}
                          </button>
                        ))}
                      </div>
                    )}
                    {inboxFilter === "open" && operationsProps ? <InboxReview {...operationsProps} /> : <div className="thread-card-grid">
                      {state.threads
                        .filter((t) =>
                          inboxFilter === "resolved"
                            ? t.status === "resolved"
                            : t.status !== "resolved" &&
                              t.unread === (inboxFilter === "unread"),
                        )
                        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                        .map((t) => (
                          <button
                            className={
                              "thread-row " + (t.unread ? "is-unread" : "")
                            }
                            key={t.id}
                            onClick={() => openThread(t)}
                          >
                            <div>
                              <strong>{t.subject}</strong>
                            </div>
                            <p>
                              {t.reason || t.messages.at(-1)?.content}
                            </p>
                            <span className="thread-row-footer">
                              <small>
                                {inboxFilter === "resolved"
                                  ? "Archived"
                                  : t.unread
                                    ? "Unread"
                                    : "Read"}
                                {" · "}
                                {date(t.updatedAt)}
                              </small>
                              <ChevronRight size={16} aria-hidden="true" />
                            </span>
                          </button>
                        ))}
                      {!state.threads.some((t) =>
                        inboxFilter === "resolved"
                          ? t.status === "resolved"
                          : t.status !== "resolved" &&
                            t.unread === (inboxFilter === "unread"),
                      ) && (
                        <Empty
                          title={
                            inboxFilter === "resolved"
                              ? "No archived messages"
                              : inboxFilter === "read"
                                ? "No read messages"
                                : "Inbox empty"
                          }
                          text=""
                        />
                      )}
                    </div>}
                  </section>
                )}
                {currentThread && (
                  <section className="conversation" aria-label="Conversation">
                    <div className="conversation-header">
                      <div>
                        {currentThread && (
                          <button
                            className="back"
                            onClick={() => setThreadId(null)}
                          >
                            ← Inbox
                          </button>
                        )}
                        <h2>{currentThread.subject}</h2>
                      </div>
                      {currentThread && (
                        <div className="actions">
                          <button
                            className="primary"
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
                                if (page === "Inbox") setThreadId(null);
                              })
                            }
                          >
                            {currentThread.status === "resolved"
                              ? "Move to inbox"
                              : "Archive"}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="conversation-messages">
                      {currentThread.milestoneId &&
                        (() => {
                          const m = state.planning.milestones.find(
                            (m) => m.id === currentThread.milestoneId,
                          );
                          return (
                            m && (
                              <section className="milestone-inbox">
                                <h3>Milestone decision · {m.status}</h3>
                                <p>
                                  {m.maxRuns} agent runs within the proposed
                                  boundaries.
                                </p>
                                <button
                                  onClick={() => {
                                    navigate("Work");
                                    setSelectedMilestone(m.id);
                                  }}
                                >
                                  Review milestone
                                </button>
                                <MilestoneActions
                                  milestone={m}
                                  command={command}
                                  disabled={disabled}
                                />
                              </section>
                            )
                          );
                        })()}
                      {currentThread?.reason && (
                        <article className="message email-original foreman">
                          <div className="message-meta">
                            <span className="avatar" aria-hidden="true">
                              F
                            </span>
                            <b>Foreman</b>
                            <time>{date(currentThread.createdAt)}</time>
                          </div>
                          <Markdown>{currentThread.reason}</Markdown>
                          {currentThread.recommendation && (
                            <Markdown>{currentThread.recommendation}</Markdown>
                          )}
                        </article>
                      )}
                      {currentThread?.attachment && (
                        <div className="attachment">
                          <span>
                            <strong>
                              {
                                state.documents.find(
                                  (d) =>
                                    d.id === currentThread.attachment!.id,
                                )?.title
                              }{" "}
                              · v{currentThread.attachment.version}
                            </strong>
                            <small>
                              {isSourceEvidence(currentThread.attachment.id)
                                ? "Raw evidence · Included in this conversation only"
                                : "Attached to this conversation"}
                            </small>
                          </span>
                        </div>
                      )}
                      {currentThread?.messages.map((m) => (
                        <article key={m.id} className={"message " + m.role}>
                          <div className="message-meta">
                            <span className="avatar" aria-hidden="true">
                              {m.role === "human"
                                ? "Y"
                                : m.role === "system"
                                  ? "S"
                                  : "F"}
                            </span>
                            <b>
                              {m.role === "human"
                                ? "You"
                                : m.role === "system"
                                  ? "System"
                                  : "Foreman"}
                            </b>
                            <time>{date(m.at)}</time>
                          </div>
                          <Markdown>{m.content}</Markdown>
                          {m.role === "foreman" && (
                            <ContextUsed
                              run={state.runs.find((r) => r.id === m.runId)}
                              documents={state.documents}
                              markdown={(content) => (
                                <Markdown>{content}</Markdown>
                              )}
                            />
                          )}
                        </article>
                      ))}
                      {currentThread.libraryProposals?.map((p) => (
                        <button
                          className="mail-attachment"
                          key={p.id}
                          onClick={() => setProposalId(p.id)}
                        >
                          <FileText size={16} />
                          {p.title}
                          <span>
                            {p.status === "pending"
                              ? "Review knowledge revision"
                              : p.status}
                          </span>
                        </button>
                      ))}
                      {currentThread?.proposals.map((p) => (
                        <button
                          className="mail-attachment"
                          key={p.id}
                          onClick={() => setProposalId(p.id)}
                        >
                          <FileText size={16} />
                          <span>
                            {state.documents.find((d) => d.id === p.documentId)
                              ?.title || "Document revision"}
                          </span>
                          <small>
                            {p.status === "pending"
                              ? "Review revision"
                              : p.status}
                          </small>
                        </button>
                      ))}
                      {currentThread?.discoveryId &&
                        state.discovery.ideas.some(
                          (i) =>
                            i.id === currentThread.discoveryId &&
                            i.status === "ready",
                        ) && (
                          <div className="mail-decision">
                            <button
                              disabled={disabled}
                              onClick={() =>
                                void perform(async () => {
                                  await act({
                                    type: "DecideDiscovery",
                                    ideaId: currentThread.discoveryId!,
                                    action: "pursue",
                                    reason: "Approved from inbox.",
                                  });
                                })
                              }
                            >
                              Pursue
                            </button>
                          </div>
                        )}
                      {latestConversationRun && foremanResponding && (
                        <article
                          className="message foreman foreman-pending"
                          role="status"
                          aria-live="polite"
                        >
                          <div className="message-meta">
                            <span className="avatar" aria-hidden="true">
                              F
                            </span>
                            <b>Foreman</b>
                          </div>
                          <div className="thinking-line">
                            <Loader2
                              className="thinking-spinner"
                              size={16}
                              aria-hidden="true"
                            />
                            <span>
                              {latestConversationRun.status === "queued"
                                ? "Waiting to start"
                                : latestConversationRun.context
                                  ? "Working with the selected context"
                                  : "Reviewing your message"}
                            </span>
                          </div>
                          {latestConversationRun.context && (
                            <ContextUsed
                              run={latestConversationRun}
                              documents={state.documents}
                              markdown={(content) => (
                                <Markdown>{content}</Markdown>
                              )}
                            />
                          )}
                        </article>
                      )}
                      {latestConversationRun?.status === "failed" && (
                        <div className="run-status run-failed">
                          <span role="alert">{latestConversationRun.error}</span>
                          <button
                            disabled={disabled}
                            onClick={() =>
                              void perform(async () => {
                                await act({
                                  type: "RetryRun",
                                  runId: latestConversationRun.id,
                                });
                              })
                            }
                          >
                            Retry
                          </button>
                        </div>
                      )}
                      <div ref={conversationEndRef} aria-hidden="true" />
                    </div>
                    {currentThread && (
                      <form
                        className="composer"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void send();
                        }}
                      >
                        <textarea
                          aria-label="Message Foreman"
                          placeholder="Reply…"
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
                          <span className="composer-hint">
                            ⌘ + Enter to send
                          </span>
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
                            Send
                          </button>
                        </div>
                      </form>
                    )}
                  </section>
                )}
              </div>
            )}
            {page === "Work" &&
              inboxView === "ideas" &&
              renderDiscovery("archive")}
            {page === "Work" && inboxView === "work" && (
              <>
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
                      <span className="badge" data-status={work.status}>
                        <span className="dot" aria-hidden="true" />
                        {work.track} · {work.status}
                      </span>
                    </div>
                    <p className="muted">
                      {work.mode === "ui-inspection"
                        ? "Browser inspection"
                        : "Investigation"}{" "}
                      · {work.origin} · attempt {work.attempts}
                    </p>
                    {work.milestoneId && (
                      <section className="milestone-inbox">
                        <button
                          onClick={() => {
                            navigate("Work");
                            setSelectedMilestone(work.milestoneId!);
                          }}
                        >
                          {
                            state.planning.milestones.find(
                              (m) => m.id === work.milestoneId,
                            )?.title
                          }{" "}
                          ↗
                        </button>
                        <p>
                          Assigned to{" "}
                          {state.settings.roles.find(
                            (r) => r.id === work.roleId,
                          )?.name || work.roleId}
                        </p>
                        {!!work.dependsOn?.length && (
                          <>
                            <h3>Dependencies</h3>
                            {work.dependsOn.map((id) => (
                              <button
                                key={id}
                                onClick={() => setSelectedWork(id)}
                              >
                                {state.work.find((w) => w.id === id)?.title} ·{" "}
                                {state.work.find((w) => w.id === id)?.status}
                              </button>
                            ))}
                          </>
                        )}
                        {!!work.expectedOutputs?.length && (
                          <>
                            <h3>Expected outputs</h3>
                            <ul>
                              {work.expectedOutputs.map((output) => (
                                <li key={output}>{output}</li>
                              ))}
                            </ul>
                          </>
                        )}
                        {!!work.outputDocumentIds?.length && (
                          <>
                            <h3>Created knowledge</h3>
                            {work.outputDocumentIds.map((id) => (
                              <button
                                key={id}
                                onClick={() => {
                                  navigate("Knowledge");
                                  setDocId(id);
                                }}
                              >
                                {state.documents.find((d) => d.id === id)
                                  ?.title || id}
                              </button>
                            ))}
                          </>
                        )}
                        {work.reviews?.map((review) => (
                          <details key={review.runId}>
                            <summary>
                              Assignment review ·{" "}
                              {review.verdict === "approve"
                                ? "Accepted"
                                : "Changes requested"}
                            </summary>
                            <Markdown>{review.summary}</Markdown>
                            <ul>
                              {review.findings.map((f) => (
                                <li key={f}>{f}</li>
                              ))}
                            </ul>
                          </details>
                        ))}
                      </section>
                    )}
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
                        navigate(
                          state.documents.find((d) => d.id === id)?.level ===
                            "constitution"
                            ? "Constitution"
                            : "Knowledge",
                        );
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
                            hidden={!!work.milestoneId}
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
                          void loadEvents(work.id)
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
                          inspect={() => void inspectRun(r)}
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
                          <span className="badge" data-status={w.track}>
                            {w.track}
                          </span>
                          <div>
                            <strong>{w.title}</strong>
                            <p>{w.criteria}</p>
                          </div>
                          <span className="badge" data-status={w.status}>
                            <span className="dot" aria-hidden="true" />
                            {w.status}
                          </span>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                    {!state.work.length && (
                      <Empty
                        title="No work yet"
                        text="Foreman’s investigations appear here as they happen."
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
                      inspect={() => void inspectRun(r)}
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
            {page === "Constitution" && (
              <div className="constitution-layout">
                {!currentDoc && (
                  <Empty
                    title="Write your constitution"
                    text="Define the company’s purpose, principles, and direction. Every agent starts here; only you can edit it."
                  />
                )}
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
                    <p className="muted">
                      Company direction · Always included · Only you can edit
                    </p>
                    <Markdown>{currentDoc.content}</Markdown>
                    <details
                      className="library-support"
                      key={currentDoc.version}
                      onToggle={(e) => {
                        if (e.currentTarget.open)
                          void api("/knowledge/" + currentDoc.id)
                            .then((r) => setConstitutionHistory(r.history))
                            .catch((e) => setError(e.message));
                      }}
                    >
                      <summary>Revision history</summary>
                      {constitutionHistory && (
                        <RevisionHistory
                          revisions={constitutionHistory}
                          formatDate={date}
                        />
                      )}
                    </details>
                    <button onClick={() => discuss(currentDoc)}>
                      Discuss with Foreman
                    </button>
                    <details className="context-contract">
                      <summary>Context & usage</summary>

                      <div className="badges">
                        <span className="badge">
                          {currentDoc.policy.inclusion}
                        </span>
                        <span className="badge">
                          {currentDoc.policy.status}
                        </span>
                        <span className="badge">
                          {currentDoc.indexed_version === currentDoc.version
                            ? "Indexed v" + currentDoc.version
                            : "Reindexing v" + currentDoc.version}
                        </span>
                      </div>
                      <p>
                        The current constitution is included in every agent
                        briefing.
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
                      </div>
                    </details>
                  </article>
                )}
              </div>
            )}
            {page === "Knowledge" && (
              <KnowledgeLibrary
                state={state}
                openId={docId}
                disabled={disabled}
                command={command}
                edit={(d) => {
                  const current = state.documents.find(
                    (document) => document.id === d.id,
                  )!;
                  setEditor({
                    ...current,
                    policy: {
                      inclusion:
                        current.policy.inclusion === "always"
                          ? "always"
                          : "relevant",
                      status: "active",
                    },
                  });
                }}
                discuss={(d) => {
                  const sourceEvidence =
                    d.level === "knowledge" && !state.library.pages[d.id];
                  setAttachment({ id: d.id, version: d.version });
                  setDraftSubject(`Discuss ${d.title}`);
                  if (sourceEvidence)
                    setDrafts((drafts) => ({
                      ...drafts,
                      new: "What should we learn from this evidence? ",
                    }));
                  setComposeOpen(true);
                }}
                markdown={(content) => <Markdown>{content}</Markdown>}
                api={api}
              />
            )}
            {page === "Work" &&
              (inboxView === "automations" || scheduleOpen) && (
                <AutomationPage
                  state={state}
                  agentCatalog={state.agentCatalog}
                  availableAgentProviders={state.availableAgentProviders}
                  disabled={disabled}
                  command={command}
                  configured={state.configured}
                  creating={scheduleOpen}
                  closeCreate={() => setScheduleOpen(false)}
                  showList={inboxView === "automations"}
                  hasConstitution={state.documents.some(
                    (d) => d.level === "constitution" && !!d.content.trim(),
                  )}
                />
              )}
            {page === "Settings" && (
              <SettingsPage
                settings={state.settings}
                agentCatalog={state.agentCatalog}
                availableAgentProviders={state.availableAgentProviders}
                disabled={disabled}
                command={command}
              />
            )}
          </main>
        )}
      </div>
      {composeOpen && (
        <Modal title="New message" close={() => setComposeOpen(false)}>
          <form
            className="editor mail-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void send(true);
            }}
          >
            {error && (
              <p role="alert" className="error-banner">
                {error}
              </p>
            )}
            <p className="mail-recipient">To: Foreman</p>
            <label>
              Subject
              <input
                autoFocus
                required
                maxLength={160}
                value={draftSubject}
                onChange={(e) => setDraftSubject(e.target.value)}
              />
            </label>
            {attachment && (
              <div className="attachment">
                <span>
                  <strong>
                    {
                      state?.documents.find((d) => d.id === attachment.id)
                        ?.title
                    }
                  </strong>
                  <small>
                    {isSourceEvidence(attachment.id)
                      ? "Raw evidence · Included in this conversation only"
                      : "Attached to this conversation"}
                  </small>
                </span>
                <button type="button" onClick={() => setAttachment(undefined)}>
                  Remove
                </button>
              </div>
            )}
            <label>
              Message
              <textarea
                aria-label="New message content"
                required
                rows={10}
                maxLength={12000}
                value={drafts.new || ""}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, new: e.target.value }))
                }
              />
            </label>
            <button
              className="primary"
              disabled={disabled || !draftSubject.trim() || !drafts.new?.trim()}
            >
              Send
            </button>
          </form>
        </Modal>
      )}
      {proposalId &&
        currentThread &&
        (() => {
          const libraryProposal = currentThread.libraryProposals?.find(
            (p) => p.id === proposalId,
          );
          const proposal =
            libraryProposal ||
            currentThread.proposals.find((p) => p.id === proposalId);
          if (!proposal) return null;
          return (
            <Modal
              title={
                libraryProposal?.title ||
                state?.documents.find((d) => d.id === proposal.documentId)
                  ?.title ||
                "Proposed revision"
              }
              close={() => setProposalId(null)}
            >
              <Markdown>{proposal.reason}</Markdown>
              {libraryProposal?.disposition === "withdrawn" && (
                <p>
                  This withdraws the subject from automatic conversation
                  context. Its text and source history remain available.
                </p>
              )}
              {libraryProposal?.reviewAfter && (
                <p>
                  Review again by{" "}
                  {new Date(libraryProposal.reviewAfter).toLocaleDateString()}.
                </p>
              )}
              <Markdown>{proposal.content}</Markdown>
              {proposal.status === "pending" ? (
                <div className="actions">
                  {(["accept", "dismiss"] as const).map((action) => (
                    <button
                      key={action}
                      disabled={disabled}
                      onClick={() =>
                        void perform(async () => {
                          await act({
                            type: libraryProposal
                              ? "ResolveLibraryProposal"
                              : "ResolveProposal",
                            threadId: currentThread.id,
                            proposalId: proposal.id,
                            action,
                          });
                          setProposalId(null);
                        })
                      }
                    >
                      {action === "accept" ? "Accept revision" : "Dismiss"}
                    </button>
                  ))}
                </div>
              ) : (
                <p>{proposal.status}</p>
              )}
            </Modal>
          );
        })()}
      {editor && (
        <Modal
          className="document-editor-dialog"
          title={
            editor.level === "constitution"
              ? editor.id
                ? "Edit constitution"
                : "Write constitution"
              : editor.id
                ? "Edit document"
                : "New document"
          }
          close={() => setEditor(null)}
        >
          <form
            className="editor document-form"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const result = await act({
                  type: "SaveKnowledge",
                  id: editor.id,
                  title: editor.title || "",
                  content: editor.content || "",
                  level: editor.level || "knowledge",
                  expectedVersion: editor.version,
                  policy: editor.policy || freshPolicy,
                });

                if (editor.level === "constitution")
                  setConstitutionHistory(null);
                if (!editor.id) setDocId(result.id);
                setEditor(null);
              });
            }}
          >
            {error && (
              <p role="alert" className="error-banner">
                {error}
              </p>
            )}
            <div className="document-form-body">
              {editor.level !== "constitution" && (
                <details className="editor-context-policy">
                  <summary>
                    Context settings
                    <span className="context-summary">
                      {(editor.policy || freshPolicy).inclusion === "always"
                        ? "Always include"
                        : "Retrieve when relevant"}
                    </span>
                  </summary>
                  <PolicyFields
                    policy={editor.policy || freshPolicy}
                    change={(policy) => setEditor({ ...editor, policy })}
                  />
                </details>
              )}
              <div className="document-meta">
                <label>
                  Title
                  <input
                    required
                    maxLength={160}
                    aria-label="Document title"
                    placeholder="Untitled document"
                    value={editor.title || ""}
                    onChange={(e) =>
                      setEditor({ ...editor, title: e.target.value })
                    }
                  />
                </label>
              </div>
              <MarkdownEditor
                value={editor.content || ""}
                change={(content) => setEditor({ ...editor, content })}
                preview={(content) => <Markdown>{content}</Markdown>}
                disabled={readOnly}
              />
            </div>
            <footer className="editor-footer">
              <span className="writing-status">
                {editor.content?.trim()
                  ? editor.content.trim().split(/\s+/).length.toLocaleString()
                  : 0}{" "}
                words
              </span>
              <button
                className="primary"
                disabled={
                  disabled || !editor.title?.trim() || !editor.content?.trim()
                }
              >
                {page === "Knowledge" ? "Save" : "Save revision"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {audit && (
        <Modal title="Knowledge entry" close={() => setAudit(null)}>
          <div className="detail-title">
            <h2>{audit.document.title}</h2>
            <button
              disabled={disabled}
              onClick={() => {
                setEditor({ ...audit.document, policy: audit.policy });
                setAudit(null);
              }}
            >
              Edit entry
            </button>
          </div>
          <p>
            Source: {audit.document.source} · v{audit.document.version}
          </p>
          <Markdown>{audit.document.content}</Markdown>
          <h3>What meaning search uses</h3>
          <p>
            These are the exact title-and-text passages indexed for this entry.
            Editing the entry rebuilds them.
          </p>
          {audit.chunks.length ? (
            audit.chunks.map((c: any) => (
              <details key={c.id}>
                <summary>Passage · revision {c.version}</summary>
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
          <RevisionHistory
            revisions={audit.history}
            formatDate={date}
            showActor
          />
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
      {runHistory && <Modal title="Run history" close={() => setRunHistory(null)}>
        {runHistory.runs.map(run => <RunRow key={run.id} run={run} inspect={() => void inspectRun(run)} retry={() => void perform(async () => { await act({type:"RetryRun",runId:run.id}); })} />)}
        {!runHistory.runs.length && <p>No runs recorded.</p>}
        {runHistory.nextCursor && <button disabled={historyBusy} onClick={() => void loadRuns(runHistory.nextCursor!)}>{historyBusy ? "Loading…" : "Older runs"}</button>}
      </Modal>}
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
          {eventsMore && <button onClick={() => void loadEvents(eventEntity,history.at(-1)?.sequence)}>Older events</button>}
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
      <span className="empty-icon" aria-hidden="true">
        <Inbox size={18} />
      </span>
      <h3>{title}</h3>
      {text ? <p>{text}</p> : null}
    </div>
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
  const [saved,setSaved] = useState<Run>();
  const [resultError,setResultError] = useState("");
  const [loading,setLoading] = useState(false);
  const result = saved?.result || run.result;
  async function loadResult() {
    if(saved || loading || !run.hasContext) return;
    setLoading(true);setResultError("");
    try {setSaved(await api<Run>("/run/" + encodeURIComponent(run.id)));}
    catch(error) {setResultError(error instanceof Error ? error.message : "Saved result unavailable.");}
    finally {setLoading(false);}
  }
  return (
    <div className="run-row">
      <span>{run.trigger}</span>
      <span className="badge" data-status={run.status}>
        <span className="dot" aria-hidden="true" />
        {run.status}
      </span>
      <time>{date(run.createdAt)}</time>
      {(run.context || run.hasContext) && <button onClick={inspect}>Context & evidence</button>}
      {run.status === "failed" && <button onClick={retry}>Retry</button>}
      {result && (
        <details className="run-result" onToggle={e => {if(e.currentTarget.open) void loadResult();}}>
          <summary>Worker result</summary>
          {resultError && <p role="alert">{resultError}</p>}
          {loading && <p>Loading full result…</p>}
          <Markdown>{result.message}</Markdown>
          {result.changes.map((f) => (
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
        {date(context.assembledAt)} · {context.searchMode}
      </p>
      <p>{context.query}</p>
      <p>
        {total.toLocaleString()} characters in knowledge context. This shows
        supplied material, not model influence.
      </p>
      {context.portfolio && (
        <details>
          <summary>
            Work portfolio · {context.portfolio.work.length} records
          </summary>
          {context.portfolio.work.map((w) => (
            <section key={w.id}>
              <h3>
                {w.title} · {w.status}
              </h3>
              <p>
                <code>work:{w.id}</code>
              </p>
              <Markdown>{w.result || "No result recorded"}</Markdown>
              {w.pullRequest && (
                <>
                  <p>
                    <a
                      href={w.pullRequest.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      PR #{w.pullRequest.number}
                    </a>{" "}
                    · metadata at {w.pullRequest.head}
                  </p>
                  <Markdown>
                    {w.pullRequest.description || "No PR description supplied"}
                  </Markdown>
                </>
              )}
            </section>
          ))}
        </details>
      )}
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
        <summary>Conversation and direction</summary>
        <pre>
          {JSON.stringify(
            {
              constitution: context.constitutionRef,
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
}: {
  policy: Policy;
  change: (p: Policy) => void;
}) {
  return (
    <fieldset>
      <legend>Context policy</legend>
      <div className="form-grid">
        <label>
          Agent context
          <select
            value={policy.inclusion === "always" ? "always" : "relevant"}
            onChange={(e) =>
              change({
                inclusion: e.target.value as Policy["inclusion"],
                status: "active",
              })
            }
          >
            <option value="relevant">Retrieve when relevant</option>
            <option value="always">Always include</option>
          </select>
        </label>
      </div>
    </fieldset>
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
