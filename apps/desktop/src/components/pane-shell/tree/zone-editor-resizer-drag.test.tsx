import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $layoutTree } from './store'
import { $zoneEditorOpen, ZoneEditor } from './zone-editor'

// Dragging a divider must keep moving THAT divider for the whole gesture, even
// when it passes dividers of other rows/columns (which reorders the grid's
// tracks and therefore the resizer list mid-drag).

let queued: FrameRequestCallback[] = []

function flushFrames() {
  const batch = queued.splice(0, queued.length)

  act(() => {
    for (const cb of batch) {
      cb(0)
    }
  })
}

function mount() {
  $zoneEditorOpen.set(true)

  const view = render(<ZoneEditor />)
  const canvas = view.container.querySelector('.cursor-crosshair') as HTMLDivElement

  canvas.getBoundingClientRect = () =>
    ({ bottom: 1000, height: 1000, left: 0, right: 1000, top: 0, width: 1000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

  return { canvas, view }
}

const num = (v: string) => Math.round(parseFloat(v) * 10)

/** Zones as [left, top, right, bottom] in per-mille, sorted top-to-bottom, left-to-right. */
function zoneBoxes(canvas: HTMLElement) {
  return [...canvas.querySelectorAll<HTMLElement>(':scope > div')]
    .filter(el => /^zone \d+$/.test(el.textContent ?? ''))
    .map(el => {
      const left = num(el.style.left)
      const top = num(el.style.top)

      return [left, top, left + num(el.style.width), top + num(el.style.height)]
    })
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
}

/** Click-split the zone under (x, y); vertical line unless `rowSplit`. */
function split(canvas: HTMLElement, x: number, y: number) {
  fireEvent.pointerMove(canvas, { clientX: x, clientY: y })
  flushFrames()
  fireEvent.pointerDown(canvas, { button: 0, clientX: x, clientY: y })
  fireEvent.pointerUp(window, { button: 0, clientX: x, clientY: y })
}

function verticalResizerAt(canvas: HTMLElement, x: number, y: number) {
  const el = [...canvas.querySelectorAll<HTMLElement>('[data-resizer]')].find(node => {
    if (!node.className.includes('cursor-col-resize')) {
      return false
    }

    const top = num(node.style.top)

    return num(node.style.left) === x && top <= y && y <= top + num(node.style.height)
  })

  if (!el) {
    throw new Error(`no vertical resizer at x=${x}, y=${y}`)
  }

  return el
}

function drag(handle: HTMLElement, fromX: number, toX: number, y: number) {
  fireEvent.pointerDown(handle, { button: 0, clientX: fromX, clientY: y })

  const dir = Math.sign(toX - fromX)

  for (let x = fromX + dir * 10; dir > 0 ? x <= toX : x >= toX; x += dir * 10) {
    fireEvent.pointerMove(window, { clientX: x, clientY: y })
  }

  fireEvent.pointerUp(window, { button: 0, clientX: toX, clientY: y })
}

beforeEach(() => {
  queued = []
  $layoutTree.set(null)
  $zoneEditorOpen.set(false)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queued.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  act(() => {
    $zoneEditorOpen.set(false)
  })
  cleanup()
  vi.unstubAllGlobals()
})

describe('zone editor resizer drag', () => {
  it('keeps dragging the grabbed divider past other rows dividers', () => {
    const { canvas, view } = mount()

    // 3 rows (the reporter's steps), each split into two columns separately.
    fireEvent.change(view.container.querySelector('input[type="number"]')!, { target: { value: '3' } })
    fireEvent.click(view.getByText('Rows'))
    split(canvas, 300, 150)
    split(canvas, 500, 500)
    split(canvas, 700, 850)
    // The middle row gets a third column.
    split(canvas, 650, 500)

    const before = zoneBoxes(canvas)

    // Move the new divider from 65% past the bottom row's 70% divider to 85%.
    drag(verticalResizerAt(canvas, 650, 500), 650, 850, 500)

    const after = zoneBoxes(canvas)
    const row = (boxes: number[][], top: number) => boxes.filter(b => b[1] === top).map(b => [b[0], b[2]])

    // Only the middle row changed, and its new divider followed the pointer.
    expect(row(after, 0)).toEqual(row(before, 0))
    expect(row(after, 667)).toEqual(row(before, 667))
    expect(row(after, 333)).toEqual([
      [0, 500],
      [500, 850],
      [850, 1000]
    ])
  })

  it('removes one added divider by merging the two zones beside it', () => {
    const { canvas, view } = mount()

    fireEvent.change(view.container.querySelector('input[type="number"]')!, { target: { value: '3' } })
    fireEvent.click(view.getByText('Rows'))
    split(canvas, 300, 150)
    split(canvas, 500, 500)
    split(canvas, 700, 850)
    split(canvas, 650, 500)

    const before = zoneBoxes(canvas)

    // Rubber-band from the 50-65% zone into the 65-100% zone, then Merge.
    fireEvent.pointerDown(canvas, { button: 0, clientX: 560, clientY: 450 })
    fireEvent.pointerMove(window, { clientX: 700, clientY: 460 })
    fireEvent.pointerMove(window, { clientX: 800, clientY: 470 })
    fireEvent.pointerUp(window, { button: 0, clientX: 800, clientY: 470 })
    fireEvent.click(view.getByRole('button', { name: 'Merge 2 zones' }))

    const after = zoneBoxes(canvas)
    const row = (boxes: number[][], top: number) => boxes.filter(b => b[1] === top).map(b => [b[0], b[2]])

    expect(row(after, 0)).toEqual(row(before, 0))
    expect(row(after, 667)).toEqual(row(before, 667))
    expect(row(after, 333)).toEqual([
      [0, 500],
      [500, 1000]
    ])
  })

  it('keeps dragging the grabbed divider when the drag reverses direction', () => {
    const { canvas, view } = mount()

    fireEvent.change(view.container.querySelector('input[type="number"]')!, { target: { value: '3' } })
    fireEvent.click(view.getByText('Rows'))
    split(canvas, 300, 150)
    split(canvas, 500, 500)
    split(canvas, 700, 850)
    split(canvas, 650, 500)

    const before = zoneBoxes(canvas)
    const handle = verticalResizerAt(canvas, 650, 500)

    // Past 70% and back, in one gesture.
    fireEvent.pointerDown(handle, { button: 0, clientX: 650, clientY: 500 })

    for (let x = 660; x <= 800; x += 10) {fireEvent.pointerMove(window, { clientX: x, clientY: 500 })}

    for (let x = 790; x >= 600; x -= 10) {fireEvent.pointerMove(window, { clientX: x, clientY: 500 })}
    fireEvent.pointerUp(window, { button: 0, clientX: 600, clientY: 500 })

    const after = zoneBoxes(canvas)
    const row = (boxes: number[][], top: number) => boxes.filter(b => b[1] === top).map(b => [b[0], b[2]])

    expect(row(after, 0)).toEqual(row(before, 0))
    expect(row(after, 667)).toEqual(row(before, 667))
    expect(row(after, 333)).toEqual([
      [0, 500],
      [500, 600],
      [600, 1000]
    ])
  })
})
