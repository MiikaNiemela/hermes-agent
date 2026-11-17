import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { $paneStates } from '@/store/panes'

import type { LayoutNode, SplitNode } from '../model'
import { group, split } from '../model'

import { TreeSplit } from './tree-split'

// Splits drawn in the zone editor are AUTHORED PROPORTIONS: their children
// share the space by the drawn weights even when a pane declares a fixed
// width (sidebars, a plugin's `width: '320px'`). Reported: "None of the
// column sizes are respected" — a 4 × 25 % grid rendered 237 / 260 / 320 /
// 591 px. Splits made by dragging panes keep the sidebar track model.

vi.mock('@/components/pane-shell/geometry', () => ({ beginSashDrag: vi.fn(), endSashDrag: vi.fn() }))

vi.mock('./tree-node', () => ({
  TreeNode: ({ node }: { node: LayoutNode }) => (node.type === 'group' ? <div data-tree-group={node.id} /> : null)
}))

const SIDEBAR = { placement: 'left', width: '240px', minWidth: '10rem', maxWidth: '20rem' }

let disposers: (() => void)[] = []

beforeEach(() => {
  window.localStorage.clear()
  disposers = [
    registry.register({ id: 'sidebar', area: 'panes', data: SIDEBAR, render: () => null, title: 'sidebar' }),
    registry.register({
      id: 'workspace',
      area: 'panes',
      data: { placement: 'main', uncloseable: true },
      render: () => null,
      title: 'workspace'
    })
  ]
})

afterEach(() => {
  cleanup()
  disposers.forEach(dispose => dispose())
  $paneStates.set({})
})

function wrapperStyle(groupId: string) {
  const zone = window.document.querySelector<HTMLElement>(`[data-tree-group="${groupId}"]`)!

  return zone.parentElement!.style
}

function node(proportional: boolean): SplitNode {
  const n = split('row', [group(['sidebar'], { id: 'g-side' }), group(['workspace'], { id: 'g-main' })], [1, 3], 's-root')

  return proportional ? { ...n, proportional: true } : n
}

describe('authored (proportional) splits', () => {
  it('keeps the sidebar a fixed track in an ordinary split', () => {
    render(<TreeSplit node={node(false)} root rootRow />)

    expect(wrapperStyle('g-side').flex).toBe('0 1 240px')
    expect(wrapperStyle('g-side').maxWidth).toBe('20rem')
  })

  it('sizes every child by its drawn weight in a proportional split', () => {
    render(<TreeSplit node={node(true)} root rootRow />)

    expect(wrapperStyle('g-side').flex).toBe('0.25 0.25 0px')
    expect(wrapperStyle('g-main').flex).toBe('0.75 0.75 0px')
  })

  it('keeps the minimum width but drops the cap in a proportional split', () => {
    render(<TreeSplit node={node(true)} root rootRow />)

    expect(wrapperStyle('g-side').minWidth).toBe('10rem')
    expect(wrapperStyle('g-side').maxWidth).toBe('')
  })
})
