import { describe, expect, it } from 'vitest'
import { buildTree, sortChildren, type TreeNode } from './file-tree'

function shape(node: TreeNode): unknown {
  return node.isFile ? node.path : { [node.name]: sortChildren(node).map(shape) }
}

describe('buildTree', () => {
  it('nests files under their directories', () => {
    const root = buildTree(['src/a.ts', 'src/lib/b.ts', 'README.md'])
    expect(sortChildren(root).map(shape)).toEqual([
      { src: [{ lib: ['src/lib/b.ts'] }, 'src/a.ts'] },
      'README.md'
    ])
  })

  it('records full paths on dirs', () => {
    const root = buildTree(['a/b/c.ts'])
    const a = root.children!.get('a/')!
    expect(a.path).toBe('a')
    expect(a.isFile).toBe(false)
    expect(a.children!.get('b/')!.path).toBe('a/b')
  })

  it('keeps a file and a dir that share a name', () => {
    for (const files of [['foo', 'foo/bar'], ['foo/bar', 'foo']]) {
      const root = buildTree(files)
      expect(sortChildren(root).map(shape)).toEqual([{ foo: ['foo/bar'] }, 'foo'])
    }
  })

  it('returns an empty root for no files', () => {
    expect(sortChildren(buildTree([]))).toEqual([])
  })
})

describe('sortChildren', () => {
  it('sorts dirs before files, then alphabetically', () => {
    const root = buildTree(['z.ts', 'b/x.ts', 'a.ts', 'a/y.ts'])
    expect(sortChildren(root).map((c) => c.name)).toEqual(['a', 'b', 'a.ts', 'z.ts'])
  })

  it('returns nothing for a file node', () => {
    const root = buildTree(['a.ts'])
    expect(sortChildren(root.children!.get('a.ts')!)).toEqual([])
  })
})
