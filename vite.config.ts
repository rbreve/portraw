import { defineConfig } from 'vite';

// libraw-wasm uses a shared WebAssembly.Memory (pthreads build), which requires
// SharedArrayBuffer and therefore cross-origin isolation in the browser.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Keep libraw-wasm unbundled in dev so its internal
  // `new Worker(new URL('./worker.js', import.meta.url))` and wasm fetch
  // resolve against the real files in node_modules.
  optimizeDeps: { exclude: ['libraw-wasm'] },
  worker: { format: 'es' },
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
});
