// Unit tests for scripture verse-box parsing, fitting, and RTF generation.
import { describe, it, expect } from 'vitest'
import {
  parseVerseLines,
  fitEffectivePt,
  buildSegments,
  buildScriptureRtf,
  SCRIPTURE_DECLARED_PT,
} from '../src/lib/scripture'

// A trimmed real-world sample of the ProPresenter (\rtf0) dialect: two verses,
// verse numbers as \super runs, CJK as \uN with \uc1 fallback chars.
const RTF0 =
  '{\\rtf0\\ansi\\ansicpg1252{\\fonttbl\\f0\\fnil Tensentype-RuiHeiJ-W4;}' +
  '{\\colortbl;\\red255\\green255\\blue255;\\red255\\green255\\blue255;}' +
  '{\\*\\expandedcolortbl;\\csgenericrgb\\c100000\\c100000\\c100000\\c100000;}' +
  '\\uc1\\paperw12240\\pard\\li0\\fi0\\ri0\\ql\\sb0\\sa0\\sl240\\slmult1\\f0\\b0\\fs250' +
  '\\super\\ulc0\\highlight2\\cb2 6\\nosupersub\\u25042 ?\\u24816 ?\\u20154 ?\\u21738 ?\\u65292 ?' +
  '\\par\\pard\\ql\\fs250\\nosupersub\\u20320 ?\\u21435 ?\\u23519 ?\\u30475 ?\\u65292 ?' +
  '\\par\\pard\\ql\\fs250\\super\\cb2 7\\nosupersub\\u34434 ?\\u34433 ?\\u65292 ?}'

describe('parseVerseLines', () => {
  it('parses the ProPresenter rtf0 dialect (super digits + \\uN with \\uc1 fallbacks)', () => {
    expect(parseVerseLines(RTF0)).toEqual([
      { num: '6', text: '懒惰人哪，' },
      { num: null, text: '你去察看，' },
      { num: '7', text: '蚂蚁，' },
    ])
  })

  it('round-trips through the generated Cocoa RTF (idempotent reformat)', () => {
    const lines = parseVerseLines(RTF0)!
    const rtf = buildScriptureRtf(lines, 'Tensentype-RuiHeiJ-W4', SCRIPTURE_DECLARED_PT)
    expect(parseVerseLines(rtf)).toEqual(lines)
  })

  it('handles multi-digit verse numbers and \\up0 in the Cocoa dialect', () => {
    const rtf = buildScriptureRtf(
      [
        { num: '9', text: '懒惰人哪？' },
        { num: '10', text: '再睡片时，' },
      ],
      'X',
      130,
    )
    expect(rtf).toContain('\\super 10\\up0 \\nosupersub ')
    expect(parseVerseLines(rtf)).toEqual([
      { num: '9', text: '懒惰人哪？' },
      { num: '10', text: '再睡片时，' },
    ])
  })

  it('rejects non-scripture content', () => {
    // no verse numbers at all
    expect(
      parseVerseLines('{\\rtf0\\ansi\\uc1\\fs250\\u35835 ?\\u32463 ?\\par\\u24352 ?\\u31435 ?}'),
    ).toBeNull()
    // single line
    expect(parseVerseLines('{\\rtf0\\ansi\\uc1\\fs250\\super 6\\nosupersub\\u25042 ?}')).toBeNull()
    // superscript that is not a number
    expect(
      parseVerseLines('{\\rtf0\\ansi\\uc1\\fs250\\super\\cb2 a\\nosupersub\\u25042 ?\\par\\u20320 ?}'),
    ).toBeNull()
    // legacy \'hh escapes we cannot decode
    expect(parseVerseLines("{\\rtf0\\ansi\\uc1\\fs250\\super 6\\nosupersub\\'b5\\'dc\\par x}")).toBeNull()
    // a \ucN fallback that is an escape or group-open would desync the parse — bail
    expect(
      parseVerseLines('{\\rtf0\\ansi\\uc1\\fs250\\super 6\\nosupersub\\u25042 {\\i x}\\par\\u20320 ?}'),
    ).toBeNull()
    expect(
      parseVerseLines('{\\rtf0\\ansi\\uc1\\fs250\\super 6\\nosupersub\\u25042 \\u24816 ?\\par\\u20320 ?}'),
    ).toBeNull()
  })
})

describe('fitEffectivePt', () => {
  // Calibration data from the 2026-07-12 hand-fixed playlist.
  const PROV_6_8 = [
    { num: '6', text: '懒惰人哪，' },
    { num: null, text: '你去察看蚂蚁的动作，就可得智慧。' },
    { num: '7', text: '蚂蚁没有元帅，' },
    { num: null, text: '没有官长，没有君王，' },
    { num: '8', text: '尚且在夏天预备食物，' },
    { num: null, text: '在收割时聚敛粮食。' },
  ]
  const PROV_9_11 = [
    { num: '9', text: '懒惰人哪，你要睡到几时呢？' },
    { num: null, text: '你何时睡醒呢？' },
    { num: '10', text: '再睡片时，打盹片时，' },
    { num: null, text: '抱着手躺卧片时，' },
    { num: '11', text: '你的贫穷就必如强盗速来，' },
    { num: null, text: '你的缺乏仿佛拿兵器的人来到。' },
  ]

  it('matches ProPresenter (width-bound box): 箴言 6:6-8 → 100.9375pt', () => {
    expect(fitEffectivePt(PROV_6_8, 1635.8, 827.3, 130)).toBe(100.9375)
  })

  it('stays close to (and safely below +1/16 of) ProPresenter for height-bound boxes', () => {
    // ProPresenter's own fit for this text in the normalized ~827pt box family
    // is 111.25pt; our model carries a small safety margin.
    const p = fitEffectivePt(PROV_9_11, 1635.8, 827, 130)
    expect(p).toBeGreaterThan(110)
    expect(p).toBeLessThanOrEqual(111.25 + 0.5)
  })

  it('never exceeds the declared size for short text', () => {
    expect(fitEffectivePt([{ num: '1', text: '短' }, { num: null, text: '文' }], 1636, 827, 130)).toBe(130)
  })
})

describe('buildSegments', () => {
  it('produces [start,end) UTF-16 ranges with newlines attached to text runs', () => {
    const { text, segs } = buildSegments([
      { num: '6', text: '懒惰人哪，' },
      { num: null, text: '你去察看蚂蚁的动作，就可得智慧。' },
      { num: '7', text: '蚂蚁没有元帅，' },
    ])
    expect(text).toBe('6懒惰人哪，\n你去察看蚂蚁的动作，就可得智慧。\n7蚂蚁没有元帅，')
    // digit / text / digit / text — matching the hand-fixed reference layout
    expect(segs).toEqual([
      { start: 0, end: 1, sup: true },
      { start: 1, end: 24, sup: false },
      { start: 24, end: 25, sup: true },
      { start: 25, end: 32, sup: false },
    ])
  })
})
