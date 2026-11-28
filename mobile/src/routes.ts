// Hrefs for the app's routes (src/app/). A worktree is identified by its
// path, which holds slashes, so it travels as one encoded path segment.
import type { Href } from 'expo-router'

export const worktreeHref = (path: string, tab?: string): Href => ({
  pathname: '/w/[wt]',
  params: tab ? { wt: path, tab } : { wt: path }
})

export const toolsHref = (path: string): Href => ({ pathname: '/w/[wt]/tools', params: { wt: path } })
