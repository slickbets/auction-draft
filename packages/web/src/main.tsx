import { createRoot } from 'react-dom/client'
import './ui/tokens.css'
import { App } from './App.js'
import { createDraftClient } from './client/draftClient.js'
import { readToken } from './useDraft.js'

const token = readToken()
const root = createRoot(document.getElementById('root')!)
if (!token) {
  root.render(<div style={{ padding: 24 }}>Open the invite link you were sent — it ends in a # and a code.</div>)
} else {
  root.render(<App client={createDraftClient({ token })} />)
}
