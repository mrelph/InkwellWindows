import { open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { DocumentFile } from './ipc/contract'

/* All filesystem helpers the document IPC uses. No Electron imports, so the
   tests workstream can exercise these directly under vitest. Owned by the file
   I/O workstream (D). */

export type { DocumentFile } from './ipc/contract'

export const isMarkdown = (filePath: string) => /\.(md|mdx|markdown)$/i.test(filePath)

export const MAX_FOLDER_FILES = 500
export const MAX_FOLDER_DEPTH = 4

/** Folders never scanned: dependency trees that can hold thousands of README
    files nobody meant to add (Mac `FileStore.skippedFolders`). Hidden folders
    are skipped as well. Compared case-insensitively. */
export const SKIPPED_FOLDERS = new Set(['node_modules'])

/* Decoding mirrors the Mac's `String(data:encoding:.utf8) ?? String(decoding:)`:
   valid UTF-8 is read as is, anything else is read leniently (undecodable bytes
   become U+FFFD) rather than refusing to open the note. On top of that, a UTF-8
   BOM is dropped and UTF-16 files that carry a BOM (common from Notepad and
   PowerShell redirection) are decoded properly instead of coming out as NULs. */
export function decodeDocument(bytes: Uint8Array): string {
  const length = bytes.length
  if (length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeUtf8(bytes.subarray(3))
  }
  if (length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2)
    const swapped = new Uint8Array(body.length - (body.length % 2))
    for (let index = 0; index < swapped.length; index += 2) {
      swapped[index] = body[index + 1]
      swapped[index + 1] = body[index]
    }
    return new TextDecoder('utf-16le').decode(swapped)
  }
  return decodeUtf8(bytes)
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes)
  }
}

export async function readMarkdownFile(filePath: string): Promise<DocumentFile> {
  const [bytes, details] = await Promise.all([readFile(filePath), stat(filePath)])
  return {
    name: path.basename(filePath),
    path: filePath,
    content: decodeDocument(bytes),
    savedAt: details.mtimeMs
  }
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_BACKOFF_MS = [20, 50, 100, 200, 400]

export type AtomicWriteOptions = {
  /** Injected by tests; defaults to fs.rename. */
  rename?: (from: string, to: string) => Promise<void>
  /** Backoff schedule between rename attempts, in ms. */
  backoff?: readonly number[]
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/* Mirrors `FileStore.writeAtomically`: write a temp file next to the target,
   then rename it over the target, so a crash or a full disk mid-write cannot
   leave a half-written note. The content is written verbatim (no line-ending
   or BOM changes) as UTF-8.

   Windows adds a wrinkle: renaming over a file that antivirus, a sync client
   or an indexer has open fails with EPERM/EBUSY/EACCES, usually for a few
   milliseconds. Retry with backoff; if it never clears, fall back to a direct
   write (not atomic, but the save succeeds). The temp file never outlives the
   call. Resolves with the target's new mtime. */
export async function writeAtomically(
  target: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<number> {
  const doRename = options.rename ?? rename
  const backoff = options.backoff ?? RENAME_BACKOFF_MS

  /* Write through a symlink rather than replacing the link with a file. */
  let destination = target
  try {
    destination = await realpath(target)
  } catch {
    /* Does not exist yet: create it at the given path. */
  }

  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomBytes(6).toString('hex')}.inkwell-tmp`
  )

  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync().catch(() => undefined)
    } finally {
      await handle.close()
    }

    let renamed = false
    for (let attempt = 0; ; attempt += 1) {
      try {
        await doRename(temporary, destination)
        renamed = true
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (!code || !RENAME_RETRY_CODES.has(code) || attempt >= backoff.length) break
        await sleep(backoff[attempt])
      }
    }

    if (!renamed) await writeFile(destination, content, 'utf8')
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }

  return (await stat(destination)).mtimeMs
}

/* An unreadable file must not fail the whole open: a folder with one
   permission-denied note should still open every other note in it. */
export async function readMarkdownFileSafely(filePath: string): Promise<DocumentFile | null> {
  try {
    return await readMarkdownFile(filePath)
  } catch {
    return null
  }
}

const isSkippedFolder = (name: string) => name.startsWith('.') || SKIPPED_FOLDERS.has(name.toLowerCase())

export async function walkMarkdownFiles(directory: string, depth = 0): Promise<DocumentFile[]> {
  if (depth > MAX_FOLDER_DEPTH) return []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const records = await Promise.all(
    entries.map(async (entry) => {
      const itemPath = path.join(directory, entry.name)
      if (entry.isDirectory() && !isSkippedFolder(entry.name)) return walkMarkdownFiles(itemPath, depth + 1)
      if (entry.isFile() && isMarkdown(entry.name)) {
        const file = await readMarkdownFileSafely(itemPath)
        return file ? [file] : []
      }
      return []
    })
  )
  return records.flat().slice(0, MAX_FOLDER_FILES)
}

/* Files handed to Inkwell on the command line, e.g. `inkwell notes.md` from a
   file manager or a shell. */
export async function documentsFromArgv(argv: readonly string[], workingDirectory?: string): Promise<DocumentFile[]> {
  const candidates = argv.filter((arg) => !arg.startsWith('-') && isMarkdown(arg))
  const base = workingDirectory && path.isAbsolute(workingDirectory) ? workingDirectory : process.cwd()
  const files = await Promise.all(candidates.map(async (candidate) => {
    const resolved = path.resolve(base, candidate)
    try {
      const details = await stat(resolved)
      if (!details.isFile()) return null
    } catch {
      return null
    }
    return readMarkdownFileSafely(resolved)
  }))
  return files.filter((file): file is DocumentFile => file !== null)
}

export const exists = async (target: string) => {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/* A name typed into the sidebar is a *file name*, never a path: a `/` or a `..`
   in it would move the file somewhere the user did not ask for, so those are
   rejected rather than normalised. The Markdown extension is added when the
   user leaves it off so a rename cannot quietly drop the file out of the
   library it lives in. */
export const toFileName = (raw: string, platform: NodeJS.Platform = process.platform) => {
  const name = raw.trim()
  if (!name || name === '.' || name === '..') return null
  if (name.includes('/') || name.includes('\0') || name.startsWith('.')) return null
  if (platform === 'win32') {
    if (/[<>:"\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) return null
    const stem = name.split('.')[0]
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) return null
  }
  /* The limit applies to the name that reaches the disk, extension included:
     255 UTF-16 units on NTFS, 255 bytes on most POSIX file systems. */
  const fileName = /\.(md|mdx|markdown)$/i.test(name) ? name : `${name}.md`
  const tooLong = platform === 'win32' ? fileName.length > 255 : Buffer.byteLength(fileName, 'utf8') > 255
  return tooLong ? null : fileName
}

/* `notes.md` → `notes copy.md`, then `notes copy 2.md`. Bounded so a directory
   that cannot be written to fails fast instead of spinning. */
export async function uniqueCopyPath(source: string) {
  const directory = path.dirname(source)
  const extension = path.extname(source)
  const base = path.basename(source, extension)
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const suffix = attempt === 1 ? ' copy' : ` copy ${attempt}`
    const candidate = path.join(directory, `${base}${suffix}${extension}`)
    if (!(await exists(candidate))) return candidate
  }
  return null
}
