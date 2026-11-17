import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $profileRailHidden, $profileRailOrder } from '@/store/profile-rail-hidden'

import { ProfileRail } from './profile-switcher'

// The rail's discoverability pills are navigation, not identity — assert the
// multi-gateway entry point deep-links to Settings → Connections instead of
// relying on someone finding the pane three levels into Settings (the exact
// gap reported against the multi-connection registry launch).

const navigate = vi.fn()

vi.mock('react-router', () => ({
  useNavigate: () => navigate
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel', done: 'Done' },
      profiles: {
        allProfiles: 'All profiles',
        connectGateway: 'Manage gateways…',
        failedLoadSoul: 'Failed to load SOUL.md',
        failedSaveSoul: 'Failed to save SOUL.md',
        importProfile: 'Import profile…',
        manageProfiles: 'Manage profiles…',
        railMenu: 'Profiles menu',
        railConfigure: 'Configure profile buttons…',
        railMoveUp: (name: string) => `Move ${name} up`,
        railMoveDown: (name: string) => `Move ${name} down`,
        newProfile: 'New profile',
        remoteOverride: {
          badge: (host: string) => `Runs on ${host}`,
          menuItem: 'Connect to a remote host…'
        },
        saveSoul: 'Save',
        saving: 'Saving…',
        showAllProfiles: 'Show all profiles',
        soulSaved: 'SOUL.md saved',
        switchToProfile: (name: string) => `Switch to ${name}`,
        title: 'Profiles'
      }
    }
  })
}))

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
  selectProfile: vi.fn(),
  setProfileColor: vi.fn(),
  setProfileOrder: (names: string[]) => profileOrder.set(names),
  setShowAllProfiles: vi.fn(),
  sortByProfileOrder: (items: Array<{ name: string }>, order: string[]) =>
    [...items].sort(
      (a, b) =>
        (order.indexOf(a.name) < 0 ? 999 : order.indexOf(a.name)) -
        (order.indexOf(b.name) < 0 ? 999 : order.indexOf(b.name))
    )
}))

vi.mock('@/store/connections', () => ({
  $activeConnectionId: atom(null),
  $connectionsRegistry: atom(null),
  $hasMultipleConnections: atom(false),
  selectConnection: vi.fn()
}))

vi.mock('@/store/profile-share', () => ({
  runExportProfileFlow: vi.fn(),
  runImportProfileFlow: vi.fn()
}))

vi.mock('./use-profile-prewarm', () => ({
  useProfilePrewarm: () => ({ cancelPrewarm: vi.fn(), notePointerMove: vi.fn(), startPrewarm: vi.fn() })
}))

vi.mock('@/hermes', () => ({
  getProfileSoul: vi.fn().mockResolvedValue({ content: '' }),
  updateProfileSoul: vi.fn()
}))

vi.mock('@/components/chat/code-editor', () => ({ CodeEditor: () => null }))
vi.mock('../../profiles/create-profile-dialog', () => ({ CreateProfileDialog: () => null }))
vi.mock('../../profiles/delete-profile-dialog', () => ({ DeleteProfileDialog: () => null }))
vi.mock('../../profiles/rename-profile-dialog', () => ({ RenameProfileDialog: () => null }))

const { $hasMultipleConnections } = await import('@/store/connections')
const hasMultipleConnections = $hasMultipleConnections as ReturnType<typeof atom<boolean>>
const { $profiles, $profileOrder } = await import('@/store/profile')
const profileOrder = $profileOrder as ReturnType<typeof atom<string[]>>
const profiles = $profiles as ReturnType<typeof atom<Array<{ is_default: boolean; name: string }>>>

afterEach(() => {
  cleanup()
  $profileRailHidden.set([])
  $profileRailOrder.set([])
  profileOrder.set([])
  hasMultipleConnections.set(false)
  profiles.set([{ is_default: true, name: 'default' }])
})

describe('ProfileRail overflow', () => {
  it('keeps selected buttons on the scrollable rail with many profiles', () => {
    profiles.set([
      { is_default: true, name: 'default' },
      ...Array.from({ length: 16 }, (_, i) => ({ is_default: false, name: `agent${i}` }))
    ])
    render(<ProfileRail />)
    expect(screen.getByRole('button', { name: 'agent15' })).toBeTruthy()
  })

  it('allows keyboard-friendly reordering in the configuration dialog', () => {
    profiles.set([
      { is_default: true, name: 'default' },
      { is_default: false, name: 'scout' },
      { is_default: false, name: 'writer' }
    ])
    render(<ProfileRail />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Configure profile buttons…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move writer up' }))
    expect(screen.getAllByRole('checkbox').map(item => item.parentElement?.textContent?.trim())).toEqual([
      'default',
      'writer',
      'scout'
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    const railButtons = screen.getByRole('button', { name: 'writer' }).parentElement!
    expect(Array.from(railButtons.querySelectorAll('button')).map(button => button.getAttribute('aria-label'))).toEqual([
      'Show all profiles',
      'writer',
      'scout'
    ])
  })

  it('lets a user hide a profile and still switch to it from the menu after remount', () => {
    profiles.set([
      { is_default: true, name: 'default' },
      { is_default: false, name: 'scout' }
    ])
    const view = render(<ProfileRail />)
    expect(screen.getByRole('button', { name: 'scout' })).toBeTruthy()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Configure profile buttons…' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'scout' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('button', { name: 'scout' })).toBeNull()
    view.unmount()
    render(<ProfileRail />)
    expect(screen.queryByRole('button', { name: 'scout' })).toBeNull()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    expect(screen.getByRole('menuitemradio', { name: 'scout' })).toBeTruthy()
  })

  it('keeps management actions in an accessible overflow menu', () => {
    render(<ProfileRail />)
    expect(screen.queryByRole('button', { name: 'Manage gateways…' })).toBeNull()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    expect(screen.getByRole('menuitem', { name: 'Manage gateways…' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Manage profiles…' })).toBeTruthy()
  })
})

describe('ProfileRail multi-gateway entry point', () => {
  it('deep-links to the unified Settings → Gateways page from the rail', () => {
    render(<ProfileRail />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage gateways…' }))

    expect(navigate).toHaveBeenCalledWith('/settings?tab=gateway')
  })

  it('keeps the entry point visible for single-profile users', () => {
    render(<ProfileRail />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    expect(screen.getByRole('menuitem', { name: 'Manage gateways…' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Manage profiles…' })).toBeTruthy()
  })

  it('keeps the active profile explicit when gateway identity moves to the statusbar', () => {
    hasMultipleConnections.set(true)
    render(<ProfileRail />)

    expect(screen.getByRole('button', { name: 'default' })).toBeTruthy()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Profiles menu' }), { button: 0, ctrlKey: false })
    expect(screen.getByRole('menuitem', { name: 'Manage profiles…' })).toBeTruthy()
  })
})
