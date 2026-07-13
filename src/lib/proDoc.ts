// ProPresenter 7 `.pro` document model.
//
// Built on the schema-less codec: we parse into a lazily-expanded, mutable tree
// where every wire-2 node keeps its original bytes until we choose to expand it.
// Re-serializing an untouched subtree reproduces the original bytes exactly, so
// edits are surgical and everything we don't understand is preserved.
//
// We don't have the official schema, so text boxes are found structurally:
//   - a "font" message = { 1: string psName, 2: double size, 9: string family }
//   - a "text box" = any message that directly contains an RTF string field
//     (`{\rtf...}`); its font descriptors live somewhere in its subtree
//   - "content" vs "label": a box is content when its enclosing element carries
//     geometry (a bounds rect); the slide's label/notes box has none.
// This was validated against a real playlist (see analyzer tests).

import {
  decode,
  encode,
  readDouble,
  writeDouble,
  utf8Decode,
  utf8Encode,
  looksLikeMessage,
  type Field,
  type Wire,
} from './protobuf'
import { canonicalFamily, type FontOption } from './fonts'
import { patchRtfFontName, patchRtfSize, rtfPlainText } from './rtf'

// ---------------------------------------------------------------------------
// mutable tree
// ---------------------------------------------------------------------------

export interface Node {
  field: number
  wire: Wire
  value: bigint | Uint8Array
  /** decoded children, once this wire-2 node is expanded */
  sub?: Node[]
}

function toTree(fields: Field[]): Node[] {
  return fields.map((f) => ({ field: f.field, wire: f.wire, value: f.value }))
}

/** Expand a wire-2 node into child nodes (cached). Caller must ensure it's a message. */
function expand(n: Node): Node[] {
  if (n.wire !== 2) throw new Error('cannot expand non-message field')
  if (!n.sub) n.sub = toTree(decode(n.value as Uint8Array))
  return n.sub
}

function serialize(nodes: Node[]): Uint8Array {
  const fields: Field[] = nodes.map((n) => {
    if (n.wire === 2 && n.sub) return { field: n.field, wire: 2, value: serialize(n.sub) }
    return { field: n.field, wire: n.wire, value: n.value }
  })
  return encode(fields)
}

// small field helpers on a message's node list
function firstNode(nodes: Node[], field: number): Node | undefined {
  return nodes.find((n) => n.field === field)
}
function getString(nodes: Node[], field: number): string | null {
  const n = firstNode(nodes, field)
  if (!n || n.wire !== 2) return null
  return utf8Decode(n.value as Uint8Array)
}
function setString(nodes: Node[], field: number, s: string): void {
  const n = firstNode(nodes, field)
  const value = utf8Encode(s)
  if (n && n.wire === 2) {
    n.value = value
    n.sub = undefined
  } else {
    nodes.push({ field, wire: 2, value })
  }
}
function setDouble(nodes: Node[], field: number, f: number): void {
  const n = firstNode(nodes, field)
  const value = writeDouble(f)
  if (n && n.wire === 1) n.value = value
  else nodes.push({ field, wire: 1, value })
}

// ---------------------------------------------------------------------------
// structural detection
// ---------------------------------------------------------------------------

// A name-ish string: non-empty and free of C0 control bytes. Permits spaces
// (font families like "PingFang SC") and CJK (element names like "祝祷"), while
// rejecting UUIDs ("\n$...") and raw binary that decoded to junk.
function isPlausibleString(s: string | null): s is string {
  return !!s && s.length > 0 && !/[\x00-\x1f]/.test(s)
}

/** A message is a font descriptor if it has {1:string, 2:double size, 9:string}. */
function readFontDescriptor(nodes: Node[]): FontDescriptor | null {
  const nameN = firstNode(nodes, 1)
  const sizeN = firstNode(nodes, 2)
  const famN = firstNode(nodes, 9)
  if (!nameN || nameN.wire !== 2) return null
  if (!sizeN || sizeN.wire !== 1) return null
  if (!famN || famN.wire !== 2) return null
  const ps = utf8Decode(nameN.value as Uint8Array)
  const family = utf8Decode(famN.value as Uint8Array)
  if (!isPlausibleString(ps) || !isPlausibleString(family)) return null
  const sizePt = readDouble(sizeN.value as Uint8Array)
  if (!(sizePt > 0 && sizePt < 4000)) return null
  const styleN = firstNode(nodes, 10)
  const style = styleN && styleN.wire === 2 ? utf8Decode(styleN.value as Uint8Array) : ''
  return { ps, sizePt, family, style }
}

/** A bounds/rect field is a message { 1: {1:x,2:y}, 2: {1:w,2:h} } of floats. */
function readBounds(n: Node): { x: number; y: number; w: number; h: number } | null {
  if (n.wire !== 2 || !looksLikeMessage(n.value as Uint8Array)) return null
  let sub: Node[]
  try {
    sub = expand(n)
  } catch {
    return null
  }
  const origin = firstNode(sub, 1)
  const size = firstNode(sub, 2)
  if (!origin || origin.wire !== 2 || !size || size.wire !== 2) return null
  let o: Node[], s: Node[]
  try {
    o = expand(origin)
    s = expand(size)
  } catch {
    return null
  }
  const x = firstNode(o, 1)
  const y = firstNode(o, 2)
  const w = firstNode(s, 1)
  const h = firstNode(s, 2)
  // origin/size components are fixed64 doubles
  if ([x, y, w, h].some((c) => c && c.wire !== 1)) return null
  if (!w || !h) return null
  return {
    x: x ? readDouble(x.value as Uint8Array) : 0,
    y: y ? readDouble(y.value as Uint8Array) : 0,
    w: readDouble(w.value as Uint8Array),
    h: readDouble(h.value as Uint8Array),
  }
}

const RTF_PREFIX = '{\\rtf'
function rtfOf(n: Node): string | null {
  if (n.wire !== 2) return null
  const bytes = n.value as Uint8Array
  if (bytes.length < 5) return null
  // cheap prefix check without decoding the whole thing
  if (bytes[0] !== 0x7b || bytes[1] !== 0x5c || bytes[2] !== 0x72) return null // "{\r"
  const s = utf8Decode(bytes)
  return s.startsWith(RTF_PREFIX) ? s : null
}

// ---------------------------------------------------------------------------
// public model
// ---------------------------------------------------------------------------

export interface FontDescriptor {
  ps: string
  sizePt: number
  family: string
  style: string
}

export interface TextBox {
  role: 'content' | 'label'
  /** enclosing element name, if any (e.g. "Text", "祝祷") */
  name: string
  /** geometry signature "x,y,w,h" (rounded) for grouping the same box across slides */
  boundsSig: string | null
  /** enclosing element origin/size in points (un-rounded), when known */
  boundsY: number | null
  boundsW: number | null
  boundsH: number | null
  /** the enclosing element's bounds message ({1: origin, 2: size}), for geometry edits */
  boundsNode: Node | null
  /** distinct font descriptors present in the box (base attributes + runs) */
  descriptors: FontDescriptor[]
  // ---- editing handles (internal) ----
  /** the text message's own fields (attributes, RTF, …) */
  textNodes: Node[]
  fontNodes: Node[]
  rtfNode: Node | null
}

interface Ctx {
  name: string
  boundsSig: string | null
  boundsY: number | null
  boundsW: number | null
  boundsH: number | null
  boundsNode: Node | null
}

// Real documents nest ~12 levels; this bounds a pathological/hostile file so
// the recursive walk can't blow the stack.
const MAX_DEPTH = 256

export class ProDoc {
  readonly name: string
  private root: Node[]
  readonly boxes: TextBox[]
  /** slide canvas size in points (e.g. 1920×1080), when found */
  canvasW: number | null = null
  canvasH: number | null = null

  constructor(bytes: Uint8Array) {
    this.root = toTree(decode(bytes))
    this.name = getString(this.root, 3) ?? ''
    this.boxes = []
    this.walk(this.root, { name: '', boundsSig: null, boundsY: null, boundsW: null, boundsH: null, boundsNode: null }, 0)
  }

  serialize(): Uint8Array {
    return serialize(this.root)
  }

  /** Recursively find text boxes, tracking the nearest element name + geometry. */
  private walk(nodes: Node[], ctx: Ctx, depth: number): void {
    if (depth > MAX_DEPTH) return
    // Geometry marks an element. Capture the element's own name (field 2) only
    // here — arbitrary ancestor messages also have a field 2 (cue labels like
    // " 2") that must not be mistaken for the element name, or the same physical
    // box would appear under many different names.
    let name = ctx.name
    let boundsSig = ctx.boundsSig
    let boundsY = ctx.boundsY
    let boundsW = ctx.boundsW
    let boundsH = ctx.boundsH
    let boundsNode = ctx.boundsNode
    let foundBounds = false
    // The slide message carries its canvas size as field 6 = {1:w, 2:h}
    // (doubles). Record the first plausible one — geometry edits are gated on it.
    if (this.canvasW == null && depth <= 8) {
      for (const n of nodes) {
        if (n.field !== 6 || n.wire !== 2 || !looksLikeMessage(n.value as Uint8Array)) continue
        let sub: Node[]
        try {
          sub = expand(n)
        } catch {
          continue
        }
        if (sub.length !== 2 || sub[0].field !== 1 || sub[1].field !== 2) continue
        if (sub[0].wire !== 1 || sub[1].wire !== 1) continue
        const w = readDouble(sub[0].value as Uint8Array)
        const h = readDouble(sub[1].value as Uint8Array)
        if (w >= 640 && w <= 7680 && h >= 360 && h <= 4320) {
          this.canvasW = w
          this.canvasH = h
          break
        }
      }
    }
    for (const n of nodes) {
      const b = readBounds(n)
      if (b) {
        boundsSig = `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}`
        boundsY = b.y
        boundsW = b.w
        boundsH = b.h
        boundsNode = n
        foundBounds = true
        break
      }
    }
    if (foundBounds) {
      const nameHere = getString(nodes, 2)
      name = isPlausibleString(nameHere) ? nameHere : ''
    }
    const childCtx: Ctx = { name, boundsSig, boundsY, boundsW, boundsH, boundsNode }

    // Is this message a text box? (directly contains an RTF field)
    let rtfNode: Node | null = null
    for (const n of nodes) {
      if (rtfOf(n) !== null) {
        rtfNode = n
        break
      }
    }
    if (rtfNode) {
      const fontNodes: Node[] = []
      collectFontNodes(nodes, fontNodes)
      if (fontNodes.length > 0) {
        const descriptors = dedupeDescriptors(
          fontNodes.map((fn) => readFontDescriptor(fn.sub!)!).filter(Boolean),
        )
        this.boxes.push({
          role: childCtx.boundsSig ? 'content' : 'label',
          name: childCtx.name,
          boundsSig: childCtx.boundsSig,
          boundsY: childCtx.boundsY,
          boundsW: childCtx.boundsW,
          boundsH: childCtx.boundsH,
          boundsNode: childCtx.boundsNode,
          descriptors,
          textNodes: nodes,
          fontNodes,
          rtfNode,
        })
      }
    }

    // Recurse into message children.
    for (const n of nodes) {
      if (n.wire === 2 && n !== rtfNode && looksLikeMessage(n.value as Uint8Array)) {
        let sub: Node[]
        try {
          sub = expand(n)
        } catch {
          continue
        }
        this.walk(sub, childCtx, depth + 1)
      }
    }
  }
}

function dedupeDescriptors(ds: FontDescriptor[]): FontDescriptor[] {
  const seen = new Set<string>()
  const out: FontDescriptor[] = []
  for (const d of ds) {
    const key = `${d.ps}|${d.sizePt}|${d.family}|${d.style}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(d)
    }
  }
  return out
}

/** Collect every font-descriptor node in a subtree (base attributes + runs). */
function collectFontNodes(nodes: Node[], out: Node[]): void {
  for (const n of nodes) {
    if (n.wire !== 2) continue
    if (!looksLikeMessage(n.value as Uint8Array)) continue
    let sub: Node[]
    try {
      sub = expand(n)
    } catch {
      continue
    }
    if (readFontDescriptor(sub)) {
      out.push(n)
    } else {
      collectFontNodes(sub, out)
    }
  }
}

// ---------------------------------------------------------------------------
// editing operations on a TextBox
// ---------------------------------------------------------------------------

/**
 * Retarget only the runs whose current font is in `fromNames` to `target`, and
 * rename the matching entries in the RTF font table. Runs using any other font
 * (e.g. an emoji/fallback entry sharing the box) are left untouched.
 */
export function setBoxFont(box: TextBox, target: FontOption, fromNames: Set<string>): void {
  for (const fn of box.fontNodes) {
    const sub = fn.sub!
    const d = readFontDescriptor(sub)
    if (!d || !fromNames.has(d.ps)) continue
    setString(sub, 1, target.ps)
    setString(sub, 9, target.family)
    setString(sub, 10, target.style)
  }
  if (box.rtfNode) {
    let rtf = utf8Decode(box.rtfNode.value as Uint8Array)
    for (const from of fromNames) rtf = patchRtfFontName(rtf, from, target.ps)
    box.rtfNode.value = utf8Encode(rtf)
  }
}

/** Canonicalize the family-name field for the source runs only (Windows/Mac metadata fix). */
export function fixBoxFamilyMeta(box: TextBox, fromNames: Set<string>): boolean {
  let changed = false
  for (const fn of box.fontNodes) {
    const sub = fn.sub!
    const d = readFontDescriptor(sub)
    if (!d || !fromNames.has(d.ps)) continue
    const canonical = canonicalFamily(d.ps, d.family)
    if (canonical !== d.family) {
      setString(sub, 9, canonical)
      changed = true
    }
  }
  return changed
}

/** Set the point size for every run in the box + sync the RTF. */
export function setBoxSize(box: TextBox, pt: number): void {
  for (const fn of box.fontNodes) {
    setDouble(fn.sub!, 2, pt)
  }
  if (box.rtfNode) {
    const rtf = utf8Decode(box.rtfNode.value as Uint8Array)
    box.rtfNode.value = utf8Encode(patchRtfSize(rtf, pt))
  }
}

/** The box's representative point size (the most common across its runs). */
export function boxSize(box: TextBox): number | null {
  if (box.descriptors.length === 0) return null
  const counts = new Map<number, number>()
  for (const d of box.descriptors) counts.set(d.sizePt, (counts.get(d.sizePt) ?? 0) + 1)
  let best = box.descriptors[0].sizePt
  let bestC = -1
  for (const [sz, c] of counts) {
    if (c > bestC || (c === bestC && sz > best)) {
      best = sz
      bestC = c
    }
  }
  return best
}

/** The box's representative font (most common PostScript name). */
export function boxFont(box: TextBox): FontDescriptor | null {
  return box.descriptors[0] ?? null
}

/** Best-effort readable text of the box (for identifying slides in the UI). */
export function boxText(box: TextBox): string {
  if (!box.rtfNode) return ''
  return rtfPlainText(utf8Decode(box.rtfNode.value as Uint8Array))
}
