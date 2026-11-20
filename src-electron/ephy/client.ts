import type { EphyArtifact, EphyDocument, EphyLatest } from '../ipc/contract'
import {
  DEFAULT_TIMEOUT_MS,
  EphyError,
  MAX_LIST_LIMIT,
  PAGE_SIZE,
  classify,
  cleanTitle,
  isValidId,
  parseDocument,
  parseList,
  parsePublished,
  parseViewerUrl
} from './core'
import type { Launcher } from './launcher'

/* Every Ephy command Inkwell runs. Port of Mac `EphyClient`. Each call checks
   `isEnabled` first and throws `disabled` without starting anything when the
   toggle is off; ids are validated before any process starts; note content is
   passed on stdin only. */

export type ClientOptions = {
  /** Absolute path of the CLI. */
  executable: string
  launcher: Launcher
  isEnabled: () => boolean
  timeoutMs?: number
}

export class EphyClient {
  private readonly executable: string
  private readonly launcher: Launcher
  private readonly isEnabled: () => boolean
  private readonly timeoutMs: number

  constructor(options: ClientOptions) {
    this.executable = options.executable
    this.launcher = options.launcher
    this.isEnabled = options.isEnabled
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async run(args: string[], stdin?: string): Promise<string> {
    if (!this.isEnabled()) throw new EphyError('disabled')
    const result = await this.launcher(this.executable, args, stdin, this.timeoutMs)
    if (!result) throw new EphyError('notFound')
    if (result.timedOut) throw new EphyError('timedOut')
    if (result.status !== 0) throw classify(result.status, result.stderr)
    return result.stdout
  }

  private checked(id: unknown): string {
    if (!isValidId(id)) throw new EphyError('invalidId')
    return id
  }

  /** `ephy post list --limit N --json`. The CLI lists newest first and has no
      cursor: asking for more means asking for a bigger page. */
  async list(limit: number = PAGE_SIZE): Promise<{ artifacts: EphyArtifact[]; rawCount: number; limit: number }> {
    const bounded = Math.min(Math.max(Math.trunc(Number.isFinite(limit) ? limit : PAGE_SIZE), 1), MAX_LIST_LIMIT)
    const parsed = parseList(await this.run(['post', 'list', '--limit', String(bounded), '--json']))
    return { ...parsed, limit: bounded }
  }

  /** `ephy post get <id> --json`. */
  async get(id: string): Promise<EphyDocument> {
    return parseDocument(await this.run(['post', 'get', this.checked(id), '--json']))
  }

  /** New version from stdin. `baseVersion` makes the CLI refuse when someone
      else published since. Returns the new version when the CLI reports it. */
  async update(id: string, content: string, baseVersion?: number): Promise<number | undefined> {
    const args = ['artifact', 'update', this.checked(id), '-', '--json']
    if (baseVersion !== undefined) {
      if (!Number.isInteger(baseVersion) || baseVersion < 0) throw new EphyError('failed', 'That is not a valid Ephy version.')
      args.push('--base-version', String(baseVersion))
    }
    return parsePublished(await this.run(args, content)).version
  }

  /** `ephy artifact new - --format MARKDOWN --title <t> --no-project --json`. */
  async create(title: string, content: string): Promise<{ id: string; version?: number }> {
    const args = ['artifact', 'new', '-', '--format', 'MARKDOWN', '--title', cleanTitle(title), '--no-project', '--json']
    const published = parsePublished(await this.run(args, content))
    if (!published.id) throw new EphyError('badOutput')
    return { id: published.id, ...(published.version === undefined ? {} : { version: published.version }) }
  }

  /** Get Latest: fetches the artifact and says whether the note already has
      that version. Only reads; nothing is published. */
  async latest(id: string, storedVersion?: number): Promise<EphyLatest> {
    const fetched = await this.get(id)
    if (storedVersion !== undefined && storedVersion === fetched.version) {
      return { upToDate: true, version: fetched.version }
    }
    return { upToDate: false, document: fetched }
  }

  /** `ephy post open <id> --json`: the viewer URL, https only. */
  async viewerUrl(id: string): Promise<string> {
    const url = parseViewerUrl(await this.run(['post', 'open', this.checked(id), '--json']))
    if (!url) throw new EphyError('badOutput')
    return url
  }
}
