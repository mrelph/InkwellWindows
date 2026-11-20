/* Library and display limits — Mac `Limits` in LibraryState.swift. The main
   process re-validates the same numbers in src-electron/state.ts. */

export const MAX_FOLDERS = 8
export const MAX_RECENT = 12
export const MIN_ZOOM = 80
export const MAX_ZOOM = 140
export const ZOOM_STEP = 10
export const DEFAULT_ZOOM = 100
export const MAX_EPHY_LINKS = 500

export const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
