// End-to-end fix against the real playlist. Skipped without .local-fixtures.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { ProDoc } from '../src/lib/proDoc'
import { analyze, type FileEntry } from '../src/lib/analyzer'
import { buildDocs, defaultConfig, applyPlan, serializeChangedDocs } from '../src/lib/fixer'
import { loadPlaylist, savePlaylist } from '../src/lib/playlist'
import { decode, encode } from '../src/lib/protobuf'

const FIXTURE_DIR = join(__dirname, '..', '.local-fixtures')
function findPlaylist(): string | null {
  if (!existsSync(FIXTURE_DIR)) return null
  const f = readdirSync(FIXTURE_DIR).sort().find((n) => n.endsWith('.proPlaylist'))
  return f ? join(FIXTURE_DIR, f) : null
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
const playlistPath = findPlaylist()
const maybe = playlistPath ? describe : describe.skip

async function proEntries(input: Blob | Buffer): Promise<Map<string, Uint8Array>> {
  const data =
    input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : new Uint8Array(input)
  const zip = await JSZip.loadAsync(data)
  const out = new Map<string, Uint8Array>()
  for (const name of Object.keys(zip.files)) {
    if (!zip.files[name].dir) out.set(name, await zip.files[name].async('uint8array'))
  }
  return out
}

maybe('end-to-end fix', () => {
  it('serialize after full parse is byte-identical (tree round-trips through expansion)', async () => {
    const zip = await JSZip.loadAsync(readFileSync(playlistPath!))
    for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.pro'))) {
      const bytes = await zip.files[name].async('uint8array')
      const doc = new ProDoc(bytes) // constructor walks + expands much of the tree
      expect(bytesEqual(doc.serialize(), bytes), `serialize drift: ${name}`).toBe(true)
    }
  })

  it('applies the default fix to selected presentations and normalizes the brand font', async () => {
    const raw = readFileSync(playlistPath!)
    const before = await proEntries(raw)

    // analyze + fix — select EVERY presentation to exercise the full normalize.
    // scriptureReformat is off here: this test pins the font/metadata path's
    // "sizes untouched" invariant; the verse-box rebuild has its own suite.
    const pl = await loadPlaylist(new Uint8Array(raw), 'test.proPlaylist')
    const { files, failed } = await buildDocs(pl)
    expect(failed).toEqual([])
    const report = analyze(files)
    const config = {
      ...defaultConfig(report),
      selectedFiles: files.map((f) => f.name),
      scriptureReformat: false,
    }
    const { buildPlan } = await import('../src/lib/analyzer')
    const plan = buildPlan(files, config)
    expect(plan.length).toBeGreaterThan(0)

    // capture content sizes before applying (multiset)
    const sizesBefore = report.rows
      .filter((r) => r.role === 'content' && r.size != null)
      .map((r) => r.size)
      .sort()

    applyPlan(plan)
    const updated = serializeChangedDocs(files, plan)
    const outBlob = await savePlaylist(pl, updated)
    const after = await proEntries(outBlob)

    // 1) same set of entry names
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())

    // 2) non-.pro entries are content-identical
    for (const [name, bytes] of before) {
      if (name.endsWith('.pro')) continue
      expect(bytesEqual(after.get(name)!, bytes), `non-pro changed: ${name}`).toBe(true)
    }

    // 3) every output .pro still decodes and round-trips
    const outFiles: FileEntry[] = []
    for (const [name, bytes] of after) {
      if (!name.endsWith('.pro')) continue
      expect(bytesEqual(encode(decode(bytes)), bytes), `output not canonical: ${name}`).toBe(true)
      outFiles.push({ name, doc: new ProDoc(bytes) })
    }

    // 4) re-analyze the OUTPUT. The brand font's PostScript name is unchanged
    // (target ps == source ps), so it is still present — but its family
    // metadata is now the canonical display name everywhere and clean.
    const after2 = analyze(outFiles)
    const brand = after2.rows.filter(
      (r) => r.role === 'content' && r.ps === 'Tensentype-RuiHeiJ-W4',
    )
    expect(brand.length).toBeGreaterThan(0)
    for (const r of brand) {
      expect(r.family, `family not normalized in ${r.file}#${r.index}`).toBe(
        'Tensentype RuiHei GB18030 W4',
      )
    }
    expect(after2.metaIssues).toBe(0)

    // 4b) multi-font RTF tables keep their non-target entries (the blocking-bug guard):
    // any fallback font present in the input must still be present in the output.
    const dec = new TextDecoder('latin1')
    const fallbacks = ['AppleColorEmoji', 'ArialMT', 'HelveticaNeue']
    for (const fb of fallbacks) {
      const inHad = [...before].some(([n, b]) => n.endsWith('.pro') && dec.decode(b).includes(fb))
      if (inHad) {
        const outHas = [...after].some(([n, b]) => n.endsWith('.pro') && dec.decode(b).includes(fb))
        expect(outHas, `fallback font "${fb}" was clobbered`).toBe(true)
      }
    }

    // 5) sizes untouched (multiset identical)
    const sizesAfter = after2.rows
      .filter((r) => r.role === 'content' && r.size != null)
      .map((r) => r.size)
      .sort()
    expect(sizesAfter).toEqual(sizesBefore)

    // eslint-disable-next-line no-console
    console.log(
      `fixed ${updated.size} files, ${plan.length} boxes normalized -> family "${config.targetFont.family}"; sizes unchanged`,
    )
  })

  it('scopes the fix to only the selected presentations (宣召 + 读经)', async () => {
    const raw = readFileSync(playlistPath!)
    const before = await proEntries(raw)

    const pl = await loadPlaylist(new Uint8Array(raw), 'test.proPlaylist')
    const { files } = await buildDocs(pl)
    const report = analyze(files)

    // 宣召 lives in "1 5.pro" (the word is only in its slide text, not its name);
    // 读经 is "7-1. 读经.pro". Both exist in the fixture.
    const selectedFiles = ['1 5.pro', '7-1. 读经.pro']
    for (const f of selectedFiles) {
      expect(files.some((x) => x.name === f), `missing fixture entry: ${f}`).toBe(true)
    }

    const config = { ...defaultConfig(report), selectedFiles }
    const { buildPlan } = await import('../src/lib/analyzer')
    const plan = buildPlan(files, config)
    expect(plan.length).toBeGreaterThan(0)
    // every edit belongs to a selected file
    expect([...new Set(plan.map((e) => e.file))].sort()).toEqual([...selectedFiles].sort())

    applyPlan(plan)
    const updated = serializeChangedDocs(files, plan)
    const outBlob = await savePlaylist(pl, updated)
    const after = await proEntries(outBlob)

    // Only the selected .pro documents may differ; everything else is byte-identical.
    for (const [name, bytes] of before) {
      if (selectedFiles.includes(name)) continue
      expect(bytesEqual(after.get(name)!, bytes), `unselected entry changed: ${name}`).toBe(true)
    }
    // The selected documents actually changed.
    for (const name of selectedFiles) {
      expect(bytesEqual(after.get(name)!, before.get(name)!), `selected entry unchanged: ${name}`).toBe(
        false,
      )
    }
  })
})
