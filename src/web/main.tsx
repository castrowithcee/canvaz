import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app.js'
import { setExcalidrawAssetPath } from './board/excalidraw-assets.js'
import './styles.css'

// So frueh wie moeglich: der Editor wird zwar erst beim Oeffnen eines Boards nachgeladen, sein
// Schriftregister baut seine URLs aber beim Laden auf. Siehe board/excalidraw-assets.ts.
setExcalidrawAssetPath()

const container = document.getElementById('root')
if (container === null) {
  throw new Error('Kein #root im Dokument')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
