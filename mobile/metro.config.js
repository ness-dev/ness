// The app imports Ness's reducers, transport and the renderer's pure model
// code (worktree-list-model, merge-backend-states, turn-collapse, …)
// straight from ../src — no copies, so behaviour matches the web client by
// construction. That tree sits outside the project root and the repo isn't
// an npm workspace, so Expo's monorepo auto-config doesn't kick in.
//
// Only DOM-free, React-free modules may be imported from ../src. As a
// backstop, any bare-specifier import that originates outside mobile/ is
// resolved as if from mobile/, so hierarchical lookup can never reach the
// Electron app's ../node_modules and load a second React.
//
// Don't set disableHierarchicalLookup: npm nests some Expo deps
// (expo/node_modules/expo-asset) and the native bundle can't find them.
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const srcRoot = path.resolve(projectRoot, '../src')

// Mermaid diagrams in chat render in a WebView from this page: mermaid's
// own browser build inlined into one HTML file, which Metro ships as an
// asset ('html' is in Expo's assetExts). As an asset rather than a JS
// string it stays out of the main bundle, works offline, and an OTA update
// only re-downloads it when its hash changes. Built here, not committed,
// because it's 3.5MB derived from node_modules; this runs before every
// `expo start` / `expo export` / `eas update`.
function ensureMermaidPage() {
  const fs = require('fs')
  const dist = require.resolve('mermaid/dist/mermaid.min.js', { paths: [projectRoot] })
  const version = require(require.resolve('mermaid/package.json', { paths: [projectRoot] })).version
  const out = path.join(projectRoot, 'generated/mermaid.html')
  const stamp = `<!-- mermaid ${version} -->`
  if (fs.existsSync(out) && fs.readFileSync(out, 'utf8').startsWith(stamp)) return
  const lib = fs.readFileSync(dist, 'utf8').replace(/<\/script/gi, '<\\/script')
  const page = fs.readFileSync(path.join(projectRoot, 'src/components/mermaid-page.html'), 'utf8')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${stamp}\n${page.replace('/*MERMAID*/', () => lib)}`)
}
ensureMermaidPage()

const config = getDefaultConfig(projectRoot)
config.watchFolders = [...(config.watchFolders ?? []), srcRoot]
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')]

// Web-only icon packages used by renderer modules we reuse (tool-display's
// icon registry): served as RN equivalents. See src/shims/.
const SHIMS = {
  'lucide-react': path.join(projectRoot, 'src/shims/lucide-react.js'),
  'react-icons/si': path.join(projectRoot, 'src/shims/react-icons-si.js')
}

const isBare = (name) => !name.startsWith('.') && !path.isAbsolute(name)
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromSrc = context.originModulePath.startsWith(srcRoot + path.sep)
  if (fromSrc && SHIMS[moduleName]) return { type: 'sourceFile', filePath: SHIMS[moduleName] }
  if (isBare(moduleName) && fromSrc) {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(projectRoot, 'package.json') },
      moduleName,
      platform
    )
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
