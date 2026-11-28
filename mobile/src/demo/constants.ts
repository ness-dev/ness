// Shared by the eager parts of the demo (transport, UI) and the lazily
// loaded world, so importing them never pulls in the fixtures.
export const DEMO_BACKEND_ID = 'ness-demo'
export const DEMO_LABEL = 'Demo'
export const DEMO_CLIENT_ID = 'demo-client'
export const DEMO_UNAVAILABLE = 'Not available in the demo'
/** Signal the demo emits when something isn't available, so the UI can say
 *  so even for fire-and-forget calls (DemoNotice.tsx). */
export const DEMO_NOTICE_SIGNAL = 'demo:notice'
