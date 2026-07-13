// Validates the ProPresenter model + analyzer against the real playlist.
// Skipped when .local-fixtures/*.proPlaylist is absent.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { ProDoc } from '../src/lib/proDoc'
import { analyze, type FileEntry } from '../src/lib/analyzer'

const FIXTURE_DIR = join(__dirname, '..', '.local-fixtures')
function findPlaylist(): string | null {
  if (!existsSync(FIXTURE_DIR)) return null
  const f = readdirSync(FIXTURE_DIR).sort().find((n) => n.endsWith('.proPlaylist'))
  return f ? join(FIXTURE_DIR, f) : null
}
const playlistPath = findPlaylist()
const maybe = playlistPath ? describe : describe.skip

async function loadFiles(): Promise<FileEntry[]> {
  const zip = await JSZip.loadAsync(readFileSync(playlistPath!))
  const entries: FileEntry[] = []
  for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.pro'))) {
    const bytes = await zip.files[name].async('uint8array')
    entries.push({ name, doc: new ProDoc(bytes) })
  }
  return entries
}

maybe('analyzer on real playlist', () => {
  it('finds content boxes and matches the observed inconsistencies', async () => {
    const files = await loadFiles()
    const report = analyze(files)

    // eslint-disable-next-line no-console
    console.log('\n=== PLAYLIST REPORT ===')
    console.log('files:', report.files, 'content boxes:', report.contentBoxes, 'labels:', report.labelBoxes)
    console.log('detected source fonts:', report.sourcePsNames)
    console.log('content fonts:', report.contentFonts)
    console.log('distinct content+label sizes:', report.distinctSizes)
    console.log('size issues (file-mode):', report.sizeIssues, 'meta issues:', report.metaIssues)

    // Per-file: mode target and the distinct source sizes present.
    console.log('\n--- per-file source sizes -> file mode ---')
    const byFile = new Map<string, { sizes: number[]; mode: number | null }>()
    for (const r of report.rows.filter((r) => r.isSource && r.size != null)) {
      if (!byFile.has(r.file)) byFile.set(r.file, { sizes: [], mode: r.groupMode })
      byFile.get(r.file)!.sizes.push(r.size!)
    }
    for (const [file, info] of byFile) {
      const distinct = [...new Set(info.sizes)].sort((a, b) => a - b)
      const flag = distinct.length > 1 ? '  <-- MIXED' : ''
      console.log(`${file.slice(0, 22).padEnd(22)} mode=${info.mode} sizes=${JSON.stringify(distinct)}${flag}`)
    }

    // Assertions grounded in the Python reconnaissance:
    expect(report.files).toBe(22)
    expect(report.contentBoxes).toBeGreaterThan(0)
    // The brand lyric font is the dominant content font.
    expect(report.sourcePsNames[0]).toBe('Tensentype-RuiHeiJ-W4')
    // Sizes seen ranged widely (84..200 among content).
    expect(Math.max(...report.distinctSizes)).toBeGreaterThanOrEqual(175)
    // There are real inconsistencies to fix.
    expect(report.sizeIssues + report.metaIssues).toBeGreaterThan(0)
  })
})
