import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'

/* Which page is "the app", for the IPC sender check and the dev-server
   switch. No Electron imports; unit tested. */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** An `http://` URL on a loopback host with no credentials: the only kind of
    dev server main will load. */
export function isLoopbackHttpUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) && !url.username && !url.password
}

/** The Vite dev server to load, or undefined for the built app. A packaged
    build ignores both switches; a dev build accepts only a loopback http URL. */
export function developmentServerUrl(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  packaged: boolean
): string | undefined {
  if (packaged) return undefined
  const fromArgv = argv.find((argument) => argument.startsWith('--dev-server='))?.slice('--dev-server='.length)
  const raw = env.VITE_DEV_SERVER_URL || fromArgv
  return raw && isLoopbackHttpUrl(raw) ? raw : undefined
}

export type AppLocation = { indexFile: string; devServer?: string }

/** Whether `url` is the app's own page: the built index.html over file://
    (any hash or query), or the dev server's origin in development. */
export function isAppUrl(raw: string, app: AppLocation, pathApi: typeof nodePath = nodePath): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (app.devServer) {
    try {
      return url.origin === new URL(app.devServer).origin
    } catch {
      return false
    }
  }
  if (url.protocol !== 'file:' || (url.host && url.host.toLowerCase() !== 'localhost')) return false
  url.hash = ''
  url.search = ''
  let file: string
  try {
    file = fileURLToPath(url, { windows: pathApi.sep === '\\' })
  } catch {
    return false
  }
  const fold = (value: string) => (pathApi.sep === '\\' ? pathApi.resolve(value).toLowerCase() : pathApi.resolve(value))
  return fold(file) === fold(app.indexFile)
}
