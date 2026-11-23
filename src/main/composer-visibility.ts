/** Which clients currently have each chat's composer on screen. Drives
 *  pausing Claude's prompt suggestions: a chat no client is looking at
 *  shouldn't pay for a suggestion generation every turn.
 *
 *  Not slice state — every client reports only its own view, and nothing
 *  but main acts on the union. */
export class ComposerVisibility {
  private readonly viewers = new Map<string, Set<string>>()

  isVisible(sessionId: string): boolean {
    return (this.viewers.get(sessionId)?.size ?? 0) > 0
  }

  /** Records one client's view of one chat. Returns the chat's overall
   *  visibility when it flipped, otherwise null. */
  set(clientId: string, sessionId: string, visible: boolean): boolean | null {
    const before = this.isVisible(sessionId)
    let set = this.viewers.get(sessionId)
    if (visible) {
      if (!set) this.viewers.set(sessionId, (set = new Set()))
      set.add(clientId)
    } else if (set) {
      set.delete(clientId)
      if (set.size === 0) this.viewers.delete(sessionId)
    }
    const after = this.isVisible(sessionId)
    return before === after ? null : after
  }

  /** Forgets a disconnected client. Returns the chats nobody is viewing
   *  any more. */
  removeClient(clientId: string): string[] {
    const hidden: string[] = []
    for (const [sessionId, set] of this.viewers) {
      if (!set.delete(clientId)) continue
      if (set.size === 0) {
        this.viewers.delete(sessionId)
        hidden.push(sessionId)
      }
    }
    return hidden
  }
}
