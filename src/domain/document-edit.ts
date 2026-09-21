import { z } from "zod";
import { DomainError } from "./errors";

export const DOCUMENT_STORAGE_LIMIT = 500_000;
export const DOCUMENT_OUTPUT_LIMIT = 80_000;
export const DOCUMENT_BRIEFING_LIMIT = 16_000;
export const KNOWLEDGE_SECTIONS = [
  "Overview",
  "Current understanding",
  "Constraints and assumptions",
  "Decisions and implications",
  "Open questions",
  "References",
] as const;
export const knowledgeTemplate = KNOWLEDGE_SECTIONS.map(
  (h) => `## ${h}\n\n`,
).join("\n");
const path = z.array(z.string().trim().min(1).max(200)).min(1).max(6);
const markdown = z.string().max(DOCUMENT_OUTPUT_LIMIT);
export const documentEditSchema = z.object({
  documentId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  reason: z.string().min(1).max(2000),
  evidence: z.array(z.string().min(1)).max(30),
  needsApproval: z.boolean(),
  operations: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("replace_section"),
          headingPath: path,
          markdown,
        }),
        z.object({
          type: z.literal("insert_after_section"),
          headingPath: path,
          markdown,
        }),
        z.object({
          type: z.literal("append_section"),
          headingPath: z.array(z.string().min(1).max(200)).max(6).optional(),
          markdown,
        }),
        z.object({ type: z.literal("delete_section"), headingPath: path }),
        z.object({
          type: z.literal("move_section"),
          headingPath: path,
          afterHeadingPath: path,
        }),
        z.object({
          type: z.literal("replace_text"),
          oldText: z.string().min(1).max(DOCUMENT_OUTPUT_LIMIT),
          newText: markdown,
          expectedOccurrences: z.literal(1),
        }),
      ]),
    )
    .min(1)
    .max(20),
  // Citation changes are explicit. Evidence explains the edit; it does not
  // automatically become a permanent dependency of the entire page.
  sourceChanges: z
    .object({
      add: z.array(z.string().min(1)).max(30),
      remove: z.array(z.string().min(1)).max(30),
    })
    .optional(),
});
export type DocumentEdit = z.infer<typeof documentEditSchema>;
export type MarkdownSection = {
  heading: string;
  path: string[];
  level: number;
  start: number;
  bodyStart: number;
  end: number;
};

export function markdownSections(content: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let offset = 0,
    fence = "",
    fenceLength = 0;
  const stack: MarkdownSection[] = [];
  for (const line of content.split(/(?<=\n)/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) {
        fence = marker[1]![0]!;
        fenceLength = marker[1]!.length;
      } else if (
        marker[1]![0] === fence &&
        marker[1]!.length >= fenceLength &&
        /^ {0,3}(?:`+|~+)\s*$/.test(line)
      )
        fence = "";
    } else if (!fence) {
      const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*\n?$/);
      if (heading) {
        const level = heading[1]!.length;
        while (stack.length && stack.at(-1)!.level >= level)
          stack.pop()!.end = offset;
        const title = heading[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim();
        const section = {
          heading: title,
          path: [...(stack.at(-1)?.path || []), title],
          level,
          start: offset,
          bodyStart: offset + line.length,
          end: content.length,
        };
        sections.push(section);
        stack.push(section);
      }
    }
    offset += line.length;
  }
  return sections;
}

export function validateMarkdown(content: string, structured = false) {
  if (!content.trim() || content.length > DOCUMENT_STORAGE_LIMIT)
    throw new DomainError(
      "Document is empty or exceeds the storage safeguard.",
    );
  let fence = "",
    size = 0;
  for (const line of content.split("\n")) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!m) continue;
    if (!fence) {
      fence = m[1]![0]!;
      size = m[1]!.length;
    } else if (
      m[1]![0] === fence &&
      m[1]!.length >= size &&
      /^ {0,3}(?:`+|~+)\s*$/.test(line)
    )
      fence = "";
  }
  if (fence)
    throw new DomainError(
      "Markdown has an unfinished code block. Return a complete edit.",
    );
  if (structured) {
    const sections = markdownSections(content);
    const paths = sections.map((s) => JSON.stringify(s.path));
    if (new Set(paths).size !== paths.length)
      throw new DomainError("Knowledge section paths must be unique.");
    const top = sections.filter((s) => s.level <= 2);
    if (
      top.length !== KNOWLEDGE_SECTIONS.length ||
      top.some((s, i) => s.level !== 2 || s.heading !== KNOWLEDGE_SECTIONS[i])
    )
      throw new DomainError(
        "Knowledge must use the standard sections in order: " +
          KNOWLEDGE_SECTIONS.join(", ") +
          ". Organize detail under ### subsections.",
      );
    if (top.some((s) => !content.slice(s.bodyStart, s.end).trim()))
      throw new DomainError(
        "Each Knowledge section needs content; explicitly state when nothing is known or decided.",
      );
  }
}

export function applyDocumentEdit(
  content: string,
  edit: DocumentEdit,
  supplied = content,
) {
  let result = content;
  const suppliedSections = markdownSections(supplied);
  for (const operation of edit.operations) {
    if (
      ("markdown" in operation &&
        operation.markdown.length >= DOCUMENT_OUTPUT_LIMIT) ||
      (operation.type === "replace_text" &&
        operation.newText.length >= DOCUMENT_OUTPUT_LIMIT)
    )
      throw new DomainError(
        "Generated edit reached its output boundary. Split it into smaller edits.",
      );
    if (operation.type === "replace_text") {
      if (
        result.split(operation.oldText).length !== 2 ||
        !supplied.includes(operation.oldText)
      )
        throw new DomainError(
          "Text anchor must occur exactly once and have been supplied to the agent.",
        );
      result = result.replace(operation.oldText, () => operation.newText);
      continue;
    }
    const locate = (headingPath: string[]) => {
      const matches = markdownSections(result).filter(
        (s) => JSON.stringify(s.path) === JSON.stringify(headingPath),
      );
      if (
        matches.length !== 1 ||
        !suppliedSections.some(
          (s) => JSON.stringify(s.path) === JSON.stringify(headingPath),
        )
      )
        throw new DomainError(
          "Heading anchor is ambiguous, missing, or was not supplied: " +
            headingPath.join(" / "),
        );
      return matches[0]!;
    };
    if (operation.type === "append_section" && !operation.headingPath?.length) {
      result = result.trimEnd() + "\n\n" + operation.markdown.trim() + "\n";
      continue;
    }
    const section = locate(operation.headingPath!);
    const original = markdownSections(content).find(
      (s) => JSON.stringify(s.path) === JSON.stringify(operation.headingPath),
    );
    if (
      ["replace_section", "delete_section", "move_section"].includes(
        operation.type,
      ) &&
      original &&
      !supplied.includes(content.slice(original.start, original.end).trimEnd())
    )
      throw new DomainError(
        "The complete target section must be supplied before replacing, deleting or moving it.",
      );
    if (operation.type === "replace_section")
      result =
        result.slice(0, section.bodyStart) +
        "\n" +
        operation.markdown.trim() +
        "\n\n" +
        result.slice(section.end);
    else if (operation.type === "delete_section")
      result = result.slice(0, section.start) + result.slice(section.end);
    else if (operation.type === "move_section") {
      const after = locate(operation.afterHeadingPath);
      if (
        after.level !== section.level ||
        JSON.stringify(after.path.slice(0, -1)) !==
          JSON.stringify(section.path.slice(0, -1)) ||
        after.start === section.start
      )
        throw new DomainError(
          "Move sections only between different siblings under the same heading.",
        );
      const block = result.slice(section.start, section.end);
      const at =
        after.end > section.start ? after.end - block.length : after.end;
      result = result.slice(0, section.start) + result.slice(section.end);
      result = result.slice(0, at) + block + result.slice(at);
    } else
      result =
        result.slice(0, section.end).trimEnd() +
        "\n\n" +
        operation.markdown.trim() +
        "\n\n" +
        result.slice(section.end);
  }
  validateMarkdown(result);
  return result;
}

/** Whole sections are selected; omitted text is never presented as a full page. */
export function selectDocumentSections(
  content: string,
  query: string,
  limit = DOCUMENT_BRIEFING_LIMIT,
) {
  const outline = markdownSections(content);
  if (content.length <= limit)
    return { content, partial: false, outline: outline.map((s) => s.path) };
  const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  const pieces = outline
    .map((s, i) => {
      const end = outline[i + 1]?.start ?? content.length;
      const text = content.slice(s.start, end);
      const score = [...words].reduce(
        (n, w) =>
          n +
          (s.path.join(" ").toLowerCase().includes(w) ? 5 : 0) +
          (text.toLowerCase().includes(w) ? 1 : 0),
        0,
      );
      return { s, text, score: score + (s.heading === "Overview" ? 50 : 0) };
    })
    .sort((a, b) => b.score - a.score);
  let room = limit;
  const selected: typeof pieces = [];
  for (const piece of pieces) {
    // Include ancestor headings so exact heading paths survive excerpting.
    const parents = outline.filter(
      (s) =>
        s.start < piece.s.start &&
        s.end > piece.s.start &&
        !selected.some((p) => p.s.start === s.start),
    );
    const prefix = parents
      .map((s) => `${"#".repeat(s.level)} ${s.heading}\n\n`)
      .join("");
    if (piece.text.length + prefix.length > room) continue;
    selected.push(piece);
    room -= piece.text.length + prefix.length;
  }
  const included = new Set(selected.map((p) => p.s.start));
  const rendered = outline
    .filter(
      (s) =>
        included.has(s.start) ||
        selected.some((p) => s.start < p.s.start && s.end > p.s.start),
    )
    .map(
      (s) =>
        selected.find((p) => p.s.start === s.start)?.text ||
        `${"#".repeat(s.level)} ${s.heading}\n\n`,
    )
    .join("");
  return {
    content: rendered || content.slice(0, limit),
    partial: true,
    outline: outline.map((s) => s.path),
  };
}
