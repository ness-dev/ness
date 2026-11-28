// Bytes for the soft keyboard and the accessory row. Same table and Ctrl
// mapping as the web client's MobileTerminal, so both phone UIs send the
// PTY exactly what xterm would for a hardware keyboard.

export const KEY_ESC: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F'
}

export function ctrlByte(key: string): string | null {
  const k = key.toLowerCase()
  if (k.length !== 1) return null
  const code = k.charCodeAt(0)
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96)
  if (k === ' ') return '\x00'
  if (k === '[') return '\x1b'
  if (k === '\\') return '\x1c'
  if (k === ']') return '\x1d'
  return null
}

/** Soft-keyboard text → PTY bytes. Newlines become CR (iOS inserts "\n"
 *  for Return in some paths). With sticky Ctrl on, the first character
 *  becomes its control byte; `ctrlUsed` says whether to clear the sticky. */
export function encodeText(text: string, ctrl: boolean): { data: string; ctrlUsed: boolean } {
  let rest = text
  let head = ''
  let ctrlUsed = false
  if (ctrl && text.length > 0) {
    const byte = ctrlByte(text[0])
    if (byte !== null) {
      head = byte
      rest = text.slice(1)
      ctrlUsed = true
    }
  }
  return { data: head + rest.replace(/\r?\n/g, '\r'), ctrlUsed }
}

/** A named key (accessory row, or a keydown from the soft keyboard). */
export function encodeKey(key: string): string {
  return KEY_ESC[key] ?? key
}
