import { describe, it, expect } from 'vitest'
import { buildPlan, type FileEntry, type FixConfig } from '../src/lib/analyzer'
import { CHURCH_FONT } from '../src/lib/fonts'
import type { FontDescriptor, ProDoc, TextBox } from '../src/lib/proDoc'

// Lightweight fakes: buildPlan only *reads* the model (descriptors/geometry) and
// never mutates or serializes, so a plain object shaped like a content box is
// enough to exercise the planner without constructing real protobuf.
function box(descriptors: FontDescriptor[]): TextBox {
  return {
    role: 'content',
    name: '',
    boundsSig: '0,0,10,10',
    boundsY: 0,
    boundsW: 10,
    boundsH: 10,
    boundsNode: null,
    descriptors,
    textNodes: [],
    fontNodes: [],
    rtfNode: null,
  }
}
function file(name: string, ...boxes: TextBox[]): FileEntry {
  return { name, doc: { name, boxes } as unknown as ProDoc }
}
const brand = (): FontDescriptor => ({
  ps: 'Tensentype-RuiHeiJ-W4',
  sizePt: 100,
  family: 'Tensentype RuiHeiJ', // an inconsistent display family, as in real files
  style: '',
})

const config: FixConfig = {
  sourcePsNames: ['Tensentype-RuiHeiJ-W4'],
  remapFont: true,
  targetFont: CHURCH_FONT,
  fixFamilyMeta: true,
  sizePolicy: 'keep',
  globalSize: 165,
}

describe('buildPlan — selectedFiles scoping', () => {
  const files = [file('a.pro', box([brand()])), file('b.pro', box([brand()])), file('c.pro', box([brand()]))]

  it('undefined selection processes every document', () => {
    const plan = buildPlan(files, { ...config, selectedFiles: undefined })
    expect(new Set(plan.map((e) => e.file))).toEqual(new Set(['a.pro', 'b.pro', 'c.pro']))
  })

  it('empty selection processes nothing', () => {
    expect(buildPlan(files, { ...config, selectedFiles: [] })).toEqual([])
  })

  it('scopes to exactly the named subset', () => {
    const plan = buildPlan(files, { ...config, selectedFiles: ['b.pro'] })
    expect([...new Set(plan.map((e) => e.file))]).toEqual(['b.pro'])
  })
})

describe('buildPlan — swap vs metadata', () => {
  it('takes the metadata path (no swap) when the target ps equals the source ps', () => {
    const plan = buildPlan([file('x.pro', box([brand()]))], { ...config, selectedFiles: ['x.pro'] })
    expect(plan).toHaveLength(1)
    expect(plan[0].setFont).toBeNull()
    expect(plan[0].fixMeta).toBe(true)
    expect(plan[0].after.family).toBe('Tensentype RuiHei GB18030 W4')
  })

  it('a non-source descriptor ordered first must NOT flip a same-font box to the swap path', () => {
    // Emoji/fallback run listed before the brand run. The fix must still be a
    // metadata normalization of the brand run — not a swap that overwrites style.
    const mixed = box([
      { ps: 'HelveticaNeue', sizePt: 42, family: 'Helvetica Neue', style: '' },
      brand(),
    ])
    const plan = buildPlan([file('m.pro', mixed)], { ...config, selectedFiles: ['m.pro'] })
    expect(plan).toHaveLength(1)
    expect(plan[0].setFont, 'must not swap the font').toBeNull()
    expect(plan[0].fixMeta).toBe(true)
    expect(plan[0].after.family).toBe('Tensentype RuiHei GB18030 W4')
    // the diff reflects the brand run, not the fallback that happened to be first
    expect(plan[0].before.ps).toBe('Tensentype-RuiHeiJ-W4')
  })

  it('swaps when the source font genuinely differs from the target', () => {
    const swapCfg: FixConfig = {
      ...config,
      targetFont: { ps: 'PingFangSC-Semibold', family: 'PingFang SC', style: 'Semibold', label: '' },
    }
    const plan = buildPlan([file('s.pro', box([brand()]))], { ...swapCfg, selectedFiles: ['s.pro'] })
    expect(plan).toHaveLength(1)
    expect(plan[0].setFont?.ps).toBe('PingFangSC-Semibold')
    expect(plan[0].after.ps).toBe('PingFangSC-Semibold')
  })
})
