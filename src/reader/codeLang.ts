/** Uppercased language label from a code element's `language-xxx` class, or ''. */
export function codeLanguageLabel(className: string | undefined): string {
  const match = /(?:^|\s)language-(\S+)/.exec(className ?? '')
  return match ? match[1].toUpperCase() : ''
}
