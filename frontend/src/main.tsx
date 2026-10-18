import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './auth'
import { loadStoreConfig } from './api'
import App from './App'
import './index.css'

const root = createRoot(document.getElementById('root')!)

// Prices can't be shown without knowing the store's currency, so load it first.
loadStoreConfig().then(
  () =>
    root.render(
      <StrictMode>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </StrictMode>,
    ),
  () => root.render(<p className="notice error">Couldn't reach the store. Please try again later.</p>),
)
