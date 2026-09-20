export function chunkDocument(title: string, content: string) {
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
