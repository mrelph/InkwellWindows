/// <reference types="vite/client" />

/* The renderer's view of the IPC contract. The shapes live in ONE place,
   src-electron/ipc/contract.ts, which the preload also type-checks against
   (`satisfies InkwellBridge`). These globals keep the renderer's existing
   ambient names working. */
import type * as Contract from '../src-electron/ipc/contract'

declare global {
  type DocumentFile = Contract.DocumentFile
  type RecentEntry = Contract.RecentEntry
  type ReaderFont = Contract.ReaderFont
  type ViewMode = Contract.ViewMode
  type AppearanceMode = Contract.AppearanceMode
  type AppTheme = Contract.AppTheme
  type EphyLink = Contract.EphyLink
  /** The remembered library: folder sources, recent files, and where you were. */
  type InkwellState = Contract.InkwellState
  /** A newer GitHub Release exists. Null everywhere else — see src-electron/update.ts. */
  type UpdateNotice = Contract.UpdateNotice
  type RenameResult = Contract.RenameResult
  type ThemePayload = Contract.ThemePayload
  type CommandId = Contract.CommandId
  type MenuState = Contract.MenuState
  type InkwellBridge = Contract.InkwellBridge

  interface Window {
    /** Undefined outside Electron (e.g. `vite` in a plain browser): file
        operations then no-op. */
    inkwell?: InkwellBridge
  }
}

export {}
