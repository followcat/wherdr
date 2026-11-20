// Read aloud: what a voice says for an agent reply (Markdown). Code blocks become
// "Code block."; links, images, emphasis, headings, list and quote marks, tables
// and HTML tags are reduced to their words, so the voice does not spell markup.

export function speakableText(md: string, codeBlock = 'Code block.'): string {
  return md
    .replace(/\r\n?/g, '\n')
    // Fenced code (``` or ~~~, closed or still open at the end).
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, `\n${codeBlock}\n`)
    .replace(/<\/?[a-z][^>\n]*>/gi, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/^(?=[^\n]*\|)(?=[^\n]*-)[ \t|:-]+$\n?/gm, '')
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
    .replace(/^[ \t]*\|(.*)$/gm, (_, row: string) => row.split('|').map(c => c.trim()).filter(Boolean).join(', '))
    .replace(/(\*\*|__|~~)(\S(?:[\s\S]*?\S)?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](\S(?:[^\n]*?\S)?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// The Cantonese voice splits a reply into sentences only: its worker groups
// the words inside a sentence into short parts at G2P word boundaries, so a
// sentence never needs to be cut here.
export function sentenceChunks(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (/[。！？.!?；;\n]/.test(text[i]!)) {
      const s = text.slice(start, i + 1).trim()
      if (s) out.push(s)
      start = i + 1
    }
  }
  const rest = text.slice(start).trim()
  if (rest) out.push(rest)
  return out
}

// Speech engines cut long utterances (Chrome stops after ~15 s): the text goes
// out in pieces of at most `max` characters, split at a sentence, then a comma,
// then a space.
export function speechChunks(text: string, max = 220): string[] {
  const out: string[] = []
  for (const para of text.split(/\n+/)) {
    let rest = para.trim()
    while (rest.length > max) {
      const head = rest.slice(0, max + 1)
      const at = [/[.!?…;:](?=\s)(?![\s\S]*[.!?…;:]\s)/, /,(?=\s)(?![\s\S]*,\s)/, /\s(?![\s\S]*\s)/]
        .map(re => head.search(re)).find(i => i > max / 3)
      const cut = at === undefined ? max : at + 1
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) out.push(rest)
  }
  return out
}
