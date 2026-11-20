import type { MockWorktree } from './MockHarness'

/** The project's main checkout. In the app it's the project row itself:
 * clicking the project opens it, and its chat is where work gets planned
 * and handed out to the worktrees below. Its chat shows exactly that. */
export const LEAD_WORKTREE: Omit<MockWorktree, 'status'> = {
  id: 'main',
  branch: 'main',
  path: 'ness',
  age: '3w',
  chat: {
    earlier: {
      prompt:
        'For v1.4: a welcome screen after signup, fix the dashboard flashing on logout, and pull session handling out of the auth module.',
      duration: '41s',
      toolCount: 4,
      filesEdited: 0,
      answer:
        'Started `feat/onboarding`, `fix/login-flash` and `refactor/auth`, each with its own agent. I’m following all three and will tell you when one needs you.'
    },
    prompt: 'Also document the new session API, and bump our deps while you’re at it.',
    tools: [
      { tool: 'Worktree', intent: 'Create Worktree · docs/api-reference' },
      { tool: 'Worktree', intent: 'Create Worktree · chore/deps-bump' }
    ],
    explanation:
      'Two more underway: `docs/api-reference` and `chore/deps-bump`. `feat/onboarding` has #142 up with checks passing, and a reviewer is on it.',
    working: {
      todos: { done: 2, total: 5 },
      streaming: 'Waiting on `fix/login-flash` to finish its e2e run'
    },
    approval: {
      command: 'gh pr checks 142 --watch',
      description: 'Watch CI on the onboarding PR'
    }
  }
}

/** The fleet both the hero and the scroll diorama show. Each worktree
 * carries its own chat and right-column contents so whichever one is active
 * reads as a single coherent piece of work. */
export const BASE_WORKTREES: Omit<MockWorktree, 'status'>[] = [
  {
    id: '1',
    branch: 'feat/onboarding',
    path: 'ness/feat-onboarding',
    age: '2d',
    review: 'reviewing',
    pr: {
      number: 142,
      title: 'Onboarding flow ready for review',
      checks: 'success',
      additions: 142,
      deletions: 58
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
      earlier: {
        prompt: 'Add a first-run welcome screen after signup.',
        duration: '2m 14s',
        toolCount: 11,
        filesEdited: 3,
        answer: 'Added `Welcome` at `/welcome` and sent new signups there.'
      },
      prompt:
        'The welcome screen still says "Sign up" right after login. Show their name and a Continue button instead.',
      tools: [
        { tool: 'Read' },
        { tool: 'Grep' },
        { tool: 'Bash', intent: 'Reproduce the signed-out flash' }
      ],
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
        todos: { done: 1, total: 3 },
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
      earlier: {
        prompt: 'Write an e2e test that reproduces the logout flash.',
        duration: '58s',
        toolCount: 6,
        filesEdited: 1,
        answer: '`e2e/logout.spec.ts` now catches the flash and fails on `main`.'
      },
      prompt: 'Logging out flashes the dashboard for a frame. Fix it.',
      tools: [
        { tool: 'Grep' },
        { tool: 'Read' },
        { tool: 'Bash', intent: 'Run the logout e2e test' }
      ],
      explanation:
        'The redirect runs in an effect, after first paint. Guarding the route in its `loader` means a signed-out user never renders `Dashboard` at all.',
      edit: {
        path: 'src/router.ts',
        lines: [
          { kind: 'ctx', old: 21, next: 21, text: '  {' },
          { kind: 'ctx', old: 22, next: 22, text: "    path: '/dashboard'," },
          { kind: 'add', next: 23, text: '    loader: requireSession,' },
          { kind: 'ctx', old: 23, next: 24, text: '    element: <Dashboard />' }
        ]
      },
      working: {
        todos: { done: 1, total: 3 },
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
    age: '3h',
    review: 'changes-requested'
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
