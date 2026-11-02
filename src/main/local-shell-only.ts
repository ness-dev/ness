import type { RequestHandler, SignalHandler } from '../shared/transport/transport'

/** Channel prefixes that only the local Electron window may call: this
 *  machine's saved remote connections (tokens included) and the SSH flows
 *  that create, reconnect, and upgrade them using the user's keys.
 *
 *  Matched by prefix and applied by `CompoundServerTransport` itself — to
 *  requests and signals alike — so a new channel under either prefix is
 *  guarded without anyone remembering to wrap it. */
const LOCAL_SHELL_ONLY_PREFIXES = ['connections:', 'ssh:'] as const

export function isLocalShellOnly(name: string): boolean {
  return LOCAL_SHELL_ONLY_PREFIXES.some((p) => name.startsWith(p))
}

/** Wraps a request handler so it only answers the local Electron window.
 *
 *  Main registers handlers on a compound IPC+WS transport, so anything
 *  that reaches the network listener can call any channel. */
export function localShellOnly(name: string, handler: RequestHandler): RequestHandler {
  return (ctx, ...args) => {
    if (ctx.via !== 'ipc') throw new Error(`${name} is only available to the local Ness window`)
    return handler(ctx, ...args)
  }
}

/** Signal counterpart of `localShellOnly`. Signals are fire-and-forget,
 *  so there's no caller to throw back to — a WS signal is dropped. */
export function localShellOnlySignal(handler: SignalHandler): SignalHandler {
  return (ctx, ...args) => {
    if (ctx.via !== 'ipc') return
    handler(ctx, ...args)
  }
}
