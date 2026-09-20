import type { MarkdownNode } from "../markdown-types";
const tags = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "blockquote",
  "pre",
  "hr",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "em",
  "strong",
  "a",
  "img",
  "code",
  "del",
  "br",
]);
function safeURL(value: unknown, image = false): string | undefined {
  if (typeof value !== "string") return;
  // Bun may preserve entities in attributes; reject ambiguous encoded schemes.
  if (value.includes(":") && value.slice(0, value.indexOf(":")).includes("&"))
    return;
  try {
    const url = new URL(value, "https://company-os.invalid");
    if (
      ["http:", "https:", ...(image ? [] : ["mailto:"])].includes(url.protocol)
    )
      return value;
  } catch {}
}
// Send a small, explicit element tree, never executable HTML. React escapes text
// on the client. Only parser-generated tags and selected inert props cross over.
export function renderMarkdown(source: string): MarkdownNode[] {
  function visit(value: unknown, depth = 0): MarkdownNode[] {
    if (depth > 128) return [];
    if (typeof value === "string") return [value];
    if (Array.isArray(value))
      return value.flatMap((child) => visit(child, depth + 1));
    if (!value || typeof value !== "object") return [];
    const { type, props = {} } = value as {
      type: unknown;
      props?: Record<string, unknown>;
    };
    const children = visit(props.children, depth + 1);
    if (typeof type !== "string" || !tags.has(type)) return children;
    const clean: Record<string, string | number | boolean> = {};
    for (const key of ["title", "alt", "language"])
      if (typeof props[key] === "string") clean[key] = props[key];
    if (type === "a") {
      const href = safeURL(props.href);
      if (href) clean.href = href;
    }
    if (type === "img") {
      const src = safeURL(props.src, true);
      if (!src) return typeof props.alt === "string" ? [props.alt] : [];
      clean.src = src;
    }
    if (type === "ol" && typeof props.start === "number")
      clean.start = props.start;
    if (type === "li" && typeof props.checked === "boolean")
      clean.checked = props.checked;
    if (
      (type === "th" || type === "td") &&
      ["left", "center", "right"].includes(String(props.align))
    )
      clean.align = String(props.align);
    return [{ tag: type, props: clean, children }];
  }
  return visit(
    Bun.markdown.react(source, undefined, {
      noHtmlBlocks: true,
      noHtmlSpans: true,
      autolinks: true,
    }),
  );
}
