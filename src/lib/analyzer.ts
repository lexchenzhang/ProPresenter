// Review + fix-planning over a whole playlist.
//
// Two jobs:
//  1. analyze()  — describe every text box and flag inconsistencies (the review).
//  2. buildPlan()— turn a config into a concrete list of edits (the fix).
// Both share the same "which boxes are content" and "group the same box across
// slides" logic so the preview and the applied fix never disagree.

import { canonicalFamily, type FontOption } from './fonts'
import { boxSize, boxFont, boxText, type ProDoc, type TextBox } from './proDoc'
import { planScripture, type ScripturePlan } from './scripture'

export interface FileEntry {
  name: string
  doc: ProDoc
}

export type IssueKind = 'size-mismatch' | 'family-meta'

/**
 * How to unify sizes:
 *  - 'file-mode'  每篇众数: one size per .pro — the most common size among that
 *    file's content boxes (what the user asked for by default).
 *  - 'box-group'  同框统一: only unify the *same* box across slides (name+geometry),
 *    fixing accidental per-slide drift while preserving title/subtitle hierarchy.
 *  - 'global'     全局统一: one size for the whole playlist.
 *  - 'keep'       不改字号.
 */
export type SizePolicy = 'file-mode' | 'box-group' | 'global' | 'keep'

export interface BoxRow {
  file: string
  index: number
  role: 'content' | 'label'
  name: string
  boundsSig: string | null
  ps: string
  family: string
  style: string
  size: number | null
  /** distinct sizes if the box mixes them internally */
  sizes: number[]
  isSource: boolean
  /** for source content boxes: the target size its group should share */
  groupMode: number | null
  issues: IssueKind[]
}

/** One .pro document, summarized for the presentation picker. */
export interface PresentationInfo {
  /** zip entry name — the stable key used by FixConfig.selectedFiles */
  file: string
  /** the presentation's own name (field 3), falls back to the entry name */
  name: string
  contentBoxes: number
  /** short readable slide-text snippet (helps spot 宣召/读经 when the name doesn't) */
  preview: string
}

export interface PlaylistReport {
  files: number
  contentBoxes: number
  labelBoxes: number
  /** PostScript names of detected content fonts, most common first */
  sourcePsNames: string[]
  /** display list of every distinct (ps, family) seen on content boxes */
  contentFonts: { ps: string; family: string; count: number }[]
  distinctSizes: number[]
  sizeIssues: number
  metaIssues: number
  rows: BoxRow[]
  /** per-document summary, in archive order, for the picker */
  presentations: PresentationInfo[]
}

export interface FixConfig {
  /** which PostScript font names count as "content" to normalize */
  sourcePsNames: string[]
  /** remap the content font to the target font */
  remapFont: boolean
  targetFont: FontOption
  /** canonicalize the family-name field even when keeping the original font */
  fixFamilyMeta: boolean
  /**
   * Rebuild scripture (宣召/读经) verse boxes into the hand-fixed layout:
   * superscript verse numbers at half size + shrink-to-fit size bookkeeping.
   */
  scriptureReformat?: boolean
  sizePolicy: SizePolicy
  globalSize: number
  /**
   * Zip entry names of the presentations to process. Only these documents are
   * touched. `undefined` = every document (used by tests / batch callers); an
   * empty array = none.
   */
  selectedFiles?: string[]
}

export interface FixEdit {
  file: string
  index: number
  box: TextBox
  /** the box's current font names that are being remapped (scopes the edit) */
  fromNames: string[]
  before: { ps: string; family: string; style: string; size: number | null }
  after: { ps: string; family: string; style: string; size: number | null }
  setFont: FontOption | null
  fixMeta: boolean
  setSize: number | null
  /** verse-box rebuild (节号上标 + 自适应字号), when the box qualifies */
  scripture: ScripturePlan | null
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function isSource(box: TextBox, sourceSet: Set<string>): boolean {
  return box.role === 'content' && box.descriptors.some((d) => sourceSet.has(d.ps))
}

/** The grouping unit within a file that must share one size, per policy.
 *  box-group keys on geometry alone — the element name is unreliable (the same
 *  physical box can surface under different names across slides). */
function groupKey(box: TextBox, policy: SizePolicy): string {
  return policy === 'box-group' ? `box:${box.boundsSig ?? '?'}` : 'FILE'
}

/** Most common size in a list; ties resolve to the larger size. */
function modeSize(sizes: number[]): number | null {
  if (sizes.length === 0) return null
  const counts = new Map<number, number>()
  for (const s of sizes) counts.set(s, (counts.get(s) ?? 0) + 1)
  let best = sizes[0]
  let bestC = -1
  for (const [sz, c] of counts) {
    if (c > bestC || (c === bestC && sz > best)) {
      best = sz
      bestC = c
    }
  }
  return best
}

/** Per-file: the mode size for each grouping unit (per policy). */
function groupModes(doc: ProDoc, sourceSet: Set<string>, policy: SizePolicy): Map<string, number> {
  const groups = new Map<string, number[]>()
  for (const box of doc.boxes) {
    if (!isSource(box, sourceSet)) continue
    const sz = boxSize(box)
    if (sz == null) continue
    const key = groupKey(box, policy)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(sz)
  }
  const out = new Map<string, number>()
  for (const [key, sizes] of groups) {
    const m = modeSize(sizes)
    if (m != null) out.set(key, m)
  }
  return out
}

/** Detect content fonts across the playlist, most common (by box count) first. */
export function detectSourcePsNames(files: FileEntry[]): string[] {
  const counts = new Map<string, number>()
  for (const { doc } of files) {
    for (const box of doc.boxes) {
      if (box.role !== 'content') continue
      const f = boxFont(box)
      if (f) counts.set(f.ps, (counts.get(f.ps) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ps]) => ps)
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

export function analyze(
  files: FileEntry[],
  opts: { sizePolicy?: SizePolicy; sourcePsNames?: string[] } = {},
): PlaylistReport {
  const sourcePsNames = detectSourcePsNames(files)
  const policy = opts.sizePolicy ?? 'file-mode'
  // Default source = the single most common content font (the brand lyric font).
  const sourceSet = new Set(opts.sourcePsNames ?? sourcePsNames.slice(0, 1))

  const rows: BoxRow[] = []
  const contentFontCounts = new Map<string, { ps: string; family: string; count: number }>()
  const allSizes = new Set<number>()
  const presentations: PresentationInfo[] = []
  let contentBoxes = 0
  let labelBoxes = 0
  let sizeIssues = 0
  let metaIssues = 0

  for (const { name, doc } of files) {
    presentations.push({
      file: name,
      name: doc.name || name.replace(/\.pro$/, ''),
      contentBoxes: doc.boxes.filter((b) => b.role === 'content').length,
      preview: presentationPreview(doc),
    })
    const modes = policy === 'keep' ? null : groupModes(doc, sourceSet, policy)
    doc.boxes.forEach((box, index) => {
      const primary = boxFont(box)
      const size = boxSize(box)
      const sizes = [...new Set(box.descriptors.map((d) => d.sizePt))].sort((a, b) => a - b)
      const source = isSource(box, sourceSet)
      if (box.role === 'content') contentBoxes++
      else labelBoxes++
      if (size != null) allSizes.add(size)

      if (box.role === 'content' && primary) {
        const fk = `${primary.ps}|${primary.family}`
        const cur = contentFontCounts.get(fk) ?? { ps: primary.ps, family: primary.family, count: 0 }
        cur.count++
        contentFontCounts.set(fk, cur)
      }

      const issues: IssueKind[] = []
      const groupMode = source && modes ? modes.get(groupKey(box, policy)) ?? null : null
      if (source && groupMode != null && size != null && size !== groupMode) {
        issues.push('size-mismatch')
        sizeIssues++
      }
      if (source && primary && canonicalFamily(primary.ps, primary.family) !== primary.family) {
        issues.push('family-meta')
        metaIssues++
      }

      rows.push({
        file: name,
        index,
        role: box.role,
        name: box.name,
        boundsSig: box.boundsSig,
        ps: primary?.ps ?? '',
        family: primary?.family ?? '',
        style: primary?.style ?? '',
        size,
        sizes,
        isSource: source,
        groupMode,
        issues,
      })
    })
  }

  return {
    files: files.length,
    contentBoxes,
    labelBoxes,
    sourcePsNames,
    contentFonts: [...contentFontCounts.values()].sort((a, b) => b.count - a.count),
    distinctSizes: [...allSizes].sort((a, b) => a - b),
    sizeIssues,
    metaIssues,
    rows,
    presentations,
  }
}

/** A short readable snippet of a document's slide text, for the picker. */
function presentationPreview(doc: ProDoc): string {
  const parts: string[] = []
  for (const box of doc.boxes) {
    if (box.role !== 'content') continue
    const t = boxText(box).trim()
    if (t) parts.push(t)
    if (parts.join(' ').length >= 40) break
  }
  const joined = parts.join(' · ')
  return joined.length > 40 ? joined.slice(0, 40) + '…' : joined
}

// ---------------------------------------------------------------------------
// fix planning
// ---------------------------------------------------------------------------

export function buildPlan(files: FileEntry[], config: FixConfig): FixEdit[] {
  const sourceSet = new Set(config.sourcePsNames)
  // `undefined` selection = every document; otherwise only the named entries.
  const selected = config.selectedFiles ? new Set(config.selectedFiles) : null
  const edits: FixEdit[] = []

  for (const { name, doc } of files) {
    if (selected && !selected.has(name)) continue
    const modes =
      config.sizePolicy === 'file-mode' || config.sizePolicy === 'box-group'
        ? groupModes(doc, sourceSet, config.sizePolicy)
        : null
    doc.boxes.forEach((box, index) => {
      if (!isSource(box, sourceSet)) return
      const primary = boxFont(box)
      if (!primary) return
      const curSize = boxSize(box)
      // the box's own fonts that are in the source set — the edit touches only these
      const fromNames = [...new Set(box.descriptors.map((d) => d.ps).filter((ps) => sourceSet.has(ps)))]
      // Representative *source* run (the edit only ever touches source runs).
      // Drives the swap-vs-meta decision and the shown diff, so the outcome
      // doesn't depend on which descriptor happens to be first in a mixed box.
      const src = box.descriptors.find((d) => sourceSet.has(d.ps)) ?? primary

      // --- font ---
      let setFont: FontOption | null = null
      let fixMeta = false
      let afterPs = src.ps
      let afterFamily = src.family
      let afterStyle = src.style
      // A font swap is only warranted when a source run's font actually differs
      // from the target. When every source run already uses the target ps, take
      // the metadata path instead — the swap path would also rewrite `style`
      // from the target's (possibly guessed) value.
      const needsSwap = fromNames.some((ps) => ps !== config.targetFont.ps)
      if (config.remapFont && needsSwap) {
        setFont = config.targetFont
        afterPs = config.targetFont.ps
        afterFamily = config.targetFont.family
        afterStyle = config.targetFont.style
      } else if (config.fixFamilyMeta) {
        const canonical = canonicalFamily(src.ps, src.family)
        if (canonical !== src.family) {
          fixMeta = true
          afterFamily = canonical
        }
      }

      // --- scripture verse layout ---
      // Gated on the box's primary (base) font being a source font: the
      // rebuild writes every run in the base font, so a box whose base is
      // some other font must not be rebuilt (it would defeat a remap).
      const scripture =
        config.scriptureReformat && primary && sourceSet.has(primary.ps)
          ? planScripture(box, doc.boxes, doc.canvasH)
          : null

      // --- size ---
      let setSize: number | null = null
      let afterSize = curSize
      if (scripture) {
        // the rebuild owns this box's sizes; show the on-screen (effective) size
        afterSize = scripture.effectivePt
      } else if (modes) {
        const m = modes.get(groupKey(box, config.sizePolicy))
        if (m != null && curSize != null && m !== curSize) {
          setSize = m
          afterSize = m
        }
      } else if (config.sizePolicy === 'global') {
        if (curSize !== config.globalSize) {
          setSize = config.globalSize
          afterSize = config.globalSize
        }
      }

      if (setFont || fixMeta || setSize != null || scripture) {
        edits.push({
          file: name,
          index,
          box,
          fromNames,
          before: { ps: src.ps, family: src.family, style: src.style, size: curSize },
          after: { ps: afterPs, family: afterFamily, style: afterStyle, size: afterSize },
          setFont,
          fixMeta,
          setSize,
          scripture,
        })
      }
    })
  }
  return edits
}
