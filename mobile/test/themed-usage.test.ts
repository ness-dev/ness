// themed() returns a Proxy that only answers property reads. Read styles
// out of a themed StyleSheet map (`st.x`); never pass a themed object
// itself as a `style` — React freezes and enumerates styles, the Proxy
// enumerates nothing, and the style silently disappears (text fell back to
// iOS's default black on dark themes).
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []
  })
}

describe('themed() objects', () => {
  it('are never passed directly as a style', () => {
    const offenders: string[] = []
    for (const f of files(join(__dirname, '../src'))) {
      const src = readFileSync(f, 'utf8')
      // Plain-object themed() values (lookup tables are fine: they're read
      // by key); StyleSheet maps are read by property, also fine.
      for (const m of src.matchAll(/const (\w+)(?:\s*:[^=]+)? = themed\(\(\) => \(\{/g)) {
        const name = m[1]
        if (new RegExp(`style=\\{\\[?${name}[,}\\]]`).test(src)) offenders.push(`${f}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
