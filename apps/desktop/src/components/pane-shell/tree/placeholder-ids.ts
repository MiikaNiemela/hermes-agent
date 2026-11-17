/**
 * Placeholder pane ids — stand-ins for zones that a layout draws but no real
 * pane fills yet. Without them `normalize()` prunes every empty zone the moment
 * a layout is applied, so a grid drawn with more zones than there are panes
 * collapsed back to "sidebar | chat" (a 4-column grid with a row divider per
 * column came out as 3 rescaled columns, or fewer).
 *
 * Each placeholder is its own pane id: a pane id may live in exactly one group,
 * so one shared id could not hold several zones open. Pure on purpose — the
 * store imports this; the registration/render side lives in
 * `placeholder-panes.tsx`.
 */

import { type LayoutNode, nodeId } from './model'

export const PLACEHOLDER_PREFIX = 'placeholder:'

export const isPlaceholderPaneId = (paneId: string): boolean => paneId.startsWith(PLACEHOLDER_PREFIX)

export const newPlaceholderId = (): string => `${PLACEHOLDER_PREFIX}${nodeId('z')}`

/**
 * A placeholder only holds an otherwise-empty zone open: once a real pane
 * shares its group (dropped in, adopted, docked), it has done its job. Returns
 * the same tree when nothing changes.
 */
export function dropFilledPlaceholders(tree: LayoutNode): LayoutNode {
  if (tree.type === 'group') {
    const real = tree.panes.filter(id => !isPlaceholderPaneId(id))

    if (real.length === 0 || real.length === tree.panes.length) {
      return tree
    }

    return { ...tree, panes: real, active: real.includes(tree.active) ? tree.active : real[0] }
  }

  const children = tree.children.map(dropFilledPlaceholders)

  return children.every((child, i) => child === tree.children[i]) ? tree : { ...tree, children }
}
