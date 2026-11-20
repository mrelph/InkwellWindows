import nodePath from 'node:path'

/* The renderer knows each open note by the path it opened it under; the agent
   sandbox works in REAL paths (symlinks, junctions, mapped drives and 8.3
   short names resolved). Port of Mac `AppModel.document(atResolvedPath:)`:
   main realpaths every open note (and every library folder) the renderer
   names and keeps real → renderer spelling, so

   - a buffer request for ANY open note, not just the active one, is sent
     under the renderer's spelling (and so reaches its buffer, not the disk);
   - a file-written event for a new file in a library folder is reported
     under the renderer's spelling of that folder, so the right group
     refreshes.

   No Electron imports. `canonicalize` is injected (realpath in production). */

export class PathSpellings {
  private notePaths: readonly string[] = []
  private rootPaths: readonly string[] = []
  /* Built on first use after each update: only an agent asking about a file
     pays for the realpaths, and only once per change of the open set. */
  private notes: Map<string, string> | null = null
  private roots: Array<{ real: string; spelled: string }> | null = null

  constructor(
    private readonly canonicalize: (path: string) => string | null,
    private readonly windows = process.platform === 'win32'
  ) {}

  private key(path: string): string {
    const normalized = (this.windows ? nodePath.win32 : nodePath.posix).normalize(path)
    return this.windows ? normalized.toLowerCase() : normalized
  }

  /** Replaces the map: the open notes' and the library folders' paths as the
      renderer spells them (already checked by the caller). */
  update(notePaths: readonly string[], rootPaths: readonly string[]): void {
    this.notePaths = [...notePaths]
    this.rootPaths = [...rootPaths]
    this.notes = null
    this.roots = null
  }

  private noteMap(): Map<string, string> {
    if (!this.notes) {
      this.notes = new Map()
      for (const spelled of this.notePaths) this.notes.set(this.key(this.canonicalize(spelled) ?? spelled), spelled)
    }
    return this.notes
  }

  private rootList(): Array<{ real: string; spelled: string }> {
    this.roots ??= this.rootPaths.map((spelled) => ({ real: this.canonicalize(spelled) ?? spelled, spelled }))
      /* Longest real path first, so a nested match wins. */
      .sort((a, b) => b.real.length - a.real.length)
    return this.roots
  }

  /** The renderer's spelling of the open note at real path `resolved`, else null. */
  noteFor(resolved: string): string | null {
    const notes = this.noteMap()
    return notes.get(this.key(resolved)) ?? notes.get(this.key(this.canonicalize(resolved) ?? resolved)) ?? null
  }

  /** `resolved` in the renderer's spelling: an open note's own path, or the
      same file under the renderer's spelling of the library folder holding
      it, or `resolved` itself when neither applies. */
  toRenderer(resolved: string): string {
    const note = this.noteFor(resolved)
    if (note) return note
    const pathApi = this.windows ? nodePath.win32 : nodePath.posix
    const key = this.key(resolved)
    for (const root of this.rootList()) {
      const rootKey = this.key(root.real)
      const prefix = rootKey.endsWith(pathApi.sep) ? rootKey : rootKey + pathApi.sep
      if (key.startsWith(prefix)) return pathApi.join(root.spelled, pathApi.relative(root.real, resolved))
    }
    return resolved
  }
}
