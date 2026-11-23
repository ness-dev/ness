/** Inline code or a key chord in body copy. `as="kbd"` for shortcuts. */
export function InlineCode({ children, as: Tag = 'code' }: { children: string; as?: 'code' | 'kbd' }) {
  return <Tag className="font-mono text-[0.85em] text-ink-300 bg-ink-850 px-1 py-px rounded">{children}</Tag>
}
