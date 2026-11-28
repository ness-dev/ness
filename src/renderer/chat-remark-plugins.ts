// The remark plugins chat text is parsed with — one list for assistant
// replies, one for text a person typed (USER_REMARK_PLUGINS). Shared by
// the desktop chat (JsonModeChat's react-markdown) and the Expo app
// (mobile/src/components/Markdown.tsx renders the same mdast with React
// Native views), so both parse every message identically. Keep this
// module, and the plugins, free of DOM and React imports.
import remarkGfm from 'remark-gfm'
import { remarkInsight } from './remark-insight'
import { remarkMermaid } from './remark-mermaid'

export { USER_REMARK_PLUGINS } from './remark-user-text'

// remarkMermaid must run after remarkInsight, which rebuilds the tree.
export const ASSISTANT_REMARK_PLUGINS = [remarkGfm, remarkInsight, remarkMermaid]
