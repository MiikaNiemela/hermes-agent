import { describe, expect, it } from 'vitest'

import { dragResizer, initColumns, modelToResizers, modelToZones, MULTIPLIER, splitZone } from './grid-model'
import { gridIsTreeExpressible } from './grid-to-tree'

const HALF = MULTIPLIER / 2

/** Two columns, each split into rows at the SAME height (the collinear case). */
function twoColumnsSplitIntoRows() {
  let model = initColumns(2)
  // Zone 0 = left column -> rows 0 (top) / 1 (bottom).
  model = splitZone(model, 0, HALF, 'horizontal')
  // Right column is now zone 2 -> rows 2 (top) / 3 (bottom).
  model = splitZone(model, 2, HALF, 'horizontal')

  return model
}

const horizontalResizers = (model: ReturnType<typeof initColumns>) =>
  modelToResizers(model).filter(r => r.orientation === 'horizontal')

describe('grid-model resizers at + crossings', () => {
  it('gives each column its own row resizer when row edges line up', () => {
    const model = twoColumnsSplitIntoRows()
    const rows = horizontalResizers(model)

    expect(rows).toHaveLength(2)
    expect(rows.map(r => [r.negativeSideIndices, r.positiveSideIndices])).toEqual([
      [[0], [1]],
      [[2], [3]]
    ])
  })

  it('drags one column row edge without moving the other column', () => {
    const model = twoColumnsSplitIntoRows()

    const index = modelToResizers(model).findIndex(
      r => r.orientation === 'horizontal' && r.negativeSideIndices.includes(0)
    )

    const zones = modelToZones(dragResizer(model, index, -1000))!

    expect(zones.find(z => z.left === 0 && z.top === 0)?.bottom).toBe(HALF - 1000)
    expect(zones.find(z => z.left === HALF && z.top === 0)?.bottom).toBe(HALF)
  })

  it('keeps an edge whole across a T-junction (one zone spans it)', () => {
    // Top zone spans both columns; bottom is split into two columns.
    let model = splitZone(initColumns(1), 0, HALF, 'horizontal')
    model = splitZone(model, 1, HALF, 'vertical')

    const rows = horizontalResizers(model)

    expect(rows).toHaveLength(1)
    expect(rows[0].negativeSideIndices).toEqual([0])
    expect(rows[0].positiveSideIndices.sort()).toEqual([1, 2])
  })

  it('stays saveable as a layout tree after an independent drag', () => {
    const model = twoColumnsSplitIntoRows()

    const index = modelToResizers(model).findIndex(
      r => r.orientation === 'horizontal' && r.negativeSideIndices.includes(2)
    )

    expect(gridIsTreeExpressible(dragResizer(model, index, 1500))).toBe(true)
  })
})
