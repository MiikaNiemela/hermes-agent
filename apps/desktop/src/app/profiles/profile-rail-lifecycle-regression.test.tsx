import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, expect, it, vi } from 'vitest'

import { setApiRequestConnection } from '@/api/client'
import { deleteProfile, renameProfile } from '@/hermes'
import { $profileRailHidden, $profileRailOrder, profileRailKey } from '@/store/profile-rail-hidden'

import { DeleteProfileDialog } from './delete-profile-dialog'
import { RenameProfileDialog } from './rename-profile-dialog'

vi.mock('@/hermes', () => ({
  renameProfile: vi.fn(async () => ({ name: 'renamed', ok: true, path: '/x' })),
  deleteProfile: vi.fn(async () => ({ ok: true, path: '/x' }))
}))
vi.mock('@/store/gateway', () => ({ retireLocalProfileGateways: vi.fn() }))
vi.mock('@/store/session-states', () => ({ migrateTilesForProfile: vi.fn(), dropTilesForProfile: vi.fn() }))
vi.mock('@/store/profile', () => ({
  $activeGatewayProfile: atom('default'),
  normalizeProfileKey: (name: string) => name,
  selectProfile: vi.fn(),
  setActiveProfile: vi.fn()
}))

afterEach(() => {
  setApiRequestConnection(null)
  cleanup()
  $profileRailHidden.set([])
  $profileRailOrder.set([])
  vi.clearAllMocks()
})

it('keeps preferences when a rename fails', async () => {
  const old = profileRailKey('gateway-b', 'writer')
  $profileRailHidden.set([old])
  $profileRailOrder.set([old])
  vi.mocked(renameProfile).mockRejectedValueOnce(new Error('rename failed'))
  render(
    <RenameProfileDialog
      currentName="writer"
      onClose={vi.fn()}
      open
      scope={{ connectionId: 'gateway-b', profile: 'writer' }}
    />
  )
  fireEvent.change(screen.getByLabelText(/new name/i), { target: { value: 'renamed' } })
  fireEvent.click(screen.getByRole('button', { name: /^rename$/i }))
  await screen.findByText('rename failed')
  expect($profileRailHidden.get()).toEqual([old])
  expect($profileRailOrder.get()).toEqual([old])
})

it('keeps preferences when a delete fails', async () => {
  const old = profileRailKey('gateway-b', 'writer')
  $profileRailHidden.set([old])
  $profileRailOrder.set([old])
  vi.mocked(deleteProfile).mockRejectedValueOnce(new Error('delete failed'))
  render(
    <DeleteProfileDialog
      onClose={vi.fn()}
      open
      profile={{ name: 'writer', path: '/x' }}
      scope={{ connectionId: 'gateway-b', profile: 'writer' }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
  await screen.findByText('delete failed')
  expect($profileRailHidden.get()).toEqual([old])
  expect($profileRailOrder.get()).toEqual([old])
})

it('moves hidden and ordered preferences on a successful scoped rename without touching other gateways', async () => {
  const old = profileRailKey('gateway-b', 'writer')
  const renamed = profileRailKey('gateway-b', 'renamed')
  const other = profileRailKey('gateway-a', 'writer')
  $profileRailHidden.set([old, other])
  $profileRailOrder.set([other, old])
  render(
    <RenameProfileDialog
      currentName="writer"
      onClose={vi.fn()}
      open
      scope={{ connectionId: 'gateway-b', profile: 'writer' }}
    />
  )
  fireEvent.change(screen.getByLabelText(/new name/i), { target: { value: 'renamed' } })
  fireEvent.click(screen.getByRole('button', { name: /^rename$/i }))
  await waitFor(() => expect($profileRailHidden.get()).toEqual([renamed, other]))
  expect($profileRailOrder.get()).toEqual([other, renamed])
})

it('removes hidden and ordered preferences on successful unscoped deletion for the active gateway only', async () => {
  setApiRequestConnection('gateway-a')
  const old = profileRailKey('gateway-a', 'writer')
  const other = profileRailKey('gateway-b', 'writer')
  $profileRailHidden.set([old, other])
  $profileRailOrder.set([other, old])
  render(<DeleteProfileDialog onClose={vi.fn()} open profile={{ name: 'writer', path: '/x' }} />)
  fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
  await waitFor(() => expect($profileRailHidden.get()).toEqual([other]))
  expect($profileRailOrder.get()).toEqual([other])
})
