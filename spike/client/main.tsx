import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@excalidraw/excalidraw/index.css'
import './styles.css'
import { BoardApp } from './board-app.js'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('Wurzelelement #root fehlt.')
}

const params = new URLSearchParams(window.location.search)

createRoot(container).render(
  <StrictMode>
    <BoardApp
      boardId={params.get('board') ?? 'board-spike'}
      token={params.get('token') ?? 'spike-editor'}
      serverUrl={params.get('server') ?? 'ws://127.0.0.1:3001'}
    />
  </StrictMode>,
)
