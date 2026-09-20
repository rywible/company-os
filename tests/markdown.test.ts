import { expect, test } from "bun:test";
import { renderMarkdown } from "../src/server/markdown";
import type { MarkdownNode } from "../src/markdown-types";
function elements(nodes: MarkdownNode[]): Exclude<MarkdownNode, string>[] {
  return nodes.flatMap((node) =>
    typeof node === "string" ? [] : [node, ...elements(node.children)],
  );
}
test("native Markdown preserves GFM and Mermaid source", () => {
  const nodes = elements(
    renderMarkdown(
      "# Heading\n\n- [x] Done\n- [ ] Pending\n\n| A | B |\n| :- | -: |\n| x | y |\n\n```mermaid\ngraph TD\n A-->B\n```\n\n~~old~~ **new** &amp;",
    ),
  );
  expect(nodes.some((n) => n.tag === "h1")).toBe(true);
  expect(
    nodes.filter((n) => n.tag === "li").map((n) => n.props.checked),
  ).toEqual([true, false]);
  expect(nodes.filter((n) => n.tag === "th").map((n) => n.props.align)).toEqual(
    ["left", "right"],
  );
  expect(nodes.find((n) => n.tag === "pre")).toMatchObject({
    props: { language: "mermaid" },
  });
  expect(nodes.find((n) => n.tag === "pre")!.children.join("")).toBe(
    "graph TD\n A-->B\n",
  );
  expect(nodes.some((n) => n.tag === "del")).toBe(true);
  expect(nodes.some((n) => n.children.includes("&"))).toBe(true);
});
test("native Markdown keeps raw HTML inert and rejects executable URLs", () => {
  const source =
    "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert) [encoded](jav&#x61;script:alert) [data](data:text/html,boom) ![fallback](data:image/svg+xml,boom) [good](https://example.com)";
  const rendered = renderMarkdown(source);
  const nodes = elements(rendered);
  expect(nodes.some((n) => ["script", "html", "img"].includes(n.tag))).toBe(
    false,
  );
  expect(
    nodes
      .filter((n) => n.tag === "a")
      .map((n) => n.props.href)
      .filter(Boolean),
  ).toEqual(["https://example.com"]);
  expect(JSON.stringify(rendered)).toContain("<script>alert(1)</script>");
  expect(nodes.some((n) => n.children.includes("fallback"))).toBe(true);
});
