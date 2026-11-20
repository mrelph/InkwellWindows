import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/* The Content-Security-Policy, written into index.html at build/serve time so
   development allowances never ship. Production is strict: scripts, styles
   and fonts from the bundle only, images from the bundle and the
   inkwell-asset scheme only (no remote image ever loads), no connections
   beyond 'self'. The dev server additionally needs its HMR websocket and
   'unsafe-inline' styles (Vite's client injects <style> tags for CSS HMR).
   React `style={}` props are applied through the CSSOM, which style-src does
   not govern, so production needs no 'unsafe-inline'. */
const HMR_SOCKETS = 'ws://127.0.0.1:5173 ws://localhost:5173'

function contentSecurityPolicy(dev: boolean): string {
  return [
    "default-src 'self'",
    "img-src 'self' inkwell-asset:",
    dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "font-src 'self'",
    dev ? `connect-src 'self' ${HMR_SOCKETS}` : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'"
  ].join('; ')
}

function cspPlugin(): Plugin {
  let dev = false
  return {
    name: 'inkwell-csp',
    configResolved(config) {
      dev = config.command === 'serve'
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes('%INKWELL_CSP%')) throw new Error('index.html lost its %INKWELL_CSP% placeholder')
        return html.replace('%INKWELL_CSP%', contentSecurityPolicy(dev))
      }
    }
  }
}

export default defineConfig({
  // Relative asset paths are required: Electron loads the built index.html over
  // file://, where absolute "/assets/..." URLs resolve to the filesystem root.
  base: './',
  plugins: [cspPlugin(), react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    /* Fonts stay files: an inlined `data:` font would need font-src data:,
       and the CSP allows 'self' only. Other small assets inline as usual. */
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined)
  }
})
