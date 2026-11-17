import { cleanup, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $profileRailHidden, profileRailKey } from '@/store/profile-rail-hidden'

import { ProfileRail } from './profile-switcher'

// #91710: a profile that finishes work while another is selected must carry a
// durable unread/attention indicator on its rail square and overflow menu row,
// with the counts in the accessible name. The summary derives from
// the REAL session-unread/session-dot-state stores — only the rail's own shell
// dependencies (routing, profile registry, dialogs) are mocked, so this tests
// the marker → summary → square path end to end.

const navigate = vi.fn()

vi.mock('react-router', () => ({
  useNavigate: () => navigate
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel', delete: 'Delete' },
      profiles: {
        actions: 'Actions',
        allProfiles: 'All profiles',
        color: 'Color…',
        colorFor: 'Color',
        connectGateway: 'Manage gateways…',
        editSoul: 'Edit SOUL.md…',
        exportMenu: 'Export profile…',
        failedLoadSoul: 'Failed to load SOUL.md',
        failedSaveSoul: 'Failed to save SOUL.md',
        importProfile: 'Import profile…',
        manageProfiles: 'Manage profiles…',
        railMenu: 'Profiles menu',
        newProfile: 'New profile',
        renameMenu: 'Rename…',
        remoteOverride: {
          badge: (host: string) => `Runs on ${host}`,
          menuItem: 'Connect to a remote host…'
        },
        saveSoul: 'Save',
        saving: 'Saving…',
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
  $showAllProfiles: atom(false),
  ALL_PROFILES: '*',
  normalizeProfileKey: (name: string) => name,
  prewarmProfilePick: vi.fn(),
  profileLabel: (profile: { display_name?: string; name: string }) =>
    (profile.display_name ?? '').trim() || profile.name,
  refreshActiveProfile: vi.fn().mockResolvedValue(undefined),
  selectProfile: vi.fn(),
  setProfileColor: vi.fn(),
  setProfileOrder: vi.fn(),
  setShowAllProfiles: vi.fn(),
  sortByProfileOrder: (profiles: unknown[]) => profiles
}))

vi.mock('@/store/connections', () => ({
  $activeConnectionId: atom<null | string>(null),
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

const { $profiles, $activeGatewayProfile, $profileScope } = await import('@/store/profile')
const profiles = $profiles as ReturnType<typeof atom<Array<{ is_default: boolean; name: string }>>>
const { $unreadFinishedMarkers } = await import('@/store/session-unread')

afterEach(() => {
  cleanup()
  $profileRailHidden.set([])
  profiles.set([{ is_default: true, name: 'default' }])
  $unreadFinishedMarkers.set({})
})

describe('hidden active profile indicator', () => {
  it('identifies the current profile when its square is hidden', () => {
    profiles.set([
      { is_default: true, name: 'default' },
      { is_default: false, name: 'writer' }
    ])
    ;($activeGatewayProfile as ReturnType<typeof atom<string>>).set('writer')
    ;($profileScope as ReturnType<typeof atom<string>>).set('writer')
    $profileRailHidden.set([profileRailKey(null, 'writer')])
    render(<ProfileRail />)
    const trigger = screen.getByRole('button', { name: 'Profiles menu', description: 'writer' })
    expect(trigger.querySelector('[data-slot="profile-rail-active-indicator"]')).not.toBeNull()
  })
})
