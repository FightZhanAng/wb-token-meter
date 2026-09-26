import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { watchSystemTheme } from './theme'
import './styles.css'

watchSystemTheme()

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载点')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
