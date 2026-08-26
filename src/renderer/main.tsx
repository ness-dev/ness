import './styles.css'
import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initStore } from './store'
import { getBackend } from './backend'
import { defineHarnessTheme } from './monaco-setup'
import { rendererPerf } from './renderer-perf'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LinuxWindowControls } from './components/LinuxWindowControls'

// Counter bump only. The previous version compared every commit against a
// 16ms budget and fired an IPC when it lost — which both put telemetry in the
// commit hot path and missed the failure mode where hundreds of individually
// cheap commits ruin a second. rendererPerf aggregates instead.
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  rendererPerf.recordCommit(actualDuration)
}

// Without the react-dom/profiling alias onRender is never called, so mounting
// <Profiler> would only add tree depth for a counter that stays 0.
// See electron.vite.config.ts for why the alias is opt-in.
const reactProfiling =
  typeof __HARNESS_REACT_PROFILING__ !== 'undefined' && __HARNESS_REACT_PROFILING__
if (reactProfiling) rendererPerf.markReactProfilingEnabled()

function withProfiler(children: ReactNode): ReactNode {
  if (!reactProfiling) return children
  return (
    <Profiler id="app" onRender={onRender}>
      {children}
    </Profiler>
  )
}

initStore()
  .then(() => {
    defineHarnessTheme()
    rendererPerf.start((sample) => getBackend().perfReportRendererSample(sample))
    createRoot(document.getElementById('root')!).render(
      <ErrorBoundary label="app:root" showReload>
        {withProfiler(<App />)}
        <LinuxWindowControls />
      </ErrorBoundary>
    )
  })
  .catch((err) => {
    // initStore awaits the first WS request in the web client (the
    // single backend's transport is WebSocketClientTransport). A
    // connection failure surfaces here as a rejected promise. In local
    // Electron mode the ElectronClientTransport's getStateSnapshot is
    // an in-process IPC call and only fails if main itself is broken —
    // same fallback UI is fine for both paths.
    showBootError(err)
  })

function showBootError(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[harness] boot failed', err)
  const message = err instanceof Error ? err.message : String(err)
  const isRemote = window.__HARNESS_WEB__ === true
  const root = document.getElementById('root')
  if (!root) return
  root.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.style.cssText =
    'padding:32px;max-width:640px;margin:64px auto;font-family:system-ui,sans-serif;color:#e5e5e5;background:#1a1a1a;border:1px solid #333;border-radius:8px;'
  const title = document.createElement('h1')
  title.style.cssText = 'font-size:18px;margin:0 0 12px 0;color:#ff6b6b;'
  title.textContent = isRemote ? 'Remote connection failed' : 'Ness failed to start'
  wrap.appendChild(title)
  const body = document.createElement('p')
  body.style.cssText = 'margin:0 0 16px 0;line-height:1.5;'
  body.textContent = isRemote
    ? 'Could not reach the remote harness-server. Check that the server is running and the URL/token are correct, then restart the app.'
    : 'The local Ness backend did not respond. Check the debug log and restart the app.'
  wrap.appendChild(body)
  const details = document.createElement('pre')
  details.style.cssText =
    'background:#0a0a0a;padding:12px;border-radius:4px;font-size:12px;overflow:auto;color:#aaa;'
  details.textContent = message
  wrap.appendChild(details)
  root.appendChild(wrap)
}
