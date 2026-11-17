import type * as Sortable from '@dnd-kit/sortable'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopAgentRoster, DesktopConnectionsRegistry } from '@/global'
import { $profileRailHidden, $profileRailOrder } from '@/store/profile-rail-hidden'

import { ProfileRail } from './profile-switcher'

// The fleet rail: with several registered gateways, every gateway's agents sit
// on the one strip — the active gateway's squares exactly as before, the rest
// as at-rest groups behind a hairline + kind glyph. Clicking an at-rest square
// performs the same re-home the statusbar switcher does, on that exact
// (gateway, profile). Single-gateway rendering must stay byte-identical.

const sortableSnapshots = vi.hoisted(() => new Map<string, { index: number; items: readonly (string | number)[] }>())

vi.mock('@dnd-kit/sortable', async importOriginal => {
  const actual = await importOriginal<typeof Sortable>()

  return {
    ...actual,
    useSortable: (...args: Parameters<typeof actual.useSortable>) => {
      const result = actual.useSortable(...args)
      sortableSnapshots.set(String(args[0].id), { index: result.index, items: result.items })

      return result
    }
  }
})

const navigate = vi.fn()
const selectConnection = vi.fn()
const selectProfile = vi.fn()
const getAgentRoster = vi.fn()
const openWindow = vi.fn()

vi.mock('react-router', () => ({
  useNavigate: () => navigate
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel', confirm: 'Confirm', delete: 'Delete', done: 'Done', loading: 'Loading' },
      errors: { genericFailure: 'Something went wrong' },
      profiles: {
        actions: 'Actions',
        allProfiles: 'All profiles',
        autoColor: 'Auto',
        color: 'Color…',
        colorFor: 'Color',
        connectGateway: 'Manage gateways…',
        editSoul: 'Edit SOUL.md…',
        openInNewWindow: 'Open in new window',
        setAsDefault: 'Set as default',
        exportProfile: 'Export profile…',
        failedLoadSoul: 'Failed to load SOUL.md',
        failedSaveSoul: 'Failed to save SOUL.md',
        fleet: {
          allOnGateway: 'All profiles on this gateway',
          connectExistingInstead: 'Connect to existing instead',
          deleteOn: (gateway: string) => ` on ${gateway}`,
          gateway: (gateway: string) => `Profiles on ${gateway}`,
          gatewayUnreachable: (gateway: string) => `${gateway} · unreachable`,
          installDeviceConfirm: 'Install locally',
          installDeviceDesc:
            'This will install Hermes locally, then open a fresh session on this computer. Nothing is installed until you confirm.',
          installDeviceTitle: 'Install Hermes on This device?',
          localDevice: 'This device (local backend — installs Hermes if missing, otherwise opens a fresh session)',
          onGateway: (name: string, gateway: string) => `${name} · ${gateway}`,
          switchTo: (name: string, gateway: string) => `Open ${name} on ${gateway}`
        },
        importProfile: 'Import profile…',
        railMenu: 'Profiles menu',
        railConfigure: 'Configure profile buttons…',
        railMoveUp: (name: string) => `Move ${name} up`,
        railMoveDown: (name: string) => `Move ${name} down`,
        manageProfiles: 'Manage profiles…',
        newProfile: 'New profile',
        remoteOverride: {
          badge: (host: string) => `Runs on ${host}`,
          menuItem: 'Connect to a remote host…'
        },
        renameMenu: 'Rename…',
        saveSoul: 'Save',
        saving: 'Saving…',
        setColor: (color: string) => `Set color ${color}`,
        showAllProfiles: 'Show all profiles',
        soulSaved: 'SOUL.md saved',
        status: {
          needsInput: (count: number) => `${count} needs input`,
          unread: (count: number) => `${count} unread`,
          working: (count: number) => `${count} working`
        },
        switchConnectionFailed: (name: string) => `Could not connect to ${name}`,
        switchToProfile: (name: string) => `Switch to ${name}`,
        title: 'Profiles'
      },
      settings: { connections: { kindCloud: 'Cloud', kindLocal: 'This device', kindRemote: 'Remote', kindSsh: 'SSH' } }
    }
  })
}))

const { sortByProfileOrder } = await import('@/lib/profile-order')

vi.mock('@/store/profile', () => ({
  $activeGatewayProfile: atom('default'),
  $profileColors: atom({}),
  $profileCreateRequest: atom(0),
  $profileOrder: atom([]),
  $profiles: atom([{ is_default: true, name: 'default' }]),
  $profileScope: atom('default'),
  // The rail's status summary (profile-dot-state) rides the real session
  // stores, whose import graph reaches $showAllProfiles through layout state.
  $showAllProfiles: atom(false),
  ALL_PROFILES: '*',
  normalizeProfileKey: (name: string) => name,
  prewarmProfilePick: vi.fn(),
  profileLabel: (profile: { display_name?: string; name: string }) =>
    (profile.display_name ?? '').trim() || profile.name,
  refreshActiveProfile: vi.fn().mockResolvedValue(undefined),
  selectProfile: (name: string) => selectProfile(name),
  setProfileColor: vi.fn(),
  setProfileOrder: vi.fn(),
  setShowAllProfiles: vi.fn(),
  sortByProfileOrder: (profiles: Array<{ name: string }>, order: string[]) =>
    sortByProfileOrder(profiles, order, profile => profile.name)
}))

vi.mock('@/store/connections', () => ({
  $activeConnectionId: atom<null | string>(null),
  $connectionsRegistry: atom<DesktopConnectionsRegistry | null>(null),
  $hasMultipleConnections: atom(false),
  selectConnection: (...args: unknown[]) => selectConnection(...args)
}))

vi.mock('@/store/profile-share', () => ({
  runExportProfileFlow: vi.fn(),
  runImportProfileFlow: vi.fn()
}))

vi.mock('./use-profile-prewarm', () => ({
  useProfilePrewarm: () => ({ cancelPrewarm: vi.fn(), notePointerMove: vi.fn(), startPrewarm: vi.fn() })
}))

vi.mock('./use-profile-rail-refresh-on-active', () => ({
  useProfileRailRefreshOnActive: () => undefined
}))

vi.mock('@/components/remote-setup/first-run', () => ({
  FirstRunRemoteSetup: () => 'Connect to existing Hermes'
}))

vi.mock('@/hermes', () => ({
  getProfileSoul: vi.fn().mockResolvedValue({ content: '' }),
  updateProfileSoul: vi.fn()
}))

vi.mock('@/components/chat/code-editor', () => ({ CodeEditor: () => null }))
vi.mock('../../profiles/create-profile-dialog', () => ({ CreateProfileDialog: () => null }))
vi.mock('../../profiles/delete-profile-dialog', () => ({ DeleteProfileDialog: () => null }))
vi.mock('../../profiles/rename-profile-dialog', () => ({ RenameProfileDialog: () => null }))

const connectionsStore = await import('@/store/connections')
const hasMultipleConnections = connectionsStore.$hasMultipleConnections as ReturnType<typeof atom<boolean>>
const activeConnectionId = connectionsStore.$activeConnectionId as ReturnType<typeof atom<null | string>>

const connectionsRegistry = connectionsStore.$connectionsRegistry as ReturnType<
  typeof atom<DesktopConnectionsRegistry | null>
>

const { $activeGatewayProfile, $profileOrder, $profiles, $profileScope } = await import('@/store/profile')
const activeGatewayProfile = $activeGatewayProfile as ReturnType<typeof atom<string>>
const profiles = $profiles as ReturnType<typeof atom<Array<{ is_default: boolean; name: string }>>>
const profileScope = $profileScope as ReturnType<typeof atom<string>>
const { _resetFleetRosterForTests } = await import('@/store/fleet-roster')
const { $unreadFinishedMarkers } = await import('@/store/session-unread')

const registry: DesktopConnectionsRegistry = {
  connections: [
    { id: 'local', kind: 'local', label: 'This device' },
    { id: 'gateway-a', kind: 'remote', label: 'Gateway A', url: 'https://gateway-a.example.com' },
    { id: 'gateway-b', kind: 'ssh', label: 'Gateway B', host: 'gateway-b.example.com' }
  ],
  launchMode: 'primary',
  lastUsed: 'gateway-a',
  primary: 'gateway-a',
  version: 2
} as DesktopConnectionsRegistry

const roster: DesktopAgentRoster = {
  agents: [
    {
      connectionId: 'gateway-a',
      connectionKind: 'remote',
      connectionLabel: 'Gateway A',
      profile: 'default',
      handle: 'hermes-gateway-a'
    },
    {
      connectionId: 'gateway-a',
      connectionKind: 'remote',
      connectionLabel: 'Gateway A',
      profile: 'scout',
      handle: 'scout'
    },
    {
      connectionId: 'local',
      connectionKind: 'local',
      connectionLabel: 'This device',
      profile: 'default',
      handle: 'hermes'
    },
    {
      connectionId: 'local',
      connectionKind: 'local',
      connectionLabel: 'This device',
      profile: 'builder',
      handle: 'builder'
    }
  ],
  sources: [
    { connectionId: 'gateway-a', kind: 'remote', label: 'Gateway A', reachable: true },
    { connectionId: 'local', kind: 'local', label: 'This device', reachable: true },
    { connectionId: 'gateway-b', kind: 'ssh', label: 'Gateway B', reachable: false, error: 'timed out' }
  ]
}

function armFleet() {
  hasMultipleConnections.set(true)
  connectionsRegistry.set(registry)
  activeConnectionId.set('gateway-a')
  profiles.set([
    { is_default: true, name: 'default' },
    { is_default: false, name: 'scout' }
  ])
}

async function renderFleet() {
  const view = render(<ProfileRail />)

  // The roster arrives asynchronously via the Electron bridge.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  return view.container
}

const probeLocalBackend = vi.fn(async () => ({ bootstrapNeeded: false }))

beforeEach(() => {
  getAgentRoster.mockResolvedValue(roster)
  probeLocalBackend.mockResolvedValue({ bootstrapNeeded: false })
  selectConnection.mockResolvedValue(undefined)
  openWindow.mockResolvedValue({ ok: true })
  ;(window as { hermesDesktop?: unknown }).hermesDesktop = { getAgentRoster, openWindow, probeLocalBackend }
})

afterEach(() => {
  sortableSnapshots.clear()
  cleanup()
  $profileRailHidden.set([])
  $profileRailOrder.set([])
  $unreadFinishedMarkers.set({})
  $profileOrder.set([])
  vi.clearAllMocks()
  vi.restoreAllMocks()
  _resetFleetRosterForTests()
  hasMultipleConnections.set(false)
  connectionsRegistry.set(null)
  activeConnectionId.set(null)
  activeGatewayProfile.set('default')
  profileScope.set('default')
  profiles.set([{ is_default: true, name: 'default' }])
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('rail configuration across gateways', () => {
  it('uses the displayed visible rail order for sortable positions', async () => {
    armFleet()
    profiles.set([
      { is_default: true, name: 'default' },
      { is_default: false, name: 'scout' },
      { is_default: false, name: 'alpha' },
      { is_default: false, name: 'hidden' }
    ])
    $profileRailOrder.set(['alpha', 'default', 'hidden', 'scout'].map(name => JSON.stringify(['gateway-a', name])))
    $profileRailHidden.set([JSON.stringify(['gateway-a', 'hidden'])])
    await renderFleet()
    expect(sortableSnapshots.get('alpha')).toEqual({ index: 0, items: ['alpha', 'default', 'scout'] })
    expect(sortableSnapshots.get('default')).toEqual({ index: 1, items: ['alpha', 'default', 'scout'] })
    expect(sortableSnapshots.get('scout')).toEqual({ index: 2, items: ['alpha', 'default', 'scout'] })
  })
  it('retains a hidden resting profile’s unread summary in the overflow menu', async () => {
    armFleet()
    $profileRailHidden.set([JSON.stringify(['local', 'builder'])])
    $unreadFinishedMarkers.set({ builder: ['finished'] })
    await renderFleet()
    expect(screen.queryByRole('button', { name: 'builder · This device, 1 unread' })).toBeNull()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    const item = screen.getByRole('menuitem', { name: 'builder · This device, 1 unread' })
    expect(item.querySelector('[data-slot="profile-status-dot"]')).not.toBeNull()
  })
  it('disambiguates same-named active and resting profiles in configuration', async () => {
    armFleet()
    profiles.set([
      { is_default: true, name: 'default' },
      { is_default: false, name: 'builder' }
    ])
    await renderFleet()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Configure profile buttons…' }))
    expect(screen.getByRole('checkbox', { name: 'builder · Gateway A' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'builder · This device' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Move builder · Gateway A up' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Move builder · This device up' })).toBeTruthy()
  })
  it('can hide the active default while retaining its overflow route', async () => {
    armFleet()
    await renderFleet()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Configure profile buttons…' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'default · Gateway A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('button', { name: 'default' })).toBeNull()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'default' }))
    expect(selectProfile).toHaveBeenCalledWith('default')
  })
  it('reorders a resting gateway independently and retains that order after switching', async () => {
    armFleet()
    const container = await renderFleet()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Configure profile buttons…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move builder · This device up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    const labels = () =>
      Array.from(
        container.querySelectorAll('[data-connection-id="local"][data-slot="profile-rail-gateway"] button')
      ).map(button => button.getAttribute('aria-label'))

    expect(labels()[0]).toBe('builder · This device')
    await act(async () => {
      activeConnectionId.set('local')
      profiles.set([
        { is_default: true, name: 'default' },
        { is_default: false, name: 'builder' }
      ])
    })
    expect(labels()[0]).toBe('builder')
  })
})
