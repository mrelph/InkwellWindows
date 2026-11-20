/* Path helpers. DOM-free: the platform comes from the bridge when there is one
   and can be passed explicitly in tests. Windows paths compare
   case-insensitively and with either separator. */

const defaultCaseInsensitive = () =>
  (globalThis as { window?: { inkwell?: { platform?: string } } }).window?.inkwell?.platform === 'win32'

export const pathKey = (value: string, caseInsensitive = defaultCaseInsensitive()) => {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? normalized.toLocaleLowerCase('en-US') : normalized
}

export const samePath = (first: string | undefined, second: string | undefined) =>
  Boolean(first && second && pathKey(first) === pathKey(second))

/** Document ids are keyed on path, so reopening a file resolves to the
    existing entry instead of duplicating it. */
export const fileIdFor = (filePath: string) => `file:${pathKey(filePath)}`
export const folderIdFor = (folder: string) => `folder:${pathKey(folder)}`
export const folderLabel = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder
export const fileNameFor = (filePath: string) => filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath

export const isMarkdown = (filePath: string) => /\.(md|mdx|markdown)$/i.test(filePath)

/** A file name without its Markdown extension, for titles. */
export const clampTitle = (value: string) => value.replace(/\.(md|mdx|markdown)$/i, '')

/* Nested sources would list the same file twice under two headings, and the
   dedupe by path would silently drop one of them. Overlap is refused instead. */
export const isInside = (child: string, parent: string) => {
  const childKey = pathKey(child)
  const parentKey = pathKey(parent)
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`)
}
