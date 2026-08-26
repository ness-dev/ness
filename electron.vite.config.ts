import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { execSync } from 'child_process'

// Captured once at vite startup. Restart `npm run dev` after switching
// branches if you want the title to update.
function currentGitBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'ignore']
    })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

const DEV_BRANCH = currentGitBranch()

// Opt-in, because the profiling build is not free. React 19.2's profiling
// entry emits a performance.measure() per component render to populate the
// DevTools Performance track, and in a trace of a loaded session that logging
// — logComponentRender + logComponentEffect + the performance.now() calls
// feeding them — was ~15% of total renderer CPU, alongside 21k retained
// PerformanceMeasure objects in a heap snapshot taken while nothing was
// recording. That is a permanent tax on every user to populate a counter that
// only matters while someone is actively debugging. Build with
// HARNESS_REACT_PROFILING=1 to get reactCommits back; otherwise samples carry
// reactProfiling:false and consumers render "n/a" rather than a zero that
// reads as "React is idle" — the exact misreading that cost two prior
// investigations.
const REACT_PROFILING = process.env.HARNESS_REACT_PROFILING === '1'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      rollupOptions: {
        // index.ts loads desktop-shell via runtime require() under
        // `if (runtime === 'electron')` so the headless build doesn't
        // pull electron in. The bundler can't see that require, so the
        // shell needs an explicit entry to land in out/main next to
        // index.js where the require can find it at runtime.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'desktop-shell': resolve(__dirname, 'src/main/desktop-shell.ts')
        },
        external: ['electron', 'node-pty'],
        output: {
          format: 'cjs',
          // Stable output filenames so `require('./desktop-shell')`
          // resolves the way it would after a fresh `npm run build`.
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      rollupOptions: {
        external: ['electron']
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    define: {
      __HARNESS_DEV_BRANCH__: JSON.stringify(DEV_BRANCH),
      __HARNESS_REACT_PROFILING__: JSON.stringify(REACT_PROFILING)
    },
    resolve: {
      // React's production build compiles out `enableProfilerTimer`, so
      // <Profiler>'s onRender is never called and rendererPerf's reactCommits
      // reads 0 in every packaged build — `react-dom-client.production.js`
      // contains zero occurrences of `onRender`. That is why the alias exists
      // at all: `react=0c/0ms` was a measurement artifact in 100% of ~1,800
      // renderer samples and sent two separate perf investigations looking at
      // the main process. Under HARNESS_REACT_PROFILING=1 the numbers are real;
      // by default nothing pretends to measure them.
      //
      // ONLY the client entry is swapped. Do not add a bare `react-dom` alias:
      // react-dom-profiling.profiling.js itself does require("react-dom") to
      // reach ReactDOMSharedInternals, so aliasing the bare specifier points
      // that lookup back at the profiling build and the cycle leaves the
      // internals undefined — the app dies at startup on `reading 'd'`.
      // Bare `react-dom` (createPortal in WorkspaceView) must keep resolving
      // to the real package; it carries no second copy of the reconciler.
      //
      // Anchored regex, not a bare string: alias `find` also matches on a `/`
      // prefix, so a plain 'react-dom' key would additionally rewrite
      // `react-dom/server` to `react-dom/profiling/server`.
      alias: REACT_PROFILING
        ? [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }]
        : []
    },
    build: {
      ssr: false
    }
  }
})
