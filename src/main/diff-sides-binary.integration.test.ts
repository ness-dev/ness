import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { execFileSync } from 'child_process'
import { join } from 'path'

import { getCommitFileDiffSides, getCommitRangeFileDiffSides, getFileDiffSides } from './worktree'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
}

let cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.forEach((fn) => fn())
  cleanup = []
})

function makeRepo(): string {
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'diff-sides-'))
  cleanup.push(() => fs.rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t.t')
  git(repo, 'config', 'user.name', 'T')
  fs.writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'seed')
  return repo
}

function commitAll(repo: string, msg: string): string {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', msg)
  return git(repo, 'rev-parse', 'HEAD')
}

const binaryBlob = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0x00, 0x10])

describe('diff sides for binary and oversized files (real git)', () => {
  it('flags a deleted binary file instead of returning its bytes', async () => {
    const repo = makeRepo()
    fs.writeFileSync(join(repo, 'demo.mp4'), binaryBlob)
    commitAll(repo, 'add video')
    fs.rmSync(join(repo, 'demo.mp4'))
    const removed = commitAll(repo, 'remove video')
    fs.appendFileSync(join(repo, 'seed.txt'), 'after\n')
    const after = commitAll(repo, 'after')

    const commit = await getCommitFileDiffSides(repo, removed, 'demo.mp4')
    expect(commit).toMatchObject({ binary: true, original: '', modified: '', originalExists: true, modifiedExists: false })

    const range = await getCommitRangeFileDiffSides(repo, removed, after, 'demo.mp4')
    expect(range).toMatchObject({ binary: true, original: '', modified: '' })

    const staged = await getFileDiffSides(repo, 'seed.txt', true)
    expect(staged.binary).toBe(false)
  })

  it('flags a binary file deleted in the working tree', async () => {
    const repo = makeRepo()
    fs.writeFileSync(join(repo, 'demo.mp4'), binaryBlob)
    commitAll(repo, 'add video')
    fs.rmSync(join(repo, 'demo.mp4'))

    const sides = await getFileDiffSides(repo, 'demo.mp4', false)
    expect(sides).toMatchObject({ binary: true, original: '', modified: '', originalExists: true })
  })

  it('flags an oversized text file without shipping its contents', async () => {
    const repo = makeRepo()
    fs.writeFileSync(join(repo, 'big.txt'), 'x'.repeat(3 * 1024 * 1024))
    const sha = commitAll(repo, 'add big')

    const commit = await getCommitFileDiffSides(repo, sha, 'big.txt')
    expect(commit).toMatchObject({ tooLarge: true, binary: false, original: '', modified: '', modifiedExists: true })

    fs.appendFileSync(join(repo, 'big.txt'), 'more\n')
    const working = await getFileDiffSides(repo, 'big.txt', false)
    expect(working).toMatchObject({ tooLarge: true, original: '', modified: '' })
  })

  it('still returns both text sides for an ordinary edit', async () => {
    const repo = makeRepo()
    fs.writeFileSync(join(repo, 'seed.txt'), 'seed\nchanged\n')
    const sha = commitAll(repo, 'edit')

    const sides = await getCommitFileDiffSides(repo, sha, 'seed.txt')
    expect(sides).toMatchObject({
      original: 'seed\n',
      modified: 'seed\nchanged\n',
      binary: false,
      tooLarge: false
    })
  })
})
