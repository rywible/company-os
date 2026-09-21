import { markdownSections } from "./document-edit";
export function chunkDocument(title: string, content: string) {
  const sections = markdownSections(content);
  if (sections.length) {
    const chunks: string[] = [];
    if (sections[0]!.start > 0) chunks.push(...chunkParagraphs(title, content.slice(0, sections[0]!.start)));
    sections.forEach((s, i) => chunks.push(...chunkParagraphs(title + " / " + s.path.join(" / "), content.slice(s.bodyStart, sections[i + 1]?.start ?? content.length))));
    return chunks;
  }
  return chunkParagraphs(title, content);
}
function chunkParagraphs(title: string, content: string) {
  const paragraphs = content.split(/\n\n+/),
    chunks: string[] = [];
  let current = title + "\n\n";
  for (const paragraph of paragraphs) {
    // Bound long paragraphs as well as normal sections, below the embedding input limit.
    for (let i = 0; i < paragraph.length; i += 1800) {
      const part = paragraph.slice(i, i + 1800);
      if (current.length + part.length > 2200) {
        chunks.push(current.trim());
        current = title + "\n\n";
      }
      current += part + "\n\n";
    }
  }
  if (current.trim() !== title) chunks.push(current.trim());
  return chunks;
}
