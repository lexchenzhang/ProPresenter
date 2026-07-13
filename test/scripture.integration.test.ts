// Scripture reformat against the real 2026-07-12 playlists: run the fix on the
// problematic ORIGINAL and verify the verse boxes come out shaped like the
// hand-fixed FINAL. Skipped without the .local-fixtures files.
//
// The final playlist's zip has a non-standard central directory JSZip rejects,
// so its two scripture documents are stored as loose .pro fixtures.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { ProDoc, boxText, type TextBox } from '../src/lib/proDoc'
import { analyze, buildPlan } from '../src/lib/analyzer'
import { buildDocs, defaultConfig, applyPlan, serializeChangedDocs } from '../src/lib/fixer'
import { loadPlaylist, savePlaylist } from '../src/lib/playlist'
import { parseVerseLines, readEffectivePt, reformatScripture } from '../src/lib/scripture'
import { decode, readDouble, utf8Decode, type Field } from '../src/lib/protobuf'

const FIXTURE_DIR = join(__dirname, '..', '.local-fixtures')
const ORIGINAL = join(FIXTURE_DIR, '2026-07-12-original.proPlaylist')
const FINAL_DUJING = join(FIXTURE_DIR, '2026-07-12-final [7-1 1].pro')
const FINAL_XUANZHAO = join(FIXTURE_DIR, '2026-07-12-final [1 4].pro')
const SELECTED = ['1 4.pro', '7-1 1.pro'] // 宣召 + 读经

const available = [ORIGINAL, FINAL_DUJING, FINAL_XUANZHAO].every((p) => existsSync(p))
const maybe = available ? describe : describe.skip

/** The scripture verse boxes of a doc (content boxes whose RTF parses as verses). */
function verseBoxes(doc: ProDoc): TextBox[] {
  return doc.boxes.filter(
    (b) =>
      b.role === 'content' &&
      b.rtfNode &&
      parseVerseLines(utf8Decode(b.rtfNode.value as Uint8Array)) !== null,
  )
}

/** Extract the run structure of a box's attributes message, for comparison.
 *  Only valid on freshly parsed (unmutated) documents. */
function runStructure(box: TextBox) {
  const attrsNode = box.textNodes.find((n) => n.field === 3 && n.wire === 2)!
  const attrs = decode(attrsNode.value as Uint8Array)
  const ranges: { start: number; end: number; kind: 'size' | 'font'; value: number }[] = []
  let scale: number | null = null
  for (const f of attrs) {
    if (f.field !== 13 || f.wire !== 2) continue
    const sub = decode(f.value as Uint8Array)
    const rangeF = sub.find((x: Field) => x.field === 1 && x.wire === 2)
    const range = rangeF ? decode(rangeF.value as Uint8Array) : []
    const start = Number(range.find((x: Field) => x.field === 1)?.value ?? 0n)
    const end = Number(range.find((x: Field) => x.field === 2)?.value ?? 0n)
    const scaleF = sub.find((x: Field) => x.field === 4 && x.wire === 1)
    if (scaleF) {
      scale = readDouble(scaleF.value as Uint8Array)
      continue
    }
    const sizeF = sub.find((x: Field) => x.field === 3 && x.wire === 1)
    if (sizeF) ranges.push({ start, end, kind: 'size', value: readDouble(sizeF.value as Uint8Array) })
    const fontF = sub.find((x: Field) => x.field === 12 && x.wire === 2)
    if (fontF) {
      const fsub = decode(fontF.value as Uint8Array)
      const sz = fsub.find((x: Field) => x.field === 2 && x.wire === 1)
      ranges.push({ start, end, kind: 'font', value: sz ? readDouble(sz.value as Uint8Array) : NaN })
    }
  }
  return { scale, ranges }
}

maybe('scripture reformat (2026-07-12 original → final)', () => {
  async function runFix() {
    const raw = readFileSync(ORIGINAL)
    const pl = await loadPlaylist(new Uint8Array(raw), 'original.proPlaylist')
    const { files, failed } = await buildDocs(pl)
    expect(failed).toEqual([])
    const report = analyze(files)
    const config = { ...defaultConfig(report), selectedFiles: SELECTED }
    const plan = buildPlan(files, config)
    applyPlan(plan)
    const updated = serializeChangedDocs(files, plan)
    const blob = await savePlaylist(pl, updated)
    return { raw, plan, blob }
  }

  async function outputDocs(blob: Blob): Promise<Map<string, ProDoc>> {
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()))
    const out = new Map<string, ProDoc>()
    for (const name of SELECTED) out.set(name, new ProDoc(await zip.files[name].async('uint8array')))
    return out
  }

  it('plans a scripture rebuild for exactly the three verse boxes', async () => {
    const raw = readFileSync(ORIGINAL)
    const pl = await loadPlaylist(new Uint8Array(raw), 'original.proPlaylist')
    const { files } = await buildDocs(pl)
    const report = analyze(files)
    const config = { ...defaultConfig(report), selectedFiles: SELECTED }
    const plan = buildPlan(files, config)
    const scriptureEdits = plan.filter((e) => e.scripture)
    expect(scriptureEdits.map((e) => e.file).sort()).toEqual(['1 4.pro', '7-1 1.pro', '7-1 1.pro'])
  })

  it('detection gate: across the WHOLE playlist, only 宣召/读经 verse boxes qualify', async () => {
    // Songs, announcements, creed, prayers etc. must never be rewritten.
    const raw = readFileSync(ORIGINAL)
    const pl = await loadPlaylist(new Uint8Array(raw), 'original.proPlaylist')
    const { files } = await buildDocs(pl)
    const report = analyze(files)
    const config = { ...defaultConfig(report), selectedFiles: undefined } // every document
    const plan = buildPlan(files, config)
    const scriptureFiles = [...new Set(plan.filter((e) => e.scripture).map((e) => e.file))].sort()
    expect(scriptureFiles).toEqual(['1 4.pro', '7-1 1.pro'])
  })

  it('rebuilds the verse boxes to match the hand-fixed final', async () => {
    const { blob } = await runFix()
    const docs = await outputDocs(blob)

    const finals = {
      '7-1 1.pro': new ProDoc(new Uint8Array(readFileSync(FINAL_DUJING))),
      '1 4.pro': new ProDoc(new Uint8Array(readFileSync(FINAL_XUANZHAO))),
    } as const

    for (const name of SELECTED) {
      const ours = verseBoxes(docs.get(name)!)
      const theirs = verseBoxes(finals[name as keyof typeof finals])
      expect(ours.length, `${name}: verse box count`).toBe(theirs.length)

      // Pair up by parsed verse content (the final file lists slides in a
      // different order than the original).
      const byText = new Map(theirs.map((b) => [boxText(b).replace(/\s+/g, ''), b]))
      for (const box of ours) {
        const key = boxText(box).replace(/\s+/g, '')
        const ref = byText.get(key)
        expect(ref, `${name}: no matching final box for "${key.slice(0, 12)}…"`).toBeDefined()

        // identical verse lines in the RTF mirror
        const ourLines = parseVerseLines(utf8Decode(box.rtfNode!.value as Uint8Array))
        const refLines = parseVerseLines(utf8Decode(ref!.rtfNode!.value as Uint8Array))
        expect(ourLines).toEqual(refLines)

        // identical run ranges; sizes near ProPresenter's own fit (the hand
        // edits used slightly different box heights, so allow a small band)
        const ourRuns = runStructure(box)
        const refRuns = runStructure(ref!)
        expect(ourRuns.ranges.map((r) => `${r.kind}:${r.start}-${r.end}`)).toEqual(
          refRuns.ranges.map((r) => `${r.kind}:${r.start}-${r.end}`),
        )
        for (let i = 0; i < ourRuns.ranges.length; i++) {
          expect(
            Math.abs(ourRuns.ranges[i].value - refRuns.ranges[i].value),
            `${name} run ${i} size`,
          ).toBeLessThanOrEqual(0.5)
        }
        expect(ourRuns.scale).not.toBeNull()
        expect(Math.abs(ourRuns.scale! - refRuns.scale!)).toBeLessThanOrEqual(0.005)

        // effective on-screen size close to the hand-fixed one
        expect(Math.abs(readEffectivePt(box)! - readEffectivePt(ref!)!)).toBeLessThanOrEqual(0.5)

        // geometry normalized: verse box reaches the reference bar
        expect(box.boundsY! + box.boundsH!).toBeCloseTo(866, 0)
      }
    }
  })

  it('docks the reference bars at the bottom (y = 866)', async () => {
    const { blob } = await runFix()
    const docs = await outputDocs(blob)
    let refs = 0
    for (const name of SELECTED) {
      for (const box of docs.get(name)!.boxes) {
        if (box.role !== 'content') continue
        if (!/^[一-鿿]{1,8}\s*\d+[:：]\d+/.test(boxText(box).trim())) continue
        expect(box.boundsY, `${name}: reference bar y`).toBeCloseTo(866, 5)
        refs++
      }
    }
    expect(refs).toBe(3)
  })

  it('is idempotent: reformatting the output again changes nothing', async () => {
    const { blob } = await runFix()
    const docs = await outputDocs(blob)
    for (const name of SELECTED) {
      const doc = docs.get(name)!
      const before = doc.serialize()
      for (const box of verseBoxes(doc)) expect(reformatScripture(box)).not.toBeNull()
      expect(Buffer.from(doc.serialize()).equals(Buffer.from(before)), `${name} not idempotent`).toBe(
        true,
      )
    }
  })

  it('leaves every unselected document byte-identical', async () => {
    const { raw, blob } = await runFix()
    const before = await JSZip.loadAsync(new Uint8Array(raw))
    const after = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()))
    for (const name of Object.keys(before.files)) {
      if (before.files[name].dir || SELECTED.includes(name)) continue
      const a = await before.files[name].async('uint8array')
      const b = await after.files[name].async('uint8array')
      expect(Buffer.from(a).equals(Buffer.from(b)), `unselected entry changed: ${name}`).toBe(true)
    }
  })
})
