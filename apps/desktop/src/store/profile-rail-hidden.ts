import { Codecs, persistentAtom } from '@/lib/persisted'
import { arraysEqual } from '@/lib/storage'

// Window-independent presentation preference, keyed by gateway and canonical profile.
const STORAGE_KEY = 'hermes.desktop.profileRailHidden.v1'
export const $profileRailHidden = persistentAtom<string[]>(STORAGE_KEY, [], Codecs.stringArray)

const ORDER_KEY = 'hermes.desktop.profileRailOrder.v1'
export const $profileRailOrder = persistentAtom<string[]>(ORDER_KEY, [], Codecs.stringArray)

export function sortRailProfiles<T>(
  items: T[],
  connectionId: null | string,
  name: (item: T) => string,
  order: string[]
): T[] {
  const positions = new Map(order.map((key, index) => [key, index]))

  return [...items].sort(
    (a, b) =>
      (positions.get(profileRailKey(connectionId, name(a))) ?? Number.MAX_SAFE_INTEGER) -
      (positions.get(profileRailKey(connectionId, name(b))) ?? Number.MAX_SAFE_INTEGER)
  )
}

export function setRailProfilesOrder(connectionId: null | string, profiles: string[]) {
  const keys = profiles.map(profile => profileRailKey(connectionId, profile))
  const selected = new Set(keys)
  $profileRailOrder.set([...$profileRailOrder.get().filter(key => !selected.has(key)), ...keys])
}

export function setProfileRailHidden(key: string, hidden: boolean) {
  const current = $profileRailHidden.get()
  const next = hidden ? [...new Set([...current, key])] : current.filter(item => item !== key)

  if (!arraysEqual(current, next)) {
    $profileRailHidden.set(next)
  }
}

export function updateProfileRailIdentity(connectionId: null | string, oldName: string, newName?: string) {
  const oldKey = profileRailKey(connectionId, oldName)
  const newKey = newName === undefined ? null : profileRailKey(connectionId, newName)

  for (const store of [$profileRailHidden, $profileRailOrder]) {
    const current = store.get()
    const next = current.flatMap(key => (key === oldKey ? (newKey === null ? [] : [newKey]) : [key]))
    const unique = [...new Set(next)]

    if (!arraysEqual(current, unique)) {
      store.set(unique)
    }
  }
}

export function profileRailKey(connectionId: null | string, profile: string): string {
  return JSON.stringify([connectionId ?? 'local', profile])
}
