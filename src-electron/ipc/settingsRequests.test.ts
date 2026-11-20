import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The Settings popover's requests, with Electron and the sender guard
   stubbed. The property under test: a page can ASK for an integration to be
   turned on, and only a click in main's native confirmation turns it on. */

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('../ipcGuard', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, fn),
  on: (channel: string, fn: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, fn)
}))

type Box = { response: number }
const dialog = vi.hoisted(() => ({ showMessageBox: vi.fn<(...args: unknown[]) => Promise<Box>>() }))
const appMenu = vi.hoisted(() => ({ popup: vi.fn() }))
const Menu = vi.hoisted(() => ({ getApplicationMenu: vi.fn<() => { popup: (options: unknown) => void } | null>() }))

vi.mock('electron', () => ({ dialog, Menu }))

const { DECLINE_QUIET_MS, menuPopupPoint, registerSettingsRequests, resetSettingsRequestsForTest } = await import('./settingsRequests')

const TURN_ON = { response: 0 }
const CANCEL = { response: 1 }

const webContents = { getZoomFactor: () => 1.25 }
const window = { isDestroyed: () => false, webContents, getContentSize: () => [1000, 700] }
const event = { sender: webContents }
const stranger = { sender: {} }

const state = { agent: false, ephy: false, now: 1_000_000 }
const setAgent = vi.fn((on: boolean) => (state.agent = on))
const setEphy = vi.fn((on: boolean) => (state.ephy = on))
const showAbout = vi.fn()

registerSettingsRequests({
  window: () => window as never,
  agent: { isEnabled: () => state.agent, setEnabled: setAgent, harnessTitle: () => 'Kiro CLI' },
  ephy: { isEnabled: () => state.ephy, setEnabled: setEphy },
  showAbout,
  now: () => state.now
})

const call = <T,>(channel: string, from: unknown = event, ...args: unknown[]) =>
  hoisted.handlers.get(channel)!(from, ...args) as T

beforeEach(() => {
  state.agent = false
  state.ephy = false
  state.now += 10 * DECLINE_QUIET_MS
  resetSettingsRequestsForTest()
  for (const mock of [dialog.showMessageBox, setAgent, setEphy, showAbout, appMenu.popup, Menu.getApplicationMenu]) mock.mockClear()
  dialog.showMessageBox.mockReset()
  Menu.getApplicationMenu.mockReturnValue(appMenu)
})

describe('enabling an integration is a request main confirms', () => {
  it('registers request and disable channels, and no setter', () => {
    expect([...hoisted.handlers.keys()].sort()).toEqual([
      'agent:disable', 'agent:request-enable', 'app:about', 'ephy:disable', 'ephy:request-enable', 'menu:popup'
    ])
  })

  it('turns the agent on only after "Turn On" in a window-modal native dialog', async () => {
    dialog.showMessageBox.mockResolvedValue(TURN_ON)
    await expect(call('agent:request-enable')).resolves.toBe(true)
    expect(setAgent).toHaveBeenCalledExactlyOnceWith(true)
    expect(state.agent).toBe(true)
    const [parent, options] = dialog.showMessageBox.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(parent).toBe(window)
    expect(options.message).toBe('Turn on the agent?')
    expect(String(options.detail)).toContain('Kiro CLI')
    expect(options.buttons).toEqual(['Turn On', 'Cancel'])
    // Enter and Escape both land on Cancel.
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
  })

  it('leaves the agent off when the dialog is cancelled', async () => {
    dialog.showMessageBox.mockResolvedValue(CANCEL)
    await expect(call('agent:request-enable')).resolves.toBe(false)
    expect(setAgent).not.toHaveBeenCalled()
    expect(state.agent).toBe(false)
  })

  it('leaves it off when the dialog fails or answers anything but Turn On', async () => {
    dialog.showMessageBox.mockRejectedValueOnce(new Error('window gone'))
    await expect(call('ephy:request-enable')).resolves.toBe(false)
    dialog.showMessageBox.mockResolvedValueOnce({ response: 7 })
    await expect(call('ephy:request-enable')).resolves.toBe(false)
    expect(setEphy).not.toHaveBeenCalled()
  })

  it('confirms Ephy the same way, with its own wording', async () => {
    dialog.showMessageBox.mockResolvedValue(TURN_ON)
    await expect(call('ephy:request-enable')).resolves.toBe(true)
    expect(setEphy).toHaveBeenCalledExactlyOnceWith(true)
    expect(setAgent).not.toHaveBeenCalled()
    expect((dialog.showMessageBox.mock.calls[0][1] as { message: string }).message).toBe('Turn on Ephy?')
  })

  it('ignores every argument: nothing the page sends skips the dialog', async () => {
    dialog.showMessageBox.mockResolvedValue(CANCEL)
    for (const payload of [true, 'yes', { confirmed: true, response: 0 }, [0], 0]) {
      resetSettingsRequestsForTest()
      await expect(call('agent:request-enable', event, payload)).resolves.toBe(false)
    }
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(5)
    expect(setAgent).not.toHaveBeenCalled()
  })

  it('does not stack dialogs: a request while one is open is refused, for either integration', async () => {
    let answer: (box: Box) => void = () => undefined
    dialog.showMessageBox.mockImplementation(() => new Promise<Box>((resolve) => { answer = resolve }))
    const first = call<Promise<boolean>>('agent:request-enable')
    await expect(call('agent:request-enable')).resolves.toBe(false)
    await expect(call('ephy:request-enable')).resolves.toBe(false)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    answer(TURN_ON)
    await expect(first).resolves.toBe(true)
    // The refused requests enabled nothing.
    expect(state.ephy).toBe(false)
    expect(setAgent).toHaveBeenCalledTimes(1)
  })

  it('stays quiet after a Cancel, then asks again', async () => {
    dialog.showMessageBox.mockResolvedValue(CANCEL)
    await call('agent:request-enable')
    await expect(call('agent:request-enable')).resolves.toBe(false)
    await expect(call('ephy:request-enable')).resolves.toBe(false)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    state.now += DECLINE_QUIET_MS
    dialog.showMessageBox.mockResolvedValue(TURN_ON)
    await expect(call('agent:request-enable')).resolves.toBe(true)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('asks nothing when the integration is already on', async () => {
    state.agent = true
    await expect(call('agent:request-enable')).resolves.toBe(true)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(setAgent).not.toHaveBeenCalled()
  })

  it('refuses a sender that is not the app window, without a dialog', async () => {
    await expect(call('agent:request-enable', stranger)).resolves.toBe(false)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    state.ephy = true
    expect(call('ephy:disable', stranger)).toBe(true)
    expect(setEphy).not.toHaveBeenCalled()
  })
})

describe('disabling is direct', () => {
  it('turns the agent and Ephy off with no dialog', () => {
    state.agent = true
    state.ephy = true
    expect(call('agent:disable')).toBe(false)
    expect(call('ephy:disable')).toBe(false)
    expect(setAgent).toHaveBeenCalledExactlyOnceWith(false)
    expect(setEphy).toHaveBeenCalledExactlyOnceWith(false)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('cannot be used to enable: the payload is ignored', () => {
    expect(call('agent:disable', event, true)).toBe(false)
    expect(call('ephy:disable', event, { on: true })).toBe(false)
    expect(setAgent).toHaveBeenCalledExactlyOnceWith(false)
    expect(setEphy).toHaveBeenCalledExactlyOnceWith(false)
    expect(state).toMatchObject({ agent: false, ephy: false })
  })
})

describe('menu:popup and app:about', () => {
  it('pops the application menu up at the zoom-scaled point, one at a time', () => {
    call('menu:popup', event, { x: 400, y: 40 })
    call('menu:popup', event, { x: 10, y: 10 })
    expect(appMenu.popup).toHaveBeenCalledTimes(1)
    const options = appMenu.popup.mock.calls[0][0] as { window: unknown; x: number; y: number; callback: () => void }
    expect(options).toMatchObject({ window, x: 500, y: 50 })
    options.callback()
    call('menu:popup', event, undefined)
    expect(appMenu.popup).toHaveBeenCalledTimes(2)
    expect(appMenu.popup.mock.calls[1][0]).toMatchObject({ x: 8, y: 8 })
  })

  it('does nothing for another sender or with no menu', () => {
    call('menu:popup', stranger, { x: 1, y: 1 })
    Menu.getApplicationMenu.mockReturnValue(null)
    call('menu:popup', event, { x: 1, y: 1 })
    expect(appMenu.popup).not.toHaveBeenCalled()
    call('app:about', stranger)
    expect(showAbout).not.toHaveBeenCalled()
    call('app:about')
    expect(showAbout).toHaveBeenCalledTimes(1)
  })

  it('menuPopupPoint validates and clamps', () => {
    const content = { width: 800, height: 600 }
    expect(menuPopupPoint({ x: 100, y: 20 }, 1, content)).toEqual({ x: 100, y: 20 })
    expect(menuPopupPoint({ x: 100, y: 20 }, 1.4, content)).toEqual({ x: 140, y: 28 })
    expect(menuPopupPoint({ x: 1e9, y: -50 }, 1, content)).toEqual({ x: 800, y: 0 })
    for (const bad of [null, undefined, 'x', 5, {}, { x: '1', y: 2 }, { x: Number.NaN, y: 1 }, { x: 1, y: Number.POSITIVE_INFINITY }]) {
      expect(menuPopupPoint(bad, 1, content)).toEqual({ x: 8, y: 8 })
    }
    expect(menuPopupPoint({ x: 10, y: 10 }, Number.NaN, content)).toEqual({ x: 10, y: 10 })
  })
})
