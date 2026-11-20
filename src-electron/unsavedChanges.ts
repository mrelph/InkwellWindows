/* Whether the renderer has unsaved work, as it last reported on
   `document:set-dirty` (main.ts listens). Read by the close guard and by the
   updater, which refuses "Restart to update" while work is unsaved rather than
   start an installer the close guard would then veto. */

let unsaved = false

export const hasUnsavedChanges = (): boolean => unsaved

export function setUnsavedChanges(value: unknown): void {
  unsaved = value === true
}
