/**
 * Placeholder panes, render side: keeps exactly one `panes` contribution per
 * `placeholder:*` id present in the live layout, so the zones they hold render
 * ("drop a panel here") instead of being skipped as unregistered panes. A
 * placeholder that leaves the layout is unregistered at once, so adoption can
 * never bring it back as a tab.
 */

import { registry } from '@/contrib/registry'
import { useI18n } from '@/i18n'

import { allPaneIds } from './model'
import { isPlaceholderPaneId } from './placeholder-ids'
import { $layoutTree } from './store'

export { isPlaceholderPaneId, newPlaceholderId } from './placeholder-ids'

function PlaceholderPane() {
  const { t } = useI18n()

  return (
    <div
      className="flex h-full min-h-0 items-center justify-center p-4"
      data-slot="placeholder-pane"
    >
      <div className="flex max-w-56 flex-col items-center gap-1 rounded-lg border border-dashed border-(--ui-stroke-secondary) px-4 py-3 text-center">
        <span className="text-xs font-medium text-(--ui-text-secondary)">{t.zones.placeholderTitle}</span>
        <span className="text-[0.6875rem] text-(--ui-text-tertiary)">{t.zones.placeholderHint}</span>
      </div>
    </div>
  )
}

function PlaceholderTitle() {
  const { t } = useI18n()

  return <>{t.zones.placeholderTitle}</>
}

/** Start syncing placeholder contributions with the live layout. Returns the
 *  stop function (which also unregisters every placeholder). */
export function startPlaceholderPaneSync(): () => void {
  const registered = new Map<string, () => void>()

  const sync = () => {
    const tree = $layoutTree.get()
    const live = new Set(tree ? allPaneIds(tree).filter(isPlaceholderPaneId) : [])

    for (const [id, dispose] of registered) {
      if (!live.has(id)) {
        dispose()
        registered.delete(id)
      }
    }

    for (const id of live) {
      if (!registered.has(id)) {
        registered.set(
          id,
          registry.register({
            id,
            area: 'panes',
            title: 'Empty zone',
            // No placement: adoption skips placeholders by id, and a role
            // would let a later editor save claim zones for them.
            data: { tabTitle: () => <PlaceholderTitle /> },
            render: () => <PlaceholderPane />
          })
        )
      }
    }
  }

  sync()
  const unsubscribe = $layoutTree.listen(sync)

  return () => {
    unsubscribe()

    for (const dispose of registered.values()) {
      dispose()
    }

    registered.clear()
  }
}
