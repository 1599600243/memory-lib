// memory-lib D5.1 — split Markdown by ##/### heading sections, then by bounded lines.
const MIN_CHARS = 300;
const MAX_CHARS = 800;

export function chunkDocument(text, { minChars = MIN_CHARS, maxChars = MAX_CHARS } = {}) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!source.trim()) return [];
  const lines = source.split("\n");
  const sections = [];
  let heading = null;
  let sectionLines = [];
  for (const line of lines) {
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (sectionLines.length) sections.push({ heading, lines: sectionLines });
      heading = match[2].trim();
      sectionLines = [line];
    } else sectionLines.push(line);
  }
  if (sectionLines.length) sections.push({ heading, lines: sectionLines });

  const chunks = [];
  let sourceCursor = 0;
  for (const section of sections) {
    let buffer = [];
    let bufferStart = sourceCursor;
    let bufferLength = 0;
    let sourceLineOffset = sourceCursor;

    const emit = (carryLastLine) => {
      const textValue = buffer.join("\n").trim();
      if (textValue) chunks.push({
        chunk_index: chunks.length,
        heading: section.heading,
        text: textValue,
        start_offset: bufferStart,
        end_offset: Math.min(source.length, bufferStart + textValue.length),
        token_estimate: Math.max(1, Math.ceil(textValue.length / 4)),
      });
      const carry = carryLastLine && buffer.length ? buffer[buffer.length - 1] : null;
      buffer = carry ? [carry] : [];
      bufferLength = carry ? carry.length : 0;
      bufferStart = carry ? Math.max(sectionStart, sourceLineOffset - carry.length) : sourceLineOffset;
    };

    const sectionStart = sourceCursor;
    for (const raw of section.lines) {
      let line = raw;
      if (line.length > maxChars) {
        if (bufferLength >= minChars) emit(true);
        while (line.length > maxChars) {
          const part = line.slice(0, maxChars);
          if (!buffer.length) bufferStart = sourceLineOffset;
          buffer.push(part); bufferLength += part.length;
          line = line.slice(part.length);
          emit(false);
          bufferStart = sourceLineOffset + raw.length - line.length;
        }
      }
      const joinCost = buffer.length ? 1 : 0;
      if (bufferLength + joinCost + line.length > maxChars && bufferLength >= minChars) emit(true);
      if (!buffer.length) bufferStart = sourceLineOffset;
      buffer.push(line);
      bufferLength += line.length + (buffer.length > 1 ? 1 : 0);
      sourceLineOffset += raw.length + 1;
    }
    if (buffer.length) emit(false);
    sourceCursor += section.lines.reduce((sum, line) => sum + line.length + 1, 0);
  }
  return chunks;
}
