import { defineConfig } from 'vite';
import { pugRustPlugin } from '../../../../index.js';

export default defineConfig({
  plugins: [
    pugRustPlugin({
      locals: (id) => ({
        pageName: id.includes('about') ? 'About' : 'Home',
      }),
    }),
  ],
});
