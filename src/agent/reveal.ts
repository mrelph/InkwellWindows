/* Shows invisible characters that can disguise a path, a link or a command
   (bidirectional overrides, zero-width marks, tag characters) as `<U+202E>`,
   and drops other control characters except tab and newline. Port of
   InkwellMac AgentText.reveal. Everything the agent sends that the panel shows
   as plain text goes through this. */

const invisible = (code: number) =>
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x2069) ||
  code === 0xfeff ||
  (code >= 0xe0000 && code <= 0xe007f)

export function reveal(text: string): string {
  let result = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (invisible(code)) result += `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`
    else if ((code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) continue
    else result += char
  }
  return result
}

/** The URL if it is something the panel may offer to open: http or https only. */
export function webUrl(href: string | undefined): string | null {
  if (!href) return null
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** A draft name with its Markdown extension, as main names the stand-in file. */
export const withMarkdownName = (name: string) => (/\.(md|mdx|markdown)$/i.test(name) ? name : `${name}.md`)
