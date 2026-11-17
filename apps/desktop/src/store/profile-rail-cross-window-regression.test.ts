import { beforeEach, expect, it } from 'vitest'

import { $profileRailHidden, $profileRailOrder } from './profile-rail-hidden'

beforeEach(() => {
  $profileRailHidden.set([])
  $profileRailOrder.set([])
})

it('adopts hidden and order preferences written by another window', () => {
  const hiddenKey = 'hermes.desktop.profileRailHidden.v1'
  const orderKey = 'hermes.desktop.profileRailOrder.v1'
  const hidden = ['["gateway-a","writer"]']
  const order = ['["gateway-b","default"]', '["gateway-b","writer"]']
  localStorage.setItem(hiddenKey, JSON.stringify(hidden))
  localStorage.setItem(orderKey, JSON.stringify(order))
  window.dispatchEvent(new StorageEvent('storage', { key: hiddenKey }))
  window.dispatchEvent(new StorageEvent('storage', { key: orderKey }))
  expect($profileRailHidden.get()).toEqual(hidden)
  expect($profileRailOrder.get()).toEqual(order)
})

it('adopts removal and does not replay an old event over a newer edit', () => {
  const key = 'hermes.desktop.profileRailHidden.v1'
  $profileRailHidden.set(['old'])
  window.localStorage.removeItem(key)
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: null }))
  expect($profileRailHidden.get()).toEqual([])
  $profileRailHidden.set(['newer'])
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(['old']) }))
  expect($profileRailHidden.get()).toEqual(['newer'])
})
