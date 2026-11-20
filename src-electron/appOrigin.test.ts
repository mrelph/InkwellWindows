import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { developmentServerUrl, isAppUrl, isLoopbackHttpUrl } from './appOrigin'

describe('dev-server switch', () => {
  it('is ignored entirely in a packaged build', () => {
    expect(developmentServerUrl(['inkwell.exe', '--dev-server=http://127.0.0.1:5173'], {}, true)).toBeUndefined()
    expect(developmentServerUrl(['inkwell.exe'], { VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' }, true)).toBeUndefined()
  })
  it('accepts only loopback http URLs in development', () => {
    expect(developmentServerUrl(['e', '--dev-server=http://127.0.0.1:5173'], {}, false)).toBe('http://127.0.0.1:5173')
    expect(developmentServerUrl(['e'], { VITE_DEV_SERVER_URL: 'http://localhost:5173/' }, false)).toBe('http://localhost:5173/')
    expect(developmentServerUrl(['e', '--dev-server=http://[::1]:5173'], {}, false)).toBe('http://[::1]:5173')
    for (const raw of ['https://127.0.0.1:5173', 'http://evil.example', 'http://127.0.0.1.evil.example', 'http://user:pw@127.0.0.1', 'file:///C:/x.html', 'javascript:1', 'nonsense']) {
      expect(isLoopbackHttpUrl(raw), raw).toBe(false)
      expect(developmentServerUrl(['e', `--dev-server=${raw}`], {}, false), raw).toBeUndefined()
    }
  })
})

describe('isAppUrl (the IPC sender check)', () => {
  const indexFile = path.resolve('dist', 'index.html')
  const own = pathToFileURL(indexFile).toString()
  it('accepts the built index.html, with any hash or query', () => {
    expect(isAppUrl(own, { indexFile })).toBe(true)
    expect(isAppUrl(`${own}#/x`, { indexFile })).toBe(true)
    expect(isAppUrl(`${own}?a=1`, { indexFile })).toBe(true)
    if (process.platform === 'win32') expect(isAppUrl(own.toUpperCase().replace('FILE:', 'file:'), { indexFile })).toBe(true)
  })
  it('refuses any other page', () => {
    for (const url of [
      pathToFileURL(path.resolve('dist', 'other.html')).toString(),
      pathToFileURL(path.resolve('evil', 'index.html')).toString(),
      'file://attacker/share/index.html',
      'https://example.com/',
      'about:blank',
      'data:text/html,hi',
      'inkwell-asset://local/?f=x',
      ''
    ]) expect(isAppUrl(url, { indexFile }), url).toBe(false)
  })
  it('in development, accepts only the dev server origin', () => {
    const app = { indexFile, devServer: 'http://127.0.0.1:5173' }
    expect(isAppUrl('http://127.0.0.1:5173/src/main.tsx', app)).toBe(true)
    expect(isAppUrl('http://127.0.0.1:5174/', app)).toBe(false)
    expect(isAppUrl(own, app)).toBe(false)
  })
})
