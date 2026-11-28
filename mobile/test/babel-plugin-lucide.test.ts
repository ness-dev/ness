import { describe, expect, it } from 'vitest'
// require: @babel/core ships no types and isn't worth a @types dep here.
/* eslint-disable @typescript-eslint/no-require-imports */
const { transformSync } = require('@babel/core') as { transformSync: (code: string, opts: object) => { code: string } | null }
const plugin = require('../babel-plugin-lucide.js')
/* eslint-enable @typescript-eslint/no-require-imports */

const run = (code: string) => transformSync(code, { plugins: [plugin], babelrc: false, configFile: false })!.code!

describe('babel-plugin-lucide', () => {
  it('turns a lucide-react-native barrel import into per-icon imports', () => {
    const out = run(`import { ArrowUp, Loader2 as Spinner } from 'lucide-react-native'`)
    expect(out).toContain(`import ArrowUp from "lucide-react-native/icons/arrow-up"`)
    expect(out).toContain(`import Spinner from "lucide-react-native/icons/loader-2"`)
    expect(out).not.toMatch(/from "lucide-react-native"/)
  })

  it('wraps the desktop modules\' lucide-react icons with the shim\'s wrapIcon', () => {
    const out = run(`import { FileText } from 'lucide-react'\nimport x from 'y'\nexport const A = () => FileText`)
    expect(out).toMatch(/import _FileText from "lucide-react-native\/icons\/file-text"/)
    expect(out).toMatch(/import \{ wrapIcon as _wrapIcon \} from "lucide-react"/)
    // Declared after the last import, under a name React Refresh won't
    // register, with references renamed.
    const decl = out.indexOf('const _lucide_FileText = _wrapIcon("FileText", _FileText)')
    expect(decl).toBeGreaterThan(out.indexOf('import x from "y"'))
    expect(out).toContain('export const A = () => _lucide_FileText')
  })

  it('survives the CommonJS transform Metro runs afterwards', () => {
    // Reusing one identifier node across calls left all but the first
    // pointing at an undeclared `_wrapIcon` once imports became requires.
    const out = transformSync(`import { Bell, Bot } from 'lucide-react'\nexport const A = [Bell, Bot]`, {
      plugins: [plugin, require.resolve('@babel/plugin-transform-modules-commonjs', { paths: [__dirname] })],
      babelrc: false,
      configFile: false
    })!.code
    expect(out.match(/\(0, _lucideReact\.wrapIcon\)\(/g)).toHaveLength(2)
    expect(out).not.toMatch(/[^.]_wrapIcon\(/)
  })

  it('maps every icon the shared tool-icons module imports to a file', () => {
    // Fails the build (not at runtime) if a desktop icon has no RN file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/renderer/components/json-mode-cards/tool-icons.tsx'), 'utf8') as string
    const names = /import \{([^}]*)\} from 'lucide-react'/.exec(src)![1].split(',').map((s) => s.trim()).filter(Boolean)
    expect(names.length).toBeGreaterThan(10)
    for (const n of names) expect(plugin.fileFor(n), n).not.toBeNull()
  })

  it('rejects namespace and default imports, which would need the whole library', () => {
    expect(() => run(`import * as L from 'lucide-react-native'`)).toThrow(/only named imports/)
    expect(() => run(`import L, { X } from 'lucide-react-native'`)).toThrow(/only named imports/)
  })
})
