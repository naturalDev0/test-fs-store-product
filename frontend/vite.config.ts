import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // Forward API calls to the Express server, so the browser sees one origin.
    proxy: { '/api': 'http://localhost:4000' },
  },
})
