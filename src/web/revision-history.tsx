import React from "react";

export type DocumentRevision = {
  version: number;
  title: string;
  content: string;
  actor?: string;
  created_at: string;
};

export type LineChange = {
  kind: "added" | "removed";
  lines: string[];
};

const lines = (content: string) => content.replaceAll("\r\n", "\n").split("\n");

export function lineChanges(before: string, after: string): LineChange[] {
  let oldLines = lines(before);
  let newLines = lines(after);
  const changes: LineChange[] = [];
  const add = (kind: LineChange["kind"], line: string) => {
    const last = changes.at(-1);
    if (last?.kind === kind) last.lines.push(line);
    else changes.push({ kind, lines: [line] });
  };

  let sharedStart = 0;
  while (
    sharedStart < oldLines.length &&
    sharedStart < newLines.length &&
    oldLines[sharedStart] === newLines[sharedStart]
  )
    sharedStart++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > sharedStart &&
    newEnd > sharedStart &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  oldLines = oldLines.slice(sharedStart, oldEnd);
  newLines = newLines.slice(sharedStart, newEnd);

  // For a complete rewrite, showing both sides is clearer and avoids building
  // an unnecessarily large comparison table.
  if (oldLines.length * newLines.length > 250_000) {
    oldLines.forEach((line) => add("removed", line));
    newLines.forEach((line) => add("added", line));
    return changes;
  }

  const shared = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint16Array(newLines.length + 1),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--)
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--)
      shared[oldIndex]![newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? shared[oldIndex + 1]![newIndex + 1]! + 1
          : Math.max(
              shared[oldIndex + 1]![newIndex]!,
              shared[oldIndex]![newIndex + 1]!,
            );

  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      oldIndex++;
      newIndex++;
    } else if (
      shared[oldIndex + 1]![newIndex]! >=
      shared[oldIndex]![newIndex + 1]!
    ) {
      add("removed", oldLines[oldIndex++]!);
    } else {
      add("added", newLines[newIndex++]!);
    }
  }
  while (oldIndex < oldLines.length) add("removed", oldLines[oldIndex++]!);
  while (newIndex < newLines.length) add("added", newLines[newIndex++]!);
  return changes;
}

export function RevisionHistory({
  revisions,
  formatDate,
  showActor = false,
}: {
  revisions: DocumentRevision[];
  formatDate: (value: string) => string;
  showActor?: boolean;
}) {
  const byVersion = new Map(
    revisions.map((revision) => [revision.version, revision]),
  );
  return revisions.map((revision) => {
    const previous = byVersion.get(revision.version - 1);
    const changes = previous
      ? lineChanges(previous.content, revision.content)
      : [];
    const titleChanged = previous && previous.title !== revision.title;
    return (
      <details className="revision-entry" key={revision.version}>
        <summary>
          Revision {revision.version}
          {showActor && revision.actor ? ` · ${revision.actor}` : ""} ·{" "}
          {formatDate(revision.created_at)}
        </summary>
        {!previous ? (
          <p className="revision-note">Initial version created.</p>
        ) : !titleChanged && !changes.length ? (
          <p className="revision-note">No text changes.</p>
        ) : (
          <div
            className="revision-delta"
            aria-label={`Changes in revision ${revision.version}`}
          >
            {titleChanged && (
              <div className="revision-title-delta">
                <span className="removed">− Title: {previous.title}</span>
                <span className="added">+ Title: {revision.title}</span>
              </div>
            )}
            {changes.map((change, groupIndex) => (
              <div className={change.kind} key={`${change.kind}-${groupIndex}`}>
                {change.lines.map((line, lineIndex) => (
                  <div key={lineIndex}>
                    <span aria-hidden="true">
                      {change.kind === "added" ? "+" : "−"}
                    </span>{" "}
                    {line || <span className="blank-line">Blank line</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </details>
    );
  });
}
