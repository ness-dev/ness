// Rewrites named lucide imports to one module per icon, so the bundle
// carries only the icons the app uses instead of all ~1,700 of them.
// Metro doesn't tree-shake, so a barrel import pulls in every icon.
//
//   import { Loader2 } from 'lucide-react-native'
//     → import Loader2 from 'lucide-react-native/icons/loader-2'
//
// The desktop modules reused from ../src import from 'lucide-react' and
// pass `className`. Metro maps that specifier to src/shims/lucide-react.js,
// which only exports wrapIcon now, and the wrapping happens here:
//
//   import { FileText } from 'lucide-react'
//     → import _FileText from 'lucide-react-native/icons/file-text'
//       import { wrapIcon } from 'lucide-react'
//       const _lucide_FileText = wrapIcon('FileText', _FileText)
//       (and every FileText reference renamed to match)
//
// Desktop never runs this plugin; its source is unchanged.
const fs = require('fs')
const path = require('path')

// The package's exports map hides package.json; resolve from this file instead.
const ICONS_DIR = path.join(__dirname, 'node_modules/lucide-react-native/dist/esm/icons')
const NATIVE = 'lucide-react-native'
const SHIMMED = 'lucide-react'

// ArrowUp → arrow-up, Loader2 → loader-2 (lucide ships alias files too).
// Irregular names (Grid2X2 is grid-2x2) don't fit the rule, so check the
// file exists and fail the build rather than import an undefined icon.
function fileFor(name) {
  const base = name.replace(/Icon$/, '').replace(/^Lucide/, '')
  const kebab = base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
    .toLowerCase()
  return fs.existsSync(path.join(ICONS_DIR, `${kebab}.mjs`)) ? kebab : null
}

module.exports = function lucidePerIcon({ types: t }) {
  return {
    name: 'lucide-per-icon',
    visitor: {
      ImportDeclaration(p) {
        const source = p.node.source.value
        if (source !== NATIVE && source !== SHIMMED) return
        if (p.node.importKind === 'type' || p.node._lucideGenerated) return
        const named = p.node.specifiers.filter((s) => t.isImportSpecifier(s) && s.importKind !== 'type')
        if (named.length !== p.node.specifiers.length) {
          throw p.buildCodeFrameError(`lucide-per-icon: only named imports from '${source}' are supported`)
        }
        const imports = []
        const wraps = []
        for (const s of named) {
          const exported = t.isIdentifier(s.imported) ? s.imported.name : s.imported.value
          const file = fileFor(exported)
          if (!file) throw p.buildCodeFrameError(`lucide-per-icon: no icon file for '${exported}' in ${NATIVE}`)
          const spec = `${NATIVE}/icons/${file}`
          if (source === NATIVE) {
            imports.push(t.importDeclaration([t.importDefaultSpecifier(t.identifier(s.local.name))], t.stringLiteral(spec)))
          } else {
            // The wrapped binding gets a `_`-prefixed name: React Refresh
            // registers any capitalized `const X = call()` as a component,
            // and on these inserted declarations it references a `_cN`
            // variable it never declares (dev bundles crash at load).
            // JSX still treats `_name` tags as components.
            const local = p.scope.generateUidIdentifier(`lucide_${exported}`)
            p.scope.rename(s.local.name, local.name)
            const raw = p.scope.generateUidIdentifier(exported)
            imports.push(t.importDeclaration([t.importDefaultSpecifier(raw)], t.stringLiteral(spec)))
            wraps.push({ local: local.name, exported, raw })
          }
        }
        if (wraps.length > 0) {
          const wrapId = p.scope.generateUidIdentifier('wrapIcon')
          const wrapImport = t.importDeclaration([t.importSpecifier(wrapId, t.identifier('wrapIcon'))], t.stringLiteral(SHIMMED))
          // Babel visits replacement nodes; this one must stay as written.
          wrapImport._lucideGenerated = true
          imports.push(wrapImport)
          // Declared after the program's last import so every binding exists.
          const program = p.parentPath
          const lastImport = program.get('body').filter((b) => b.isImportDeclaration()).pop()
          const decls = wraps.map((w) =>
            t.variableDeclaration('const', [
              t.variableDeclarator(t.identifier(w.local), t.callExpression(t.cloneNode(wrapId), [t.stringLiteral(w.exported), t.cloneNode(w.raw)]))
            ])
          )
          ;(lastImport ?? p).insertAfter(decls)
        }
        p.replaceWithMultiple(imports)
      }
    }
  }
}

module.exports.fileFor = fileFor
