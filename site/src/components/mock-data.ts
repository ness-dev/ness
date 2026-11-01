import type { MockWorktree } from './MockHarness'

/** The fleet both the hero and the scroll diorama show. Each worktree
 * carries its own chat and right-column contents so whichever one is active
 * reads as a single coherent piece of work. */
export const BASE_WORKTREES: Omit<MockWorktree, 'status'>[] = [
  {
    id: '1',
    branch: 'feat/onboarding',
    path: 'ness/feat-onboarding',
    age: '2d',
    pr: {
      number: 142,
      title: 'Onboarding flow ready for review',
      checks: 'success',
      additions: 142,
      deletions: 58,
      milestone: 'v1.4'
    },
    changes: {
      commits: [
        { sha: 'a1b2c3d', msg: 'Fix typo in welcome copy', pushed: false },
        { sha: 'b2c3d4e', msg: 'Add onboarding slide deck', pushed: true },
        { sha: 'c3d4e5f', msg: 'Wire up onboarding router', pushed: true }
      ],
      uncommitted: [{ path: 'src/welcome.tsx', kind: 'M', add: 12, del: 3 }],
      committed: [
        { path: 'src/welcome.tsx', kind: 'A', add: 142, del: 0 },
        { path: 'src/auth/signup.ts', kind: 'M', add: 56, del: 12 },
        { path: 'src/router.ts', kind: 'M', add: 4, del: 2 },
        { path: 'src/onboarding/steps.ts', kind: 'A', add: 88, del: 0 },
        { path: 'tests/onboarding.spec.ts', kind: 'A', add: 62, del: 0 }
      ]
    },
    // The edit lands in the uncommitted src/welcome.tsx listed above.
    chat: {
      prompt:
        'The welcome screen still says "Sign up" right after login. Show their name and a Continue button instead.',
      explanation:
        '`Welcome` reads the session before it has loaded, so it always renders the signed-out copy. Waiting on `status` fixes it.',
      edit: {
        path: 'src/welcome.tsx',
        lines: [
          { kind: 'ctx', old: 12, next: 12, text: 'export function Welcome() {' },
          { kind: 'remove', old: 13, text: '  const { user } = useSession()' },
          { kind: 'add', next: 13, text: '  const { user, status } = useSession()' },
          { kind: 'add', next: 14, text: "  if (status === 'loading') return <Spinner />" },
          { kind: 'ctx', old: 14, next: 15, text: '  if (!user) return <SignUpCta />' }
        ]
      },
      working: {
        todos: [
          { status: 'completed', text: 'Find why the signed-out copy shows' },
          { status: 'in_progress', text: 'Wait for the session before rendering' },
          { status: 'pending', text: 'Test the loading state' }
        ],
        streaming: 'Adding a test for the loading state'
      },
      approval: {
        command: 'npx vitest run src/welcome.test.tsx',
        description: 'Run the welcome screen tests'
      }
    }
  },
  {
    id: '2',
    branch: 'fix/login-flash',
    path: 'ness/fix-login-flash',
    age: '6h',
    changes: {
      commits: [{ sha: 'e7f8a9b', msg: 'Reproduce the logout flash in e2e', pushed: true }],
      uncommitted: [{ path: 'src/router.ts', kind: 'M', add: 1, del: 0 }],
      committed: [{ path: 'e2e/logout.spec.ts', kind: 'A', add: 34, del: 0 }]
    },
    // The edit lands in the uncommitted src/router.ts listed above.
    chat: {
      prompt: 'Logging out flashes the dashboard for a frame before the redirect. Fix it.',
      explanation:
        'The redirect runs in an effect, after first paint. Guarding the route in its `loader` means a signed-out user never renders `Dashboard` at all.',
      edit: {
        path: 'src/router.ts',
        lines: [
          { kind: 'ctx', old: 21, next: 21, text: '  {' },
          { kind: 'ctx', old: 22, next: 22, text: "    path: '/dashboard'," },
          { kind: 'add', next: 23, text: '    loader: requireSession,' },
          { kind: 'ctx', old: 23, next: 24, text: '    element: <Dashboard />' },
          { kind: 'ctx', old: 24, next: 25, text: '  },' }
        ]
      },
      working: {
        todos: [
          { status: 'completed', text: 'Find where the redirect happens' },
          { status: 'in_progress', text: 'Move the guard into the loader' },
          { status: 'pending', text: 'Check it in the e2e suite' }
        ],
        streaming: 'Running the logout e2e test'
      },
      approval: {
        command: 'npx playwright test e2e/logout.spec.ts',
        description: 'Confirm the dashboard no longer flashes after logout'
      }
    }
  },
  {
    id: '3',
    branch: 'refactor/auth',
    path: 'ness/refactor-auth',
    age: '3h'
  },
  {
    id: '4',
    branch: 'chore/deps-bump',
    path: 'ness/chore-deps-bump',
    age: '1d'
  },
  {
    id: '5',
    branch: 'docs/api-reference',
    path: 'ness/docs-api-reference',
    age: '<1h'
  }
]
