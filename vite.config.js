import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Racine du front mobile : /client. Le build est servi par le serveur Express (mode prod).
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Noms de fichiers SANS hash : l'environnement d'aperçu étant volatil (recyclage du
    // sandbox), un index.html en cache pointant vers un bundle hashé périmé = écran gris.
    // Avec des noms fixes + Cache-Control no-store, tout rechargement repart toujours du neuf.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/app-[hash].js',
        assetFileNames: 'assets/app.[ext]',
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // En développement, l'API reste sur le serveur Express (port 4000)
      '/api': 'http://localhost:4000',
    },
  },
});
