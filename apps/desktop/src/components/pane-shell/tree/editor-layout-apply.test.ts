import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LayoutNode } from './model'

// A0: a grid drawn in the zone editor as 4 columns, each split by its OWN row
// divider, must survive Save & apply, a reload, and re-picking it from the
// Layouts picker — column weights and per-column rows included. Reported:
// "None of the column sizes are respected, neither are the row divisions. The
// layout shown instead of this layout is always the same template."

type Shape = string[] | { [orientation: string]: Shape[] | number[] }

/** Structure + rounded weights, ignoring generated node and placeholder ids
 *  (and any `ignore`d panes, e.g. closed ones riding along off-grid). */
function shape(node: LayoutNode | null, ignore: ReadonlySet<string> = new Set()): Shape | null {
  if (!node) {
    return null
  }

  if (node.type === 'group') {
    return node.panes.filter(id => !ignore.has(id)).map(id => (id.startsWith('placeholder:') ? 'placeholder' : id))
  }

  const total = node.weights.reduce((a, b) => a + b, 0) || 1

  return {
    [node.orientation]: node.children.map(child => shape(child, ignore)!),
    w: node.weights.map(w => Math.round((w / total) * 100)),
    ...('proportional' in node && node.proportional ? { p: [1] } : {})
  }
}

const PANES = [
  ['sessions', { placement: 'left' }],
  ['workspace', { placement: 'main', uncloseable: true }],
  ['review', { placement: 'right' }],
  ['files', { placement: 'right' }],
  ['terminal', { placement: 'bottom' }]
] as const

async function boot() {
  const { registry } = await import('@/contrib/registry')
  const store = await import('./store')
  const model = await import('./model')
  const presets = await import('./presets')
  const grid = await import('./grid-model')
  const g2t = await import('./grid-to-tree')
  const placeholders = await import('./placeholder-panes')
  const editorLayout = await import('./editor-layout')

  const disposers = PANES.map(([id, data]) =>
    registry.register({ area: 'panes', data, id, render: () => null, title: id })
  )

  disposers.push(placeholders.startPlaceholderPaneSync())

  // The app's default arrangement (sidebar | chat, tools on the right).
  store.declareDefaultTree(
    model.split('row', [
      model.group(['sessions']),
      model.group(['workspace']),
      model.split('column', [model.group(['review', 'files']), model.group(['terminal'])])
    ])
  )

  return { disposers, editorLayout, g2t, grid, model, placeholders, presets, registry, store }
}

type Booted = Awaited<ReturnType<typeof boot>>

/** The editor's Save & apply, verbatim from `ZoneEditor.save()`. */
function saveAndApply({ editorLayout, grid, presets }: Booted, name: string) {
  let m = grid.initColumns(4)

  // Each column gets its own row divider at a different height.
  for (const [left, y] of [
    [0, 3000],
    [2500, 6000],
    [5000, 4000],
    [7500, 7000]
  ] as const) {
    const zone = grid.modelToZones(m)!.find(z => z.left === left && z.top === 0)!
    m = grid.splitZone(m, zone.index, y, 'horizontal')
  }

  const tree = editorLayout.layoutTreeFromGrid(m)!
  const id = presets.saveLayoutPresetTree(name, tree)!

  presets.applyLayoutPreset(id, tree)

  return { id, drawn: shape(tree) }
}

let booted: Booted | null = null

beforeEach(() => {
  window.localStorage.clear()
  vi.resetModules()
})

afterEach(() => {
  booted?.disposers.forEach(dispose => dispose())
  booted = null
})

describe('A0: nested editor layouts survive apply', () => {
  it('applies a grid of columns that each have their own row divider as drawn', async () => {
    booted = await boot()
    const { drawn } = saveAndApply(booted, 'Four split')

    // The drawn grid converts to 4 columns, 25 % each, every column keeping
    // its own row split; zones no pane landed in hold a placeholder.
    expect(drawn).toMatchObject({ w: [25, 25, 25, 25] })
    expect((drawn as { row: Shape[] }).row.every(column => 'column' in (column as object))).toBe(true)
    expect(JSON.stringify(drawn)).toContain('placeholder')
    expect(shape(booted.store.$layoutTree.get())).toEqual(drawn)
  })

  it('marks every editor-drawn split as authored proportions', async () => {
    booted = await boot()
    const { drawn } = saveAndApply(booted, 'Four split')

    expect(drawn).toMatchObject({ p: [1] })
    expect((drawn as { row: Shape[] }).row.every(column => 'p' in (column as object))).toBe(true)
  })

  it('registers a placeholder pane for every empty zone, so the zone renders', async () => {
    booted = await boot()
    saveAndApply(booted, 'Four split')
    const { model, registry, store } = booted

    const ids = model.allPaneIds(store.$layoutTree.get()!).filter(id => id.startsWith('placeholder:'))

    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)

    for (const id of ids) {
      expect(registry.getArea('panes').some(c => c.id === id)).toBe(true)
    }
  })

  it('keeps the applied layout through a reload', async () => {
    booted = await boot()
    const { drawn } = saveAndApply(booted, 'Four split')

    booted.disposers.forEach(dispose => dispose())
    vi.resetModules()
    booted = await boot()

    expect(shape(booted.store.$layoutTree.get())).toEqual(drawn)
  })

  it('re-applies the saved layout when picked again after another layout', async () => {
    booted = await boot()
    const { id, drawn } = saveAndApply(booted, 'Four split')
    const { model, presets, registry, store } = booted

    presets.applyLayoutPreset('other', model.split('row', [model.group(['sessions']), model.group(['workspace'])]))
    expect(shape(store.$layoutTree.get())).not.toEqual(drawn)

    // The picker applies the registered contribution's data.
    const saved = registry.getArea('layouts').find(c => c.id === id)!
    presets.applyLayoutPreset(id, saved.data as LayoutNode)

    expect(shape(store.$layoutTree.get())).toEqual(drawn)
  })

  it('applies as drawn when the tool panes are closed (as on a fresh install)', async () => {
    booted = await boot()
    const { store } = booted

    for (const pane of ['review', 'files', 'terminal']) {
      const $open = atom(false)

      store.bindPaneVisibility(
        pane,
        $open,
        () => $open.set(false),
        () => $open.set(true)
      )
    }

    const { drawn } = saveAndApply(booted, 'Four split closed')
    const closed = new Set(['review', 'files', 'terminal'])

    // The drawn grid is applied exactly; the closed panes ride along off-grid
    // (re-adopted as hidden tabs) so they can be reopened.
    expect(shape(store.$layoutTree.get(), closed)).toEqual(drawn)
    expect(JSON.stringify(drawn)).not.toMatch(/"(review|files|terminal)"/)
  })

  it('assigns zones only to open panes; closed ones stay in the layout off-grid', async () => {
    booted = await boot()
    const { model, store } = booted

    for (const pane of ['review', 'files']) {
      const $open = atom(false)

      store.bindPaneVisibility(
        pane,
        $open,
        () => $open.set(false),
        () => $open.set(true)
      )
      store.setTreePaneHidden(pane, true)
    }

    const { drawn } = saveAndApply(booted, 'Four split, two closed')
    const ids = (drawn as { row: Shape[] }).row.flatMap(column => JSON.stringify(column))

    // Closed panes got no zone of their own…
    expect(ids.join()).not.toContain('"review"')
    expect(ids.join()).not.toContain('"files"')
    // …but they are still in the applied layout, so they can be reopened.
    expect(model.allPaneIds(store.$layoutTree.get()!)).toEqual(expect.arrayContaining(['review', 'files']))
  })
})

describe('placeholder panes', () => {
  it('drops a placeholder when a real pane joins its zone', async () => {
    booted = await boot()
    saveAndApply(booted, 'Four split')
    const { model, store } = booted

    const tree = store.$layoutTree.get()!
    const placeholder = model.allPaneIds(tree).find(id => id.startsWith('placeholder:'))!
    const target = model.findGroupOfPane(tree, placeholder)!

    store.moveTreePane('terminal', { groupId: target.id, pos: 'center' })

    const after = store.$layoutTree.get()!

    expect(model.allPaneIds(after)).not.toContain(placeholder)
    expect(model.findGroupOfPane(after, 'terminal')?.panes).toEqual(['terminal'])
  })

  it('unregisters a placeholder that left the layout and never re-adopts it', async () => {
    booted = await boot()
    saveAndApply(booted, 'Four split')
    const { model, registry, store } = booted

    const tree = store.$layoutTree.get()!
    const placeholder = model.allPaneIds(tree).find(id => id.startsWith('placeholder:'))!
    const target = model.findGroupOfPane(tree, placeholder)!

    store.moveTreePane('terminal', { groupId: target.id, pos: 'center' })
    store.adoptContributedPanes()

    expect(registry.getArea('panes').some(c => c.id === placeholder)).toBe(false)
    expect(model.allPaneIds(store.$layoutTree.get()!)).not.toContain(placeholder)
  })

  it('does not carry the old layout\'s placeholders into a newly applied layout', async () => {
    booted = await boot()
    saveAndApply(booted, 'Four split')
    const { model, presets, store } = booted

    presets.applyLayoutPreset('plain', model.split('row', [model.group(['sessions']), model.group(['workspace'])]))

    expect(model.allPaneIds(store.$layoutTree.get()!).some(id => id.startsWith('placeholder:'))).toBe(false)
  })

  it('closing a placeholder removes its zone without leaving a dismissal record', async () => {
    booted = await boot()
    saveAndApply(booted, 'Four split')
    const { model, store } = booted

    const before = store.$layoutTree.get()!
    const placeholder = model.allPaneIds(before).find(id => id.startsWith('placeholder:'))!
    const zones = (tree: LayoutNode) => JSON.stringify(tree).match(/"type":"group"/g)!.length

    store.closeTreePane(placeholder)

    const after = store.$layoutTree.get()!

    expect(model.allPaneIds(after)).not.toContain(placeholder)
    expect(zones(after)).toBe(zones(before) - 1)
    expect(store.$dismissedPanes.get().has(placeholder)).toBe(false)
  })
})
