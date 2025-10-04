import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  publicDir: 'public',
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        options: resolve(__dirname, 'src/options/index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        'content-linkedin': resolve(__dirname, 'src/content/linkedin.ts'),
        'content-workday': resolve(__dirname, 'src/content/workday.ts'),
        'content-oracle-taleo': resolve(__dirname, 'src/content/oracle_taleo.ts'),
        'content-generic': resolve(__dirname, 'src/content/generic.ts'),
        'content-greenhouse': resolve(__dirname, 'src/content/greenhouse.ts')
      },
      output: {
        entryFileNames: (chunk) => {
          // Keep names stable and in root for manifest references
          if (chunk.name.startsWith('content-') || chunk.name === 'background') {
            return '[name].js';
          }
          return 'assets/[name].js';
        },
        // Disable code-splitting so content scripts don't ESM-import shared chunks
        manualChunks: undefined,
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
});


