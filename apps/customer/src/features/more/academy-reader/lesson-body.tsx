import type { ReactNode } from 'react';

/**
 * A lesson's body as the service wrote it, in plain elements: headings (the lesson's own title once, not twice), code
 * blocks, numbered and bulleted lists, and paragraphs, with **bold** and `code` inside a line.
 */
function inlineText(text: string): ReactNode {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith('`') && part.endsWith('`') ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}
export function LessonBody({ body, title }: { body: string; title: string }) {
  return (
    <>
      {body
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((block, index) => {
          if (/^#{1,3} /.test(block)) {
            const heading = block.replace(/^#+ /, '').trim();
            return heading === title ? null : <h3 key={index}>{inlineText(heading)}</h3>;
          }
          if (block.startsWith('```'))
            return (
              <pre key={index}>
                <code>{block.replace(/^```[^\n]*\n/, '').replace(/\n```$/, '')}</code>
              </pre>
            );
          const lines = block.split('\n'),
            ordered = /^\d+\. /.test(lines[0] ?? ''),
            unordered = /^[-*] /.test(lines[0] ?? '');
          if (ordered || unordered) {
            const entries: string[] = [];
            for (const line of lines) {
              if (/^(?:\d+\.|[-*]) /.test(line)) entries.push(line.replace(/^(?:\d+\.|[-*]) /, ''));
              else if (entries.length) entries[entries.length - 1] += ' ' + line;
            }
            const children = entries.map((entry, n) => <li key={n}>{inlineText(entry)}</li>);
            return ordered ? <ol key={index}>{children}</ol> : <ul key={index}>{children}</ul>;
          }
          return <p key={index}>{inlineText(lines.join(' '))}</p>;
        })}
    </>
  );
}
