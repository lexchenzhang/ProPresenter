import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves the built app under /<repo-name>/. In dev we serve at
// root so local preview URLs stay simple. Override the built base with
// BASE_PATH if the repo is renamed, or set it to '/' for a custom domain.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? process.env.BASE_PATH ?? '/ProPresenter/' : '/',
  plugins: [react()],
}))
