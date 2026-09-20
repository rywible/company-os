import React, { useEffect, useState } from "react";
import type { Document } from "../contracts";
import type { CompanyState, Command, Context, Run } from "../domain/model";
import { parseDocumentRef, type LibraryPage } from "../domain/library";
import { libraryFreshness } from "../domain/freshness";
import { documentRef } from "../domain/library";
import "./library.css";
type Props = {
  state: CompanyState & { documents: Document[] };
  openId: string | null;
  preview(d: Document): void;
  inspect(d: Document): void;
  disabled: boolean;
  command(c: Command): Promise<boolean>;
  edit(d: Document): void;
  discuss(d: Document): void;
  markdown(content: string): React.ReactNode;
  api(path: string): Promise<any>;
};
export function KnowledgeLibrary({
  state,
  openId,
  preview,
  inspect,
  disabled,
  command,
  edit,
  discuss,
  markdown,
  api,
}: Props) {
  const [selected, setSelected] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [matches, setMatches] = useState<string[] | null>(null),
    [warning, setWarning] = useState(""),
    [error, setError] = useState(""),
    [searching, setSearching] = useState(false),
    [evidence, setEvidence] = useState(false);
  const [history, setHistory] = useState<any[] | null>(null),
    [source, setSource] = useState<Document | null>(null),
    [location, setLocation] = useState<LibraryPage | null>(null);
  const freshness = libraryFreshness(
    state,
    state.documents,
    new Date().toISOString(),
  );
  useEffect(() => {
    setSelected(openId);
    if (openId) {
      setMatches(null);
      setQuery("");
      setWarning("");
      const opened = state.documents.find((d) => d.id === openId);
      setEvidence(
        opened?.level === "knowledge" && !state.library.pages[openId],
      );
    }
  }, [openId]);
  const pages = state.documents.filter(
    (d) =>
      d.level !== "constitution" &&
      (d.level !== "knowledge" || !!state.library.pages[d.id]),
  );
  const collectionOf = (d: Document) =>
    state.library.pages[d.id]?.collection ||
    ({
      product: "Product",
      architecture: "Architecture",
      execution: "Execution",
      knowledge: "Unfiled",
      constitution: "Constitution",
    }[d.level] ??
      "Unfiled");
  const collections = [...new Set(pages.map(collectionOf))].sort();
  const document = state.documents.find((d) => d.id === selected),
    meta = document && state.library.pages[document.id];
  useEffect(() => {
    setHistory(null);
    setSource(null);
    setLocation(null);
    setError("");
  }, [selected, document?.version]);
  const open = (id: string) => {
    setSelected(id);
    setSource(null);
  };
  async function readSource(ref: string) {
    const parsed = parseDocumentRef(ref);
    if (!parsed) return;
    try {
      const result = await api(
        `/knowledge/${encodeURIComponent(parsed.id)}?version=${parsed.version}`,
      );
      setSource(result.document);
      setError("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }
  const rows = (docs: Document[]) =>
    docs.map((d) => (
      <button className="library-row" key={d.id} onClick={() => open(d.id)}>
        <span>
          <strong>{d.title}</strong>
          <span>{d.content.replace(/[#*_`]/g, "").slice(0, 145)}</span>
        </span>
        <small>
          {freshness[d.id]?.status === "needs_review"
            ? "Needs review"
            : freshness[d.id]?.status === "withdrawn" ||
                state.policies[d.id]?.status === "retired"
              ? "Withdrawn"
              : `v${d.version}`}
        </small>
      </button>
    ));
  if (source)
    return (
      <article className="library-reader">
        <button className="back" onClick={() => setSource(null)}>
          ← Subject
        </button>
        <p className="muted">Source revision {source.version} · read only</p>
        <h2>{source.title}</h2>
        {markdown(source.content)}
      </article>
    );
  if (document)
    return (
      <article className="library-reader">
        <button className="back" onClick={() => setSelected(null)}>
          ← {evidence ? "Evidence" : "Library"}
        </button>
        {error && <p role="alert">{error}</p>}
        {meta && (
          <p className="library-path">
            {meta.collection}
            {meta.parentId && (
              <>
                {" "}
                /{" "}
                <button onClick={() => open(meta.parentId!)}>
                  {state.documents.find((d) => d.id === meta.parentId)?.title}
                </button>
              </>
            )}
          </p>
        )}
        <div className="library-title">
          <h2>{document.title}</h2>
          <button disabled={disabled} onClick={() => edit(document)}>
            Edit
          </button>
        </div>
        <p className="library-meta">
          Revision {document.version} ·{" "}
          {new Date(document.updated_at).toLocaleDateString()} ·{" "}
          {meta?.managed
            ? "Maintained by Foreman"
            : meta
              ? "Human edited"
              : document.level === "knowledge"
                ? "Source evidence"
                : "Human-governed document"}
        </p>
        {freshness[document.id] &&
          freshness[document.id]!.status !== "current" && (
            <aside className="library-freshness" aria-label="Subject status">
              <strong>
                {freshness[document.id]!.status === "withdrawn"
                  ? "Withdrawn"
                  : "Needs review"}
              </strong>
              <p>Excluded from automatic conversation context.</p>
              <ul>
                {freshness[document.id]!.reasons.map((r, i) => (
                  <li key={i}>{r.message}</li>
                ))}
              </ul>
            </aside>
          )}
        <details className="context-contract">
          <summary>Context & usage</summary>
          <p>
            {state.policies[document.id]?.status || "active"} ·{" "}
            {state.policies[document.id]?.inclusion || "relevant"}
          </p>
          <p>
            {state.policies[document.id]?.status &&
            state.policies[document.id]?.status !== "active"
              ? "Excluded from automatic context while " +
                state.policies[document.id]?.status +
                "."
              : state.policies[document.id]?.inclusion === "reference"
                ? "Only included when explicitly attached to a conversation."
                : state.policies[document.id]?.inclusion === "always"
                  ? "Included in agent context, subject to the context limit."
                  : "Eligible for retrieval when relevant."}
          </p>
          <div className="actions">
            <button onClick={() => preview(document)}>Preview selection</button>
            <button onClick={() => inspect(document)}>Records & usage</button>
          </div>
        </details>
        <div className="library-body">{markdown(document.content)}</div>
        {meta?.sources.length ? (
          <details className="library-support">
            <summary>Sources ({meta.sources.length})</summary>
            <ul>
              {meta.sources.map((ref) => {
                const parsed = parseDocumentRef(ref);
                const current =
                  parsed && state.documents.find((d) => d.id === parsed.id);
                const withdrawn = state.library.withdrawnSources?.[ref];
                return (
                  <li key={ref}>
                    {parsed ? (
                      <button onClick={() => void readSource(ref)}>
                        {state.documents.find((d) => d.id === parsed.id)
                          ?.title || "Source document"}{" "}
                        · v{parsed.version}
                      </button>
                    ) : (
                      <span>{ref}</span>
                    )}
                    {parsed &&
                      current &&
                      current.version !== parsed.version && (
                        <p className="library-source-note">
                          Superseded by{" "}
                          <button
                            onClick={() =>
                              void readSource(documentRef(current))
                            }
                          >
                            v{current.version}
                          </button>
                        </p>
                      )}
                    {parsed && !current && (
                      <p className="library-source-note">Source unavailable</p>
                    )}
                    {current &&
                      state.policies[current.id]?.status === "retired" && (
                        <p className="library-source-note">
                          Evidence withdrawn
                        </p>
                      )}
                    {withdrawn && (
                      <p className="library-source-note">
                        Withdrawn: {withdrawn.reason}
                      </p>
                    )}
                    <details className="library-source-actions">
                      <summary>Source status</summary>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const reason = String(
                            new FormData(e.currentTarget).get("reason") ||
                              "Restored by owner",
                          );
                          void command({
                            type: "WithdrawEvidenceReference",
                            reference: ref,
                            reason,
                            withdrawn: !withdrawn,
                          });
                        }}
                      >
                        {!withdrawn && (
                          <label>
                            Why is this source no longer reliable?
                            <input name="reason" required maxLength={1000} />
                          </label>
                        )}
                        <button disabled={disabled}>
                          {withdrawn ? "Restore source" : "Withdraw source"}
                        </button>
                      </form>
                    </details>
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}
        {meta && (
          <details
            className="library-support library-review"
            key={`${document.id}-${document.version}-${meta.reviewAfter || ""}`}
          >
            <summary>Review this subject</summary>
            {meta.reviewedAt && (
              <p className="muted">
                Last reviewed {new Date(meta.reviewedAt).toLocaleDateString()}
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const date = String(
                  new FormData(e.currentTarget).get("reviewDate") || "",
                );
                void command({
                  type: "ScheduleKnowledgeReview",
                  documentId: document.id,
                  expectedVersion: document.version,
                  reviewAfter: date ? `${date}T23:59:59.000Z` : null,
                });
              }}
            >
              <label>
                Review by (optional)
                <input
                  type="date"
                  name="reviewDate"
                  defaultValue={meta.reviewAfter?.slice(0, 10) || ""}
                />
              </label>
              <button disabled={disabled}>Save review date</button>
            </form>
            <p>
              Confirm after checking the current sources. This keeps the text
              and updates its source revisions. Withdraw if the conclusion no
              longer holds.
            </p>
            <div className="library-review-actions">
              <button
                disabled={disabled}
                onClick={() =>
                  void command({
                    type: "ReviewKnowledge",
                    documentId: document.id,
                    expectedVersion: document.version,
                    action: "confirm",
                    reviewAfter:
                      meta.reviewAfter &&
                      Date.parse(meta.reviewAfter) > Date.now()
                        ? meta.reviewAfter
                        : null,
                    sources: meta.sources.map((ref) => {
                      const parsed = parseDocumentRef(ref);
                      const current =
                        parsed &&
                        state.documents.find((d) => d.id === parsed.id);
                      return current ? documentRef(current) : ref;
                    }),
                  })
                }
              >
                Confirm current sources
              </button>
              {!meta.withdrawn && (
                <button
                  disabled={disabled}
                  onClick={() =>
                    void command({
                      type: "ReviewKnowledge",
                      documentId: document.id,
                      expectedVersion: document.version,
                      action: "withdraw",
                      sources: meta.sources,
                      reviewAfter: null,
                    })
                  }
                >
                  Withdraw subject
                </button>
              )}
            </div>
          </details>
        )}
        {!meta && (
          <div className="library-review-actions">
            <button
              disabled={disabled}
              onClick={() =>
                void command({
                  type: "SetEvidenceStatus",
                  documentId: document.id,
                  expectedVersion: document.version,
                  status:
                    state.policies[document.id]?.status === "retired"
                      ? "active"
                      : "retired",
                })
              }
            >
              {state.policies[document.id]?.status === "retired"
                ? "Restore evidence"
                : "Withdraw evidence"}
            </button>
            {state.policies[document.id]?.status === "retired" && (
              <p className="muted">
                Withdrawn evidence is retained as history.
              </p>
            )}
          </div>
        )}
        {pages.some(
          (d) => state.library.pages[d.id]?.parentId === document.id,
        ) && (
          <div className="library-related">
            <h3>Subjects in this section</h3>
            {pages
              .filter(
                (d) => state.library.pages[d.id]?.parentId === document.id,
              )
              .map((d) => (
                <button key={d.id} onClick={() => open(d.id)}>
                  {d.title}
                </button>
              ))}
          </div>
        )}
        {!!meta?.relatedIds.length && (
          <div className="library-related">
            <h3>Related subjects</h3>
            {meta.relatedIds.map((id) => (
              <button key={id} onClick={() => open(id)}>
                {state.documents.find((d) => d.id === id)?.title}
              </button>
            ))}
          </div>
        )}
        <details
          className="library-support"
          onToggle={(e) => {
            if (e.currentTarget.open && !history)
              void api("/knowledge/" + document.id)
                .then((r) => setHistory(r.history))
                .catch((e) => setError(e.message));
          }}
        >
          <summary>Revision history</summary>
          {history?.map((r) => (
            <details key={r.version}>
              <summary>
                Revision {r.version} · {new Date(r.created_at).toLocaleString()}
              </summary>
              {markdown(r.content)}
            </details>
          ))}
        </details>
        <div className="library-footer">
          <button onClick={() => discuss(document)}>
            Discuss with Foreman
          </button>
          {meta && (
            <button
              disabled={disabled}
              onClick={() => setLocation({ ...meta })}
            >
              Organize
            </button>
          )}
        </div>
        {location && (
          <form
            className="library-organize"
            onSubmit={(e) => {
              e.preventDefault();
              void command({
                type: "OrganizeKnowledge",
                documentId: document.id,
                location,
              }).then((ok) => {
                if (ok) setLocation(null);
              });
            }}
          >
            <label>
              Collection
              <input
                required
                maxLength={80}
                list="library-collections"
                value={location.collection}
                onChange={(e) =>
                  setLocation({ ...location, collection: e.target.value })
                }
              />
            </label>
            <datalist id="library-collections">
              {collections.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </datalist>
            <label>
              Parent subject
              <select
                value={location.parentId || ""}
                onChange={(e) =>
                  setLocation({ ...location, parentId: e.target.value || null })
                }
              >
                <option value="">None</option>
                {pages
                  .filter((d) => d.id !== document.id)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
              </select>
            </label>
            <fieldset>
              <legend>Related subjects</legend>
              {pages
                .filter((d) => d.id !== document.id)
                .map((d) => (
                  <label className="check" key={d.id}>
                    <input
                      type="checkbox"
                      checked={location.relatedIds.includes(d.id)}
                      onChange={(e) =>
                        setLocation({
                          ...location,
                          relatedIds: e.target.checked
                            ? [...location.relatedIds, d.id]
                            : location.relatedIds.filter((id) => id !== d.id),
                        })
                      }
                    />
                    {d.title}
                  </label>
                ))}
            </fieldset>
            <div className="actions">
              <button className="primary" disabled={disabled}>
                Save organization
              </button>
              <button type="button" onClick={() => setLocation(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </article>
    );
  const candidates = evidence
    ? state.documents.filter(
        (d) => d.level === "knowledge" && !state.library.pages[d.id],
      )
    : pages;
  const shown = matches
    ? candidates
        .filter((d) => matches.includes(d.id))
        .sort((a, b) => matches.indexOf(a.id) - matches.indexOf(b.id))
    : candidates;
  return (
    <section className="library-index" aria-label="Knowledge library">
      <div className="library-tools">
        <button
          aria-pressed={!evidence}
          onClick={() => {
            setEvidence(false);
            setMatches(null);
            setQuery("");
          }}
        >
          Library
        </button>
        <button
          aria-pressed={evidence}
          onClick={() => {
            setEvidence(true);
            setMatches(null);
            setQuery("");
          }}
        >
          Evidence
        </button>
      </div>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          setSearching(true);
          setError("");
          void api(
            "/search?q=" +
              encodeURIComponent(query) +
              "&view=" +
              (evidence ? "evidence" : "library"),
          )
            .then((result) => {
              setMatches(result.results.map((d: Document) => d.id));
              setWarning(result.warning || "");
            })
            .catch((e) => setError(e.message))
            .finally(() => setSearching(false));
        }}
      >
        <input
          aria-label="Search knowledge"
          placeholder={evidence ? "Search evidence" : "Search documents"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value) {
              setMatches(null);
              setWarning("");
            }
          }}
        />
        <button disabled={searching || disabled}>Search</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {warning && <p role="status">{warning}</p>}
      {evidence && (
        <p className="muted">
          Original findings and investigations. Foreman uses these to maintain
          the library.
        </p>
      )}
      {!shown.length && (
        <p className="library-empty">
          {matches
            ? "No matching documents."
            : evidence
              ? "No evidence yet."
              : "No documents yet. Create a document, or let Foreman build the library from findings."}
        </p>
      )}
      {matches || evidence
        ? rows(shown)
        : collections.map((collection) => (
            <section className="library-collection" key={collection}>
              <h2>{collection}</h2>
              {rows(
                shown
                  .filter((d) => collectionOf(d) === collection)
                  .sort((a, b) => a.title.localeCompare(b.title)),
              )}
            </section>
          ))}
      {!!Object.keys(state.library.pending).length && (
        <p className="library-queue">
          {Object.keys(state.library.pending).length}{" "}
          {Object.keys(state.library.pending).length === 1
            ? "source waiting"
            : "sources waiting"}{" "}
          for maintenance.
        </p>
      )}
    </section>
  );
}

export function ContextUsed({
  run,
  documents,
  markdown,
}: {
  run?: Run;
  documents: Document[];
  markdown(s: string): React.ReactNode;
}) {
  if (!run) return null;
  const context = run.context;
  if (!context)
    return (
      <p className="briefing-pending">
        Context will be assembled when this run starts.
      </p>
    );
  function snapshot(c: Context) {
    return (
      <div className="briefing-snapshot">
        <p className="muted">
          Supplied {new Date(c.assembledAt).toLocaleString()}. These are the
          saved revisions for this run.
        </p>
        {([true, false] as const).map((constitution) => (
          <section key={String(constitution)}>
            <h4>{constitution ? "Constitution" : "Relevant knowledge"}</h4>
            {c.documents
              .filter((d) => (d.level === "constitution") === constitution)
              .map((d) => (
                <details className="briefing-page" key={d.id}>
                  <summary>
                    {d.title} <span>v{d.version}</span>
                  </summary>
                  <p className="muted">
                    {c.entries.find((e) => e.id === d.id)?.reason}
                  </p>
                  {(documents.find((current) => current.id === d.id)?.version ||
                    0) > d.version && (
                    <p className="muted">
                      A newer revision exists. This reply used v{d.version}.
                    </p>
                  )}
                  {markdown(d.content)}
                </details>
              ))}
          </section>
        ))}
        {!!c.maintenance?.sources.length && (
          <details>
            <summary>Evidence supplied for maintenance</summary>
            {c.maintenance.sources.map((d) => (
              <details key={d.id}>
                <summary>
                  {d.title} · v{d.version}
                </summary>
                {markdown(d.content)}
              </details>
            ))}
          </details>
        )}
        {!!c.gaps?.length && (
          <div className="briefing-gaps">
            <h4>Missing or limited context</h4>
            <ul>
              {c.gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        )}
        <details>
          <summary>Conversation supplied</summary>
          {c.conversationSummary && (
            <section>
              <h4>Running summary</h4>
              {markdown(c.conversationSummary)}
            </section>
          )}
          {c.messages.map((m) => (
            <section key={m.id}>
              <h4>{m.role === "human" ? "You" : "Foreman"}</h4>
              {markdown(m.content)}
            </section>
          ))}
        </details>
        <details>
          <summary>Assignment</summary>
          {markdown(c.assignment || c.query)}
        </details>
        <details>
          <summary>Selection details</summary>
          <p>{c.searchMode}</p>
          {c.additionalRequests?.map((r) => (
            <p key={r.subject}>
              Requested: {r.subject}. {r.reason}
            </p>
          ))}
          {c.entries
            .filter((e) => !e.included)
            .map((e) => (
              <p key={e.id}>
                {e.title}: {e.reason}
              </p>
            ))}
        </details>
      </div>
    );
  }
  return (
    <details className="context-used">
      <summary>
        Context used{" "}
        <span>
          {context.documents.length}{" "}
          {context.documents.length === 1 ? "page" : "pages"}
        </span>
      </summary>
      {snapshot(context)}
      {(run.contextHistory?.length || 0) > 1 && (
        <details>
          <summary>Initial briefing before additional context</summary>
          {snapshot(run.contextHistory![0]!)}
        </details>
      )}
    </details>
  );
}
