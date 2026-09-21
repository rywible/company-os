import { expect, test } from "bun:test";
import {
  applyDocumentEdit,
  DOCUMENT_OUTPUT_LIMIT,
  documentEditSchema,
  markdownSections,
  selectDocumentSections,
  validateMarkdown,
} from "../src/domain/document-edit";
import { structuredKnowledge } from "./fixtures/curation";
const edit = (operations: any[]) =>
  documentEditSchema.parse({
    documentId: "doc",
    expectedVersion: 1,
    reason: "Correct the target",
    evidence: [],
    needsApproval: false,
    operations,
  });
test("section edits preserve siblings, ignore headings in fences, and require unique anchors", () => {
  const text =
    "## Targets\n\n### Browser\n\nChrome\n\n### Platform\n\nLinux\n\n```md\n## Targets\n```\n";
  expect(markdownSections(text)).toHaveLength(3);
  const result = applyDocumentEdit(
    text,
    edit([
      {
        type: "replace_section",
        headingPath: ["Targets", "Browser"],
        markdown: "Chromium on CPU",
      },
    ]),
  );
  expect(result).toContain("Chromium on CPU");
  expect(result).toContain("### Platform\n\nLinux");
  expect(() =>
    applyDocumentEdit(
      text + "\n## Targets\nAgain",
      edit([{ type: "delete_section", headingPath: ["Targets"] }]),
    ),
  ).toThrow("ambiguous");
  expect(() =>
    applyDocumentEdit(
      "x x",
      edit([
        {
          type: "replace_text",
          oldText: "x",
          newText: "y",
          expectedOccurrences: 1,
        },
      ]),
    ),
  ).toThrow("exactly once");
});
test("section insertion, removal and reordering use exact sibling paths", () => {
  const text =
    "## Findings\n\n### A\n\nAlpha\n\n### B\n\nBeta\n\n## Sources\n\nLink\n";
  const moved = applyDocumentEdit(
    text,
    edit([
      {
        type: "move_section",
        headingPath: ["Findings", "A"],
        afterHeadingPath: ["Findings", "B"],
      },
    ]),
  );
  expect(moved.indexOf("### B")).toBeLessThan(moved.indexOf("### A"));
  expect(moved).toContain("Alpha");
  const inserted = applyDocumentEdit(
    text,
    edit([
      {
        type: "insert_after_section",
        headingPath: ["Findings", "A"],
        markdown: "### C\n\nGamma",
      },
      { type: "delete_section", headingPath: ["Findings", "B"] },
    ]),
  );
  expect(inserted).toContain("Gamma");
  expect(inserted).not.toContain("Beta");
  expect(inserted).toContain("Link");
});
test("partial briefings permit visible text edits but cannot replace unseen section bodies", () => {
  const text =
    "## Findings\n\n### Target\n\nVisible\n\n### Detail\n\n" +
    "Huge. ".repeat(5000);
  const selected = selectDocumentSections(text, "Target", 1000);
  expect(selected.partial).toBe(true);
  expect(selected.content.length).toBeLessThanOrEqual(1000);
  expect(selected.outline).toContainEqual(["Findings", "Detail"]);
  expect(() =>
    applyDocumentEdit(
      text,
      edit([
        {
          type: "replace_section",
          headingPath: ["Findings"],
          markdown: "Lost detail",
        },
      ]),
      selected.content,
    ),
  ).toThrow("complete target section");
  expect(
    applyDocumentEdit(
      text,
      edit([
        {
          type: "replace_text",
          oldText: "Visible",
          newText: "Updated",
          expectedOccurrences: 1,
        },
      ]),
      selected.content,
    ),
  ).toContain("Huge. ".repeat(5000));
});
test("standard Knowledge layout and incomplete generated Markdown are validated", () => {
  expect(() =>
    validateMarkdown(structuredKnowledge("Useful finding"), true),
  ).not.toThrow();
  expect(() => validateMarkdown("## Random\n\nText", true)).toThrow(
    "standard sections",
  );
  expect(() => validateMarkdown("```ts\nconst x=1")).toThrow("unfinished");
  expect(() =>
    applyDocumentEdit(
      "Anchor",
      edit([
        {
          type: "replace_text",
          oldText: "Anchor",
          newText: "x".repeat(DOCUMENT_OUTPUT_LIMIT),
          expectedOccurrences: 1,
        },
      ]),
    ),
  ).toThrow("output boundary");
});
