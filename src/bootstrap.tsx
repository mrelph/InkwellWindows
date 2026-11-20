import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
/* Base styles first, so a module's co-located CSS (imported by App's tree
   below) comes later in the cascade than styles.css. */
import './fonts/fontFaces'
import './styles.css'
import App from './app/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
