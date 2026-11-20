import { randomBytes } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { RPC, RPCError, type JsonValue } from './jsonrpc'
import { isDirectory, type PathSandbox } from './pathSandbox'

/* fs/read_text_file and fs/write_text_file, checked by the client itself (the
   spec puts that on the client, whatever the agent asked). Port of InkwellMac
   AgentFileAccess.swift.

   Reads and writes are allowed only inside `sandbox()`. Open notes are read
   from and written to their in-app buffer (the renderer owns unsaved text).
   Every write asks first. */

export const MAX_BYTES = 8 * 1024 * 1024

export type WriteRequest = {
  /** The resolved path. */
  path: string
  old: string
  new: string
  /** The path is an open note: the write changes its buffer, not the disk. */
  openNote: boolean
  /** The write makes a new file on disk. */
  creates: boolean
}

export type FileAccessHost = {
  /** The allowed roots, rebuilt at the time of each call. */
  sandbox: () => PathSandbox
  /** The unsaved text of the open note at this resolved path, or null when no
      note is open there. `virtual` marks an unsaved draft that has no file. */
  openBuffer: (path: string, virtual: boolean) => Promise<string | null>
  /** Puts new text into the open note as one undoable edit. False if it could
      not (no note open there any more). */
  applyToBuffer: (path: string, text: string) => Promise<boolean>
  /** Shows the path and a preview; true only for "Allow Once". */
  confirmWrite: (request: WriteRequest) => Promise<boolean>
  /** Called after a write lands on disk. */
  didWriteFile?: (path: string, created: boolean) => void
}

/** An error Inkwell's own checks raised, marked so the panel can say so. */
export function refusal(code: number, message: string, folders?: string[]): RPCError {
  const data: { [key: string]: JsonValue } = { refusedBy: 'inkwell' }
  if (folders) data.allowedFolders = folders
  return new RPCError(code, message, data)
}

export class AgentFileAccess {
  constructor(private readonly host: FileAccessHost) {}

  async read(path: string, line?: number, limit?: number): Promise<string> {
    const { resolved, virtual } = this.allowed(path)
    const buffer = await this.host.openBuffer(resolved, virtual)
    let text: string
    if (buffer !== null) text = buffer
    else if (virtual) throw refusal(RPC.resourceNotFound, 'That note is no longer open in Inkwell')
    else text = await readDisk(resolved)
    return slice(text, line, limit)
  }

  async write(path: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw refusal(RPC.invalidParams, 'That content is too large')
    const { resolved, virtual } = this.allowed(path)
    if (isDirectory(resolved)) throw refusal(RPC.invalidParams, 'That path is a folder')
    const buffer = await this.host.openBuffer(resolved, virtual)
    if (virtual && buffer === null) throw refusal(RPC.resourceNotFound, 'That note is no longer open in Inkwell')
    const existed = await exists(resolved)
    const old = buffer ?? await readDisk(resolved).catch(() => '')
    const allowed = await this.host.confirmWrite({
      path: resolved,
      old,
      new: content,
      openNote: buffer !== null,
      creates: buffer === null && !existed
    })
    if (!allowed) throw new RPCError(RPC.invalidRequest, 'The user denied this write in Inkwell', { refusedBy: 'user' })

    // Check again: the roots or the file may have changed while the sheet was up.
    const again = this.allowed(path)
    if (again.resolved !== resolved) throw refusal(RPC.invalidRequest, 'The path changed; ask again')
    const bufferNow = await this.host.openBuffer(resolved, virtual)
    // The user agreed to change an open note, not to write a file.
    if ((buffer === null) !== (bufferNow === null)) {
      throw refusal(RPC.invalidRequest, 'The note was saved or closed while Inkwell asked; ask again')
    }
    if (bufferNow !== null) {
      if (!await this.host.applyToBuffer(resolved, content)) throw new RPCError(RPC.internalError, 'Could not edit the open note')
      return
    }
    try {
      await writeAtomically(resolved, content)
    } catch {
      throw new RPCError(RPC.internalError, 'Could not write the file')
    }
    this.host.didWriteFile?.(resolved, !existed)
  }

  /** The resolved path, and whether it is an unsaved note (buffer only). */
  private allowed(path: string): { resolved: string; virtual: boolean } {
    const box = this.host.sandbox()
    const result = box.resolve(path)
    if (result.ok) return { resolved: result.path, virtual: box.files.includes(result.path) }
    switch (result.denial) {
      case 'notAbsolute': throw refusal(RPC.invalidParams, 'Paths must be absolute')
      case 'hidden': throw refusal(RPC.invalidParams, 'Hidden files and folders are off limits')
      case 'invalidName': throw refusal(RPC.invalidParams, 'That file name is not allowed')
      case 'missingFolder': throw refusal(RPC.resourceNotFound, 'That folder does not exist')
      case 'outside':
        if (box.roots.length === 0) {
          throw refusal(
            RPC.invalidParams,
            'Inkwell shares no folders with the agent yet. Ask the user to add a folder to the Inkwell library or save the note first',
            []
          )
        }
        throw refusal(RPC.invalidParams, `That path is outside the folders Inkwell shares: ${box.roots.join(', ')}`, box.roots)
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function readDisk(path: string): Promise<string> {
  let size: number
  try {
    const info = await stat(path)
    if (info.isDirectory()) throw new Error('directory')
    size = info.size
  } catch {
    throw new RPCError(RPC.resourceNotFound, 'File not found', { path })
  }
  if (size > MAX_BYTES) throw new RPCError(RPC.invalidParams, 'That file is too large')
  let data: Buffer
  try {
    data = await readFile(path)
  } catch {
    throw new RPCError(RPC.internalError, 'Could not read the file')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new RPCError(RPC.invalidParams, 'That is not a UTF-8 text file')
  }
}

/** `line` is 1-based; `limit` is a count of lines. */
export function slice(text: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return text
  const lines = text.split('\n')
  const start = Math.max(0, (line ?? 1) - 1)
  if (start >= lines.length) return ''
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + Math.max(0, limit))
  return lines.slice(start, end).join('\n')
}

/** Writes to a temp file beside the target, then renames over it, so a crash
    never leaves half a note. */
export async function writeAtomically(target: string, content: string): Promise<void> {
  const temp = nodePath.join(nodePath.dirname(target), `.inkwell-${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}
