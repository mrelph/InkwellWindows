import type { EphyErrorCode, EphyLink, EphyResult } from '../../src-electron/ipc/contract'
import { EPHY, type MarkdownDoc } from '../lib/library'
import { host, type DialogSpec, type EphyHost } from './ephyHost'
import { cleanTitle, dirtyAfterGetLatest, dirtyAfterPublish, getLatestPrompt, noteId, noteName, versionLabel } from './ephyLogic'

/* Renderer side of Ephy: the operations the commands and Save run, each with
   the confirmations the Mac asks (EphyController.swift). Content only ever
   goes through the bridge (stdin in main); it is never stored here or logged.

   Errors become a dialog with plain words; a signed-out Midway session says to
   run `mwinit` in a terminal (Inkwell never runs it). */

export type EphySaveOutcome =
  | { ok: true; version?: number }
  | { ok: false; error: EphyErrorCode; message: string }

const bridge = () => window.inkwell?.ephy

/** The toggle, asked of main at the start of each flow (the UI also gates on
    the pushed `ephy:enabled-changed` flag; this is the authoritative check). */
export async function isEnabled(): Promise<boolean> {
  try {
    return (await bridge()?.getEnabled()) === true
  } catch {
    return false
  }
}

/* One CLI action at a time, like Mac's `busy`. */
let busy = false
export const isBusy = (): boolean => busy

async function perform<T>(working: string, body: () => Promise<T>): Promise<T | undefined> {
  const app = host()
  if (!app) return undefined
  if (busy) {
    app.notify('Ephy is busy. Try again in a moment.')
    return undefined
  }
  busy = true
  app.notify(working)
  try {
    return await body()
  } finally {
    busy = false
  }
}

async function inform(app: EphyHost, title: string, detail: string): Promise<void> {
  await app.ask({ title, detail, confirmLabel: 'OK', cancelLabel: null })
}

/** A failed call as an alert: Mac `perform`'s catch. */
async function showFailure(app: EphyHost, failure: { error: EphyErrorCode; message: string }): Promise<void> {
  await inform(app, failure.error === 'signedOut' ? 'Sign in to Ephy.' : "Ephy couldn't do that.", failure.message)
}

const linkOf = (app: EphyHost, doc: MarkdownDoc): EphyLink | undefined =>
  doc.path ? app.ephyLinks()[doc.path] : doc.ephy

const currentDoc = (app: EphyHost, id: string): MarkdownDoc | undefined => app.documents().find((doc) => doc.id === id)

/* ---- Open -------------------------------------------------------------- */

/** Opens an artifact as an in-memory note. Already open: show it, and never
    replace edits with a fresh copy. */
export async function openArtifact(artifactId: string): Promise<boolean> {
  const app = host()
  if (!app || !(await isEnabled())) return false
  const existing = currentDoc(app, noteId(artifactId))
  if (existing) {
    app.addInMemoryDocument(existing)
    return true
  }
  const opened = await perform('Opening from Ephy…', async () => {
    const result = await bridge()!.open(artifactId)
    if (!result.ok) {
      await showFailure(app, result)
      return false
    }
    const fetched = result.value
    app.addInMemoryDocument({
      id: noteId(fetched.id),
      name: noteName(fetched.title),
      content: fetched.content,
      sourceId: EPHY,
      isDirty: false,
      ephy: { id: fetched.id, title: fetched.title, ...(fetched.version === undefined ? {} : { version: fetched.version }) }
    })
    app.notify(`Opened from Ephy${fetched.version === undefined ? '' : ` · v${fetched.version}`}`)
    return true
  })
  return opened === true
}

/* ---- Save -------------------------------------------------------------- */

/** Confirm, then publish a new version based on the version this note last
    saw. Returns the outcome without touching the document: the caller marks it
    saved. Conflict and gone-artifact follow-ups run from here. */
async function publishVersion(app: EphyHost, doc: MarkdownDoc, link: EphyLink): Promise<EphySaveOutcome> {
  const next = link.version === undefined ? '' : ` (v${link.version + 1})`
  const disk = doc.path ? '\n\nThe file on disk is not saved. Use Save (Ctrl+S) for that.' : ''
  const answer = await app.ask({
    title: `Save “${link.title}” to Ephy?`,
    detail: `Artifact ${link.id}\n\nThis will publish a new version${next} to Ephy. Everyone who can see the artifact sees it.${disk}`,
    confirmLabel: 'Publish',
    cancelLabel: 'Cancel'
  })
  if (!answer.confirmed) return { ok: false, error: 'failed', message: 'Save to Ephy canceled.' }

  // The content is read now, after the question: edits made while the sheet was open count.
  const latestDoc = currentDoc(app, doc.id) ?? doc
  const result = await perform('Saving to Ephy…', () => bridge()!.save({ id: link.id, content: latestDoc.content, baseVersion: link.version }))
  if (!result) return { ok: false, error: 'failed', message: 'Ephy is busy. Try again in a moment.' }
  if (result.ok) return { ok: true, version: result.value.version }

  if (result.error === 'conflict') {
    app.notify('Ephy has a newer version')
    const choice = await app.ask({
      title: "Ephy couldn't do that.",
      detail: result.message,
      confirmLabel: 'Get Latest…',
      cancelLabel: 'OK'
    })
    if (choice.confirmed) await getLatest(currentDoc(app, doc.id) ?? doc)
    return { ok: false, error: 'conflict', message: 'Ephy has a newer version. Your edits are still here, unsaved.' }
  }
  if (result.error === 'unavailable') {
    app.notify('Ephy artifact unavailable')
    const choice = await app.ask({
      title: `“${link.title}” is gone from Ephy, or you can no longer edit it.`,
      detail: `Artifact ${link.id}\n\nPublish this note as a new artifact instead? The note will be linked to the new one.`,
      confirmLabel: 'Publish New Copy…',
      cancelLabel: 'Cancel'
    })
    if (choice.confirmed) await saveAsNew(currentDoc(app, doc.id) ?? doc, true)
    return { ok: false, error: 'unavailable', message: result.message }
  }
  await showFailure(app, result)
  return { ok: false, error: result.error, message: result.message }
}

/** App calls this for Save (Ctrl+S) on an Ephy note and applies the outcome
    itself (marks it clean unless typing continued, stores the version). */
export async function ephySave(doc: MarkdownDoc): Promise<EphySaveOutcome> {
  const app = host()
  if (!bridge() || !app) return { ok: false, error: 'notImplemented', message: 'Ephy needs the desktop app.' }
  if (!(await isEnabled())) return { ok: false, error: 'disabled', message: 'Ephy is turned off. Turn it on in Integrations ▸ Ephy.' }
  if (!doc.ephy) return { ok: false, error: 'invalidId', message: 'This note is not linked to Ephy.' }
  return publishVersion(app, doc, doc.ephy)
}

/** The Save to Ephy command and button: a linked note (an Ephy note, or a file
    published before) gets a new version, any other note a new artifact. */
export async function saveActiveToEphy(doc: MarkdownDoc): Promise<void> {
  const app = host()
  if (!app || !(await isEnabled())) return
  const link = linkOf(app, doc)
  if (!link) return saveAsNew(doc)

  const revision = doc.revision ?? 0
  const outcome = await publishVersion(app, doc, link)
  if (!outcome.ok) {
    if (outcome.error === 'failed') app.notify(outcome.message)
    return
  }
  const next: EphyLink = { ...link, version: outcome.version ?? link.version }
  const now = currentDoc(app, doc.id)
  if (!doc.path) {
    // An Ephy note: clean unless nobody-typed-during-upload fails.
    const dirty = dirtyAfterPublish({ ephyOnly: true, isDirty: now?.isDirty ?? false, sentRevision: revision, currentRevision: now?.revision ?? revision })
    app.updateDocument(doc.id, { isDirty: dirty, ephy: next })
    app.notify(`Saved to Ephy${next.version === undefined ? '' : ` · v${next.version}`}${dirty ? ' · newer edits not saved' : ''}`)
  } else {
    app.setEphyLink(doc.path, next)
    const dirty = dirtyAfterPublish({ ephyOnly: false, isDirty: now?.isDirty ?? false, sentRevision: revision, currentRevision: now?.revision ?? revision })
    app.notify(`Saved to Ephy${next.version === undefined ? '' : ` · v${next.version}`}${dirty ? ' · file not saved' : ''}`)
  }
}

/** Save as a New Ephy Artifact: asks for a title, then publishes. A note with
    no file becomes a new Ephy note; a local file stays as it is and is linked
    to the new artifact (asking first if it was already linked). */
export async function saveAsNew(doc: MarkdownDoc, forceRelink = false): Promise<void> {
  const app = host()
  if (!app || !(await isEnabled())) return
  const existing = doc.path ? linkOf(app, doc) : undefined
  const asking: DialogSpec = {
    title: 'Save as a new Ephy artifact?',
    detail: `This will publish a new Markdown artifact to Ephy.${existing && !forceRelink ? ` This file stays linked to “${existing.title}” (${existing.id}) unless you tick the box.` : ''}`,
    confirmLabel: 'Publish',
    cancelLabel: 'Cancel',
    input: { label: 'Title', value: doc.ephy?.title ?? doc.name.replace(/\.(md|markdown|mdx|txt)$/i, '') },
    ...(existing && !forceRelink ? { checkbox: { label: 'Link this file to the new artifact' } } : {})
  }
  const answer = await app.ask(asking)
  if (!answer.confirmed) return

  const title = cleanTitle(answer.text)
  const sent = currentDoc(app, doc.id) ?? doc
  const content = sent.content
  const revision = sent.revision ?? 0
  const linkFile = !existing || forceRelink || answer.checked
  await perform('Publishing to Ephy…', async () => {
    const result = await bridge()!.saveAsNew({ title, content })
    if (!result.ok) {
      await showFailure(app, result)
      return
    }
    const created: EphyLink = { id: result.value.id, title, ...(result.value.version === undefined ? {} : { version: result.value.version }) }
    if (doc.path) {
      // The file on disk is untouched, dirty or not.
      if (linkFile) app.setEphyLink(doc.path, created)
      app.notify(linkFile ? `Published to Ephy · linked to ${created.id}` : `Published a copy to Ephy · ${created.id}`)
      return
    }
    /* A draft or an Ephy note becomes the new artifact's note (Mac
       EphyController.saveAsNew): same buffer, new id, source and link. It
       stays dirty only if typing went on during the upload. */
    const now = currentDoc(app, doc.id)
    const dirty = now ? (now.revision ?? 0) !== revision : false
    const moved = now !== undefined && app.rekeyDocument(doc.id, {
      id: noteId(created.id),
      sourceId: EPHY,
      name: noteName(title),
      isDirty: dirty,
      ephy: created
    })
    if (!moved) {
      app.notify(`Published a copy to Ephy · ${created.id}`)
      return
    }
    app.notify(dirty ? 'Published to Ephy · newer edits not saved' : `Published to Ephy · ${created.id}`)
  })
}

/* ---- Get Latest -------------------------------------------------------- */

/** Fetches the linked artifact and, if Ephy has a different version, asks
    before replacing the note's text (one undoable edit). */
export async function getLatest(doc: MarkdownDoc): Promise<void> {
  const app = host()
  if (!app) return
  if (!(await isEnabled())) return
  const link = linkOf(app, doc)
  if (!link) return

  const found = await perform('Checking Ephy…', async () => {
    const result = await bridge()!.getLatest({ id: link.id, ...(link.version === undefined ? {} : { version: link.version }) })
    if (!result.ok) {
      await showFailure(app, result)
      return null
    }
    return result.value
  })
  if (!found) return
  if (found.upToDate) {
    app.notify(`Already up to date (${versionLabel(found.version)})`)
    return
  }
  const fetched = found.document
  // The note as it is now: edits made while the CLI ran count.
  const current = currentDoc(app, doc.id)
  if (!current) return
  const prompt = getLatestPrompt({ have: link.version, next: fetched.version, unsavedEdits: current.isDirty === true, localFile: current.path !== undefined })
  const answer = await app.ask({
    title: prompt.message,
    detail: `“${fetched.title}” (${fetched.id})\n\n${prompt.detail}`,
    confirmLabel: 'Replace',
    cancelLabel: 'Cancel',
    destructive: true,
    defaultCancel: true
  })
  if (!answer.confirmed) return

  const now = currentDoc(app, doc.id)
  if (!now) return
  const changed = now.content !== fetched.content
  if (changed && !app.applyEditTo(now.id, fetched.content)) return
  /* Undo must not bring back text older than the version the note now
     records, or a later Save would publish stale text as "the latest". */
  if (changed) app.resetUndo(now.id)
  const dirty = dirtyAfterGetLatest({ ephyOnly: now.path === undefined, wasDirty: now.isDirty === true, textChanged: changed })
  // The next Save to Ephy is based on this version.
  const latest: EphyLink = { id: link.id, title: fetched.title, ...((fetched.version ?? link.version) === undefined ? {} : { version: fetched.version ?? link.version }) }
  if (now.path) {
    app.setEphyLink(now.path, latest)
    if (!dirty) app.updateDocument(now.id, { isDirty: false })
  } else {
    app.updateDocument(now.id, { isDirty: dirty, ephy: latest })
  }
  const unsaved = now.path && dirty ? ' · file not saved' : ''
  app.notify(`Got the latest from Ephy${fetched.version === undefined ? '' : ` · v${fetched.version}`}${unsaved}`)
}

/* ---- Browser ----------------------------------------------------------- */

/** Main asks the CLI for the viewer URL and opens it (https only); the page
    never supplies one. */
export async function openInBrowser(doc: MarkdownDoc): Promise<void> {
  const app = host()
  if (!app || !(await isEnabled())) return
  const link = linkOf(app, doc)
  if (!link) return
  await perform('Opening in the browser…', async () => {
    const result = await bridge()!.openInBrowser(link.id)
    if (!result.ok) {
      await showFailure(app, result)
      return
    }
    app.notify('Opened in the browser')
  })
}

/* ---- Session state for the picker ------------------------------------- */

export type PickerFailure = { error: EphyErrorCode; message: string }

export const failureOf = (result: Extract<EphyResult<unknown>, { ok: false }>): PickerFailure => ({ error: result.error, message: result.message })
