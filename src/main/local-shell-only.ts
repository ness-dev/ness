import type { RequestHandler } from '../shared/transport/transport'

/** Wraps a request handler so it only answers the local Electron window.
 *
 *  Main registers handlers on a compound IPC+WS transport, so anything
 *  that reaches the network listener can call any channel. Some channels
 *  serve state that belongs to this machine's desktop shell — saved remote
 *  connections and their tokens — and must not leak to a WS client. */
export function localShellOnly(name: string, handler: RequestHandler): RequestHandler {
  return (ctx, ...args) => {
    if (ctx.via !== 'ipc') throw new Error(`${name} is only available to the local Ness window`)
    return handler(ctx, ...args)
  }
}
