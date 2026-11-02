export type FileListView = 'list' | 'tree'

export interface TreeNode {
  name: string
  path: string
  /** Keyed by name, with a trailing "/" on dirs. */
  children?: Map<string, TreeNode>
  isFile: boolean
}

/** Dirs get a trailing "/" in their key so a file and a dir can share a
 *  name — e.g. a deleted file `foo` alongside a new `foo/bar` in a diff. */
export function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), isFile: false }
  for (const file of files) {
    const parts = file.split('/')
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      if (!node.children) node.children = new Map()
      const key = isLast ? part : `${part}/`
      let child = node.children.get(key)
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          isFile: isLast,
          children: isLast ? undefined : new Map()
        }
        node.children.set(key, child)
      }
      node = child
    }
  }
  return root
}

export function sortChildren(node: TreeNode): TreeNode[] {
  if (!node.children) return []
  return Array.from(node.children.values()).sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}
