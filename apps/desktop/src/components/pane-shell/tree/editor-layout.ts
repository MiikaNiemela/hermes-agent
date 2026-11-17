/**
 * The zone editor's grid → live layout conversion, shared by the editor's
 * Save & apply and the tests that pin its behaviour.
 */

import { registry } from '@/contrib/registry'

import type { GridLayout } from './grid-model'
import { gridToTree, type PanePlacementHint } from './grid-to-tree'
import { allPaneIds, type LayoutNode } from './model'
import { isPlaceholderPaneId } from './placeholder-ids'
import { $dismissedPanes, $hiddenTreePanes, $layoutTree } from './store'

/**
 * Convert an editor grid into the tree that Save & apply commits.
 *
 * Only OPEN panes claim zones. A closed (hidden/dismissed) pane given a zone
 * rendered as a blank or collapsed area, so the layout never looked as drawn;
 * closed panes are re-adopted beside their old neighbours by `applyTree`
 * instead, and the zones they would have taken show placeholders.
 */
export function layoutTreeFromGrid(model: GridLayout): LayoutNode | null {
  const hidden = $hiddenTreePanes.get()
  const dismissed = $dismissedPanes.get()

  const paneIds = allPaneIds($layoutTree.get() ?? { type: 'group', id: 'tmp', panes: [], active: '' }).filter(
    id => !isPlaceholderPaneId(id) && !hidden.has(id) && !dismissed.has(id)
  )

  const contributions = registry.getArea('panes')

  const placed = paneIds.map(id => ({
    id,
    placement: (contributions.find(c => c.id === id)?.data as { placement?: PanePlacementHint } | undefined)
      ?.placement
  }))

  return gridToTree(model, placed)
}
