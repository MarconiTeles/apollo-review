import type { ReactNode } from "react";

// Keep comments as plain text in storage and linkify only at render time. This
// makes existing reviews and every version clickable without rewriting data.
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export function LinkifiedCommentText({ text }: { text: string }): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const visible = raw.replace(TRAILING_PUNCTUATION, "");
    const suffix = raw.slice(visible.length);

    if (start > cursor) nodes.push(text.slice(cursor, start));

    const href = visible.toLowerCase().startsWith("www.")
      ? `https://${visible}`
      : visible;

    nodes.push(
      <a
        className="vw-comment-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        key={`${start}-${visible}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {visible}
      </a>,
    );
    if (suffix) nodes.push(suffix);
    cursor = start + raw.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes.length > 0 ? nodes : text;
}
