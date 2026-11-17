import { describe, expect, it } from 'vitest'

import {
  clampDragDelta,
  collapseResizer,
  collapseTarget,
  dragResizer,
  initColumns,
  MIN_ZONE_SIZE,
  modelToResizers,
  modelToZones,
  MULTIPLIER,
  splitZone
} from './grid-model'
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

describe('grid-model divider collapse (drag a divider onto its neighbour)', () => {
  // Columns 0 | 1 | 2 with dividers at 3333 and 6667.
  const threeColumns = () => initColumns(3)

  const verticalIndex = (model: ReturnType<typeof initColumns>, leftZone: number) =>
    modelToResizers(model).findIndex(r => r.orientation === 'vertical' && r.negativeSideIndices.includes(leftZone))

  const spans = (model: ReturnType<typeof initColumns>) =>
    modelToZones(model)!
      .map(z => [z.left, z.right])
      .sort((a, b) => a[0] - b[0])

  const widths = (model: ReturnType<typeof initColumns>) => spans(model).map(([l, r]) => r - l)

  it('clamps a too-long drag to the minimum zone size instead of refusing it', () => {
    const model = threeColumns()
    const index = verticalIndex(model, 0)
    const [w0, w1] = widths(model)

    // The squeezed zone may shrink to MIN_ZONE_SIZE, no further.
    expect(clampDragDelta(model, index, 5000)).toBe(w1 - MIN_ZONE_SIZE)
    expect(clampDragDelta(model, index, 1000)).toBe(1000)
    expect(clampDragDelta(model, index, -5000)).toBe(-(w0 - MIN_ZONE_SIZE))
  })

  it('targets the squeezed zone once the pointer reaches the neighbouring divider', () => {
    const model = threeColumns()
    const index = verticalIndex(model, 0)
    const [w0, w1] = widths(model)

    expect(collapseTarget(model, index, w1)).toBe('positive')
    expect(collapseTarget(model, index, w1 - 200)).toBe('positive')
    expect(collapseTarget(model, index, w1 - 1000)).toBeNull()
    expect(collapseTarget(model, index, -w0)).toBe('negative')
  })

  it('merges the squeezed zone into the zone the divider came from', () => {
    const model = threeColumns()
    const second = spans(model)[1][1]

    expect(spans(collapseResizer(model, verticalIndex(model, 0), 'positive'))).toEqual([
      [0, second],
      [second, MULTIPLIER]
    ])
    // Dragging the same divider left onto the canvas edge folds zone 0 into zone 1.
    expect(spans(collapseResizer(model, verticalIndex(model, 0), 'negative'))).toEqual([
      [0, second],
      [second, MULTIPLIER]
    ])
  })

  it('collapses a stacked side whole: both rows of a split column fold into the zone beside them', () => {
    // Left column | right column split into two rows.
    let model = initColumns(2)
    model = splitZone(model, 1, HALF, 'horizontal')
    const index = verticalIndex(model, 0)

    expect(collapseTarget(model, index, HALF)).toBe('positive')
    expect(modelToZones(collapseResizer(model, index, 'positive'))).toEqual([
      { index: 0, left: 0, top: 0, right: MULTIPLIER, bottom: MULTIPLIER }
    ])
  })
})
