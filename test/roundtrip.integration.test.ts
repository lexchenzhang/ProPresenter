// Integration test against the real church playlist. The file lives in
// .local-fixtures/ (gitignored) and is NOT committed. When it is absent (CI,
// fresh clone) the suite is skipped rather than failing.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
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

maybe('real playlist round-trip', () => {
  it('decode∘encode is byte-identical for every .pro document', async () => {
    const zip = await JSZip.loadAsync(readFileSync(playlistPath!))
    const proEntries = Object.keys(zip.files).filter((n) => n.endsWith('.pro'))
    expect(proEntries.length).toBeGreaterThan(0)

    for (const name of proEntries) {
      const original = await zip.files[name].async('uint8array')
      const round = encode(decode(original))
      expect(bytesEqual(round, original), `round-trip mismatch: ${name}`).toBe(true)
    }
  })
})
