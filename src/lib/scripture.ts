// Scripture (经文) slide reformatting — 宣召/读经 verse boxes.
//
// ProPresenter renders slide text from the structured attributed string (the
// attributes message and its per-range runs), not from the legacy RTF mirror.
// Verse slides built on the Windows machine store verse numbers as RTF `\super`
// runs with one uniform size and no per-range font runs — on the playback Mac
// those render as full-size raised digits with broken line sizing.
//
// The hand-fixed reference (2026-07-12 final vs original fixtures) encodes the
// working format explicitly, and this module reproduces it:
//   - declared (base) size 130 pt on every run
//   - one whole-string scale attribute (ProPresenter's shrink-to-fit
//     bookkeeping): effective size = declared × scale
//   - per-range font runs: verse digits at HALF the effective size (that is
//     what makes them render as small superscripts), verse text at the
//     effective size; ranges are UTF-16 offsets, [start, end) with newlines
//     attached to the preceding text run
//   - a Cocoa-dialect RTF mirror (`\fs260`, digits wrapped in
//     `\super N\up0 \nosupersub`, default tab 1680 twips = the paragraph
//     message's `12: 84` pt)
//
// The hand-fixed reference also normalizes the slide GEOMETRY: the operator's
// template has a half-height verse box (~504 pt) with the reference bar right
// below mid-screen; the fixed version grows the verse box down to y≈866 and
// docks the reference bar there (bottom of a 1080-pt canvas). We reproduce
// both the text rebuild and that geometry.
//
// The scale itself is ProPresenter's own fit result; we approximate its text
// measurement with an em model calibrated against the reference fixtures
// (exact for the width-bound sample; the height model carries a ~1% safety
// margin so we never overshoot ProPresenter's own fit by more than a step).

import { decode, utf8Decode, utf8Encode, writeDouble, readDouble } from './protobuf'
import { boxText, type Node, type TextBox } from './proDoc'

export interface VerseLine {
  /** verse number digits, or null when the line continues the previous verse */
  num: string | null
  text: string
}

export interface ScripturePlan {
  declaredPt: number
  effectivePt: number
  lines: VerseLine[]
  /** the slide's scripture-reference box (e.g. 箴言 6:6-8), when found */
  refBox: TextBox | null
  /** target verse-box height after the geometry fix (null = keep) */
  targetH: number | null
}

/** Declared point size of the rebuilt box (the hand-fixed reference uses 130). */
export const SCRIPTURE_DECLARED_PT = 130
/** Top of the reference bar in the hand-fixed template (1080-pt canvas). */
export const SCRIPTURE_REF_TOP_PT = 866

// ---------------------------------------------------------------------------
// RTF parsing (both dialects: ProPresenter's \rtf0 and Cocoa's \rtf1)
// ---------------------------------------------------------------------------

// Destination groups that hold no slide text.
const SKIP_GROUPS = new Set([
  'fonttbl',
  'colortbl',
  'expandedcolortbl',
  'stylesheet',
  'listtable',
  'listoverridetable',
  'info',
  'pict',
])

interface RtfChar {
  ch: string
  sup: boolean
}

/**
 * Tokenize an RTF text box into visible characters with a superscript flag.
 * Returns null when the RTF uses constructs we don't model (so callers skip
 * the box instead of corrupting it).
 */
export function rtfChars(rtf: string): RtfChar[] | null {
  if (!rtf.startsWith('{\\rtf')) return null
  const out: RtfChar[] = []
  // group state: superscript flag + \ucN skip count
  const stack: { sup: boolean; uc: number }[] = []
  let sup = false
  let uc = 1
  let i = 0

  const skipGroup = (): boolean => {
    // i points at '{'; skip to its matching '}'
    let depth = 0
    for (; i < rtf.length; i++) {
      if (rtf[i] === '\\') i++ // escaped char inside the group
      else if (rtf[i] === '{') depth++
      else if (rtf[i] === '}') {
        depth--
        if (depth === 0) {
          i++
          return true
        }
      }
    }
    return false
  }

  while (i < rtf.length) {
    const c = rtf[i]
    if (c === '{') {
      // peek the group's first control word to decide skip vs recurse
      const m = /^\{\\(\*\\)?([a-zA-Z]+)/.exec(rtf.slice(i, i + 24))
      if (m && (m[1] || SKIP_GROUPS.has(m[2]))) {
        if (!skipGroup()) return null
        continue
      }
      stack.push({ sup, uc })
      i++
    } else if (c === '}') {
      const s = stack.pop()
      if (s) ({ sup, uc } = s)
      i++
    } else if (c === '\\') {
      const next = rtf[i + 1]
      if (next === '\n' || next === '\r') {
        // Cocoa writes a paragraph break as backslash + newline
        out.push({ ch: '\n', sup })
        i += 2
        if (next === '\r' && rtf[i] === '\n') i++
      } else if (next === '\\' || next === '{' || next === '}') {
        out.push({ ch: next, sup })
        i += 2
      } else if (next === "'") {
        // legacy codepage escape — we can't decode it faithfully; bail
        return null
      } else if (/[a-zA-Z]/.test(next)) {
        const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i))
        if (!m) return null
        const word = m[1]
        const arg = m[2] != null ? parseInt(m[2], 10) : null
        i += m[0].length
        if (word === 'u' && arg != null) {
          out.push({ ch: String.fromCharCode(((arg % 65536) + 65536) % 65536), sup })
          // skip the \ucN fallback characters (plain chars in our files);
          // escapes or group-opens as fallbacks would desync the parse — bail
          for (let k = 0; k < uc; k++) {
            if (rtf[i] === '\\' || rtf[i] === '{') return null
            if (rtf[i] !== '}') i++
          }
        } else if (word === 'uc' && arg != null) {
          uc = arg
        } else if (word === 'par' || word === 'line') {
          out.push({ ch: '\n', sup })
        } else if (word === 'super') {
          sup = true
        } else if (word === 'nosupersub') {
          sup = false
        }
        // every other control word only affects styling we regenerate anyway
      } else {
        // unknown control symbol (\~, \-, …) — ignore
        i += 2
      }
    } else if (c === '\r' || c === '\n') {
      i++ // raw newlines outside an escape are formatting, not content
    } else {
      out.push({ ch: c, sup })
      i++
    }
  }
  return out
}

/**
 * Interpret a text box's RTF as verse lines. Returns null unless the content
 * looks like scripture: every superscript run is a digit run at the start of a
 * line, and at least one verse number exists across 2+ lines.
 */
export function parseVerseLines(rtf: string): VerseLine[] | null {
  const chars = rtfChars(rtf)
  if (!chars) return null
  // split into lines of RtfChar
  const lines: RtfChar[][] = [[]]
  for (const rc of chars) {
    if (rc.ch === '\n') lines.push([])
    else lines[lines.length - 1].push(rc)
  }
  while (lines.length && lines[lines.length - 1].length === 0) lines.pop()
  if (lines.length < 2) return null

  const out: VerseLine[] = []
  let numCount = 0
  for (const line of lines) {
    // the superscript run must be a whole prefix of the line
    let cut = 0
    while (cut < line.length && line[cut].sup) cut++
    for (let k = cut; k < line.length; k++) {
      if (line[k].sup) return null // superscript mid-line — not a verse layout we model
    }
    const rawNum = line
      .slice(0, cut)
      .map((r) => r.ch)
      .join('')
      .trim()
    const text = line
      .slice(cut)
      .map((r) => r.ch)
      .join('')
      .replace(/^\s+/, '')
    if (cut > 0 && !/^\d+$/.test(rawNum)) return null // super prefix isn't a verse number
    if (cut === 0 && text.trim().length === 0) continue // blank separator line — drop it
    if (text.length === 0) return null // number-only line — not modeled
    out.push({ num: cut > 0 ? rawNum : null, text })
    if (cut > 0) numCount++
  }
  return numCount >= 1 ? out : null
}

// ---------------------------------------------------------------------------
// shrink-to-fit approximation
// ---------------------------------------------------------------------------

// Em-model constants calibrated against the 2026-07-12 hand-fixed fixtures
// (verse boxes 1636×827 / 1636×810 / 1636×811 → 100.9375 / 111.25 / 111.25 pt).
// Width reproduces the width-bound sample exactly; the line-height factor sits
// ~1% above the calibration band so height-bound results err slightly small
// (never overflowing the box) instead of slightly large.
const CJK_ADV_EM = 1.0065 // full-width glyph advance (incl. tracking)
const ASCII_ADV_EM = 0.52 // half-width fallback
const SUPER_ADV_EM = 0.3 // verse digit: rendered at half size
const LINE_HEIGHT = 1.235 // line height factor over the raw box height
const INSET_PT = 5 // horizontal text container inset per edge

/** Largest effective size (1/16 pt steps, capped at declared) that fits the box. */
export function fitEffectivePt(
  lines: VerseLine[],
  boxW: number,
  boxH: number,
  declaredPt: number,
): number {
  let maxEm = 0
  for (const l of lines) {
    let em = (l.num?.length ?? 0) * SUPER_ADV_EM
    for (let i = 0; i < l.text.length; i++) {
      em += l.text.charCodeAt(i) > 0xff ? CJK_ADV_EM : ASCII_ADV_EM
    }
    maxEm = Math.max(maxEm, em)
  }
  if (maxEm === 0 || lines.length === 0) return declaredPt
  const widthFit = (boxW - 2 * INSET_PT) / maxEm
  const heightFit = boxH / (lines.length * LINE_HEIGHT)
  const p = Math.min(widthFit, heightFit, declaredPt)
  return Math.max(8, Math.floor(p * 16) / 16)
}

// ---------------------------------------------------------------------------
// planning / detection
// ---------------------------------------------------------------------------

// A scripture reference line like 箴言 6:6-8 / 诗篇 100:4-5.
const REF_RE = /^[一-鿿]{1,8}\s*\d{1,3}\s*[:：]\s*\d{1,3}(\s*[-–—~～]\s*\d{1,3})?$/

/**
 * The verse box's reference-bar box: the immediately following content box
 * whose text is a scripture reference and which sits below the verse box.
 * A label box (each slide's trailing notes box) ends the search, so the
 * pairing never crosses into the next slide.
 */
function findRefBox(box: TextBox, siblings: TextBox[]): TextBox | null {
  const at = siblings.indexOf(box)
  if (at < 0) return null
  for (let i = at + 1; i < siblings.length; i++) {
    const b = siblings[i]
    if (b.role !== 'content') return null
    if (!REF_RE.test(boxText(b).trim())) return null
    if (b.boundsY == null || box.boundsY == null || b.boundsY <= box.boundsY) return null
    return b
  }
  return null
}

/**
 * Decide whether a box is a scripture verse box and, if so, what the rebuild
 * would produce. Pure — inspects the boxes without mutating them, and checks
 * every precondition applyScripture needs, so preview and apply can't
 * diverge. `siblings` (the document's box list) lets the plan include the
 * slide's reference bar and the geometry normalization; `canvasH` gates the
 * geometry step (the docked-bar position is a 1080-pt-canvas template value).
 */
export function planScripture(
  box: TextBox,
  siblings: TextBox[] = [],
  canvasH: number | null = null,
): ScripturePlan | null {
  if (box.role !== 'content' || !box.rtfNode) return null
  if (box.boundsW == null || box.boundsH == null) return null
  const lines = parseVerseLines(utf8Decode(box.rtfNode.value as Uint8Array))
  if (!lines) return null
  // applyScripture preconditions: attributes message with a named base font
  const attrsNode = box.textNodes.find((n) => n.field === 3 && n.wire === 2)
  if (!attrsNode) return null
  const baseSub = expandNode(attrsNode).find((n) => n.field === 1 && n.wire === 2)
  if (!baseSub) return null
  const base = expandNode(baseSub)
  if (!getStr(base, 1) || !getStr(base, 9)) return null

  // With a reference bar on the slide (and the 1080-pt canvas the template
  // was built for), the verse box grows down to the bar's docked position;
  // otherwise geometry is left alone and only the text is rebuilt.
  const refBox = canvasH != null && Math.abs(canvasH - 1080) < 0.5 ? findRefBox(box, siblings) : null
  let targetH: number | null = null
  if (refBox && box.boundsY != null && SCRIPTURE_REF_TOP_PT - box.boundsY > 100) {
    targetH = SCRIPTURE_REF_TOP_PT - box.boundsY
  }
  return {
    declaredPt: SCRIPTURE_DECLARED_PT,
    effectivePt: fitEffectivePt(lines, box.boundsW, targetH ?? box.boundsH, SCRIPTURE_DECLARED_PT),
    lines,
    refBox: targetH != null ? refBox : null,
    targetH,
  }
}

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

const EMPTY = new Uint8Array(0)
const msgNode = (field: number, sub: Node[]): Node => ({ field, wire: 2, value: EMPTY, sub })
const strNode = (field: number, s: string): Node => ({ field, wire: 2, value: utf8Encode(s) })
const dblNode = (field: number, n: number): Node => ({ field, wire: 1, value: writeDouble(n) })
const varNode = (field: number, n: number): Node => ({ field, wire: 0, value: BigInt(n) })

/** [start, end) range message; start 0 is omitted (proto default). */
function rangeNode(start: number, end: number): Node {
  return msgNode(1, start > 0 ? [varNode(1, start), varNode(2, end)] : [varNode(2, end)])
}

function expandNode(n: Node): Node[] {
  if (!n.sub) n.sub = decode(n.value as Uint8Array).map((f) => ({ field: f.field, wire: f.wire, value: f.value }))
  return n.sub
}

interface Segment {
  start: number
  end: number
  sup: boolean
}

/** Flatten verse lines into the slide string + its digit/text segments. */
export function buildSegments(lines: VerseLine[]): { text: string; segs: Segment[] } {
  let text = ''
  const segs: Segment[] = []
  const append = (s: string, sup: boolean) => {
    if (!s) return
    const last = segs[segs.length - 1]
    if (last && last.sup === sup && last.end === text.length) last.end = text.length + s.length
    else segs.push({ start: text.length, end: text.length + s.length, sup })
    text += s
  }
  lines.forEach((l, i) => {
    if (i > 0) append('\n', false)
    if (l.num) append(l.num, true)
    append(l.text, false)
  })
  return { text, segs }
}

/** Emit line text in the Cocoa dialect (ASCII literal, the rest as \uN). */
function emitText(s: string): string {
  let out = ''
  let inUnicode = false
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    const ch = s[i]
    if (code >= 0x20 && code <= 0x7e && ch !== '\\' && ch !== '{' && ch !== '}') {
      out += ch
      inUnicode = false
    } else {
      if (!inUnicode) {
        out += '\\uc0'
        inUnicode = true
      }
      out += `\\u${code > 32767 ? code - 65536 : code} `
    }
  }
  return out
}

/** The Cocoa-dialect RTF mirror, shaped exactly like the hand-fixed reference. */
export function buildScriptureRtf(lines: VerseLine[], psName: string, declaredPt: number): string {
  const head =
    `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2868\n` +
    `\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fnil\\fcharset0 ${psName};}\n` +
    `{\\colortbl;\\red255\\green255\\blue255;\\red255\\green255\\blue255;}\n` +
    `{\\*\\expandedcolortbl;;\\csgenericrgb\\c100000\\c100000\\c100000;}\n` +
    `\\deftab1680\n` +
    `\\pard\\pardeftab1680\\partightenfactor0\n\n` +
    `\\f0\\fs${Math.round(declaredPt * 2)} \\cf2 `
  let body = ''
  lines.forEach((l, i) => {
    if (i > 0) body += '\\\n'
    if (l.num) body += `${i > 0 ? '\\up0 ' : ''}\\super ${l.num}\\up0 \\nosupersub `
    body += emitText(l.text)
  })
  return head + body + '}'
}

/** Set the y (origin) or h (size) component of a bounds message. */
function setBounds(boundsNode: Node, part: 'y' | 'h', v: number): void {
  const sub = expandNode(boundsNode)
  const outer = sub.find((n) => n.field === (part === 'y' ? 1 : 2) && n.wire === 2)
  if (!outer) return
  setDbl(expandNode(outer), 2, v) // origin = {1:x, 2:y}; size = {1:w, 2:h}
  outer.value = EMPTY
  boundsNode.value = EMPTY
}

/**
 * Rebuild a verse box in place per an existing plan: normalizes the slide
 * geometry, then replaces the attributes runs and the RTF.
 * Returns false when the box doesn't have the structure we expect.
 */
export function applyScripture(box: TextBox, plan: ScripturePlan): boolean {
  const attrsNode = box.textNodes.find((n) => n.field === 3 && n.wire === 2)
  if (!attrsNode) return false
  const attrs = expandNode(attrsNode)

  // base font descriptor: source of ps/family/style for every run we write
  const baseFont = attrs.find((n) => n.field === 1 && n.wire === 2)
  if (!baseFont) return false
  const baseSub = expandNode(baseFont)
  const ps = getStr(baseSub, 1)
  const family = getStr(baseSub, 9)
  const style = getStr(baseSub, 10)
  if (!ps || !family) return false

  const { declaredPt, effectivePt, lines } = plan
  const { text, segs } = buildSegments(lines)

  // -- geometry: grow the verse box to the reference bar, dock the bar
  if (plan.targetH != null && box.boundsNode) {
    setBounds(box.boundsNode, 'h', plan.targetH)
    box.boundsH = plan.targetH
    if (plan.refBox?.boundsNode) {
      setBounds(plan.refBox.boundsNode, 'y', SCRIPTURE_REF_TOP_PT)
      plan.refBox.boundsY = SCRIPTURE_REF_TOP_PT
    }
  }

  // -- base descriptor: declared size
  setDbl(baseSub, 2, declaredPt)

  // -- paragraph message: ensure the default tab interval (mirrors \deftab1680)
  const para = attrs.find((n) => n.field === 6 && n.wire === 2)
  if (para) {
    const sub = expandNode(para)
    if (!sub.some((n) => n.field === 12)) {
      const at = sub.findIndex((n) => n.field > 12)
      sub.splice(at < 0 ? sub.length : at, 0, dblNode(12, 84))
    }
  }

  const fontDesc = (sizePt: number): Node =>
    msgNode(12, [
      strNode(1, ps),
      dblNode(2, sizePt),
      strNode(9, family),
      ...(style ? [strNode(10, style)] : []),
    ])

  // NOTE: every existing per-range run (field 13) is replaced — the rebuild
  // owns the box. The fixtures carry only size runs there; anything else a
  // future file might add (per-range color/kerning) would be regenerated from
  // the template's uniform styling instead.
  const runs: Node[] = [
    // whole-string scale (shrink-to-fit bookkeeping)
    msgNode(13, [rangeNode(0, text.length), dblNode(4, effectivePt / declaredPt)]),
    // declared size on every segment
    ...segs.map((s) => msgNode(13, [rangeNode(s.start, s.end), dblNode(3, declaredPt)])),
    // effective fonts: digits at half size — this is what renders the superscript
    ...segs.map((s) => msgNode(13, [rangeNode(s.start, s.end), fontDesc(s.sup ? effectivePt / 2 : effectivePt)])),
  ]

  // rebuild attrs: keep non-run fields (ascending), ensure 4/9 empty strings exist
  const kept = attrs.filter((n) => n.field !== 13)
  if (!kept.some((n) => n.field === 4)) kept.push(strNode(4, ''))
  if (!kept.some((n) => n.field === 9)) kept.push(strNode(9, ''))
  kept.sort((a, b) => a.field - b.field)
  attrsNode.sub = [...kept, ...runs]
  attrsNode.value = EMPTY

  // -- RTF mirror
  box.rtfNode!.value = utf8Encode(buildScriptureRtf(lines, ps, declaredPt))

  return true
}

/** Plan + apply in one step (standalone use and tests). */
export function reformatScripture(
  box: TextBox,
  siblings: TextBox[] = [],
  canvasH: number | null = null,
): ScripturePlan | null {
  const plan = planScripture(box, siblings, canvasH)
  if (!plan) return null
  return applyScripture(box, plan) ? plan : null
}

// small readers over a node list
function getStr(nodes: Node[], field: number): string | null {
  const n = nodes.find((x) => x.field === field && x.wire === 2)
  return n ? utf8Decode(n.value as Uint8Array) : null
}
function setDbl(nodes: Node[], field: number, v: number): void {
  const n = nodes.find((x) => x.field === field && x.wire === 1)
  if (n) n.value = writeDouble(v)
  else nodes.push(dblNode(field, v))
}

/** Effective (on-screen) size of a rebuilt box, for tests/reporting. */
export function readEffectivePt(box: TextBox): number | null {
  const attrsNode = box.textNodes.find((n) => n.field === 3 && n.wire === 2)
  if (!attrsNode) return null
  const attrs = expandNode(attrsNode)
  const base = attrs.find((n) => n.field === 1 && n.wire === 2)
  if (!base) return null
  const baseSize = expandNode(base).find((n) => n.field === 2 && n.wire === 1)
  if (!baseSize) return null
  for (const n of attrs) {
    if (n.field !== 13 || n.wire !== 2) continue
    const scale = expandNode(n).find((x) => x.field === 4 && x.wire === 1)
    if (scale) return readDouble(baseSize.value as Uint8Array) * readDouble(scale.value as Uint8Array)
  }
  return null
}
