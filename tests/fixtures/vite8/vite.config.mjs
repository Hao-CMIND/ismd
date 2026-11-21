import { defineConfig } from 'vite';
import { ismdRustPlugin } from '../../../../index.mjs';

export default defineConfig({
  plugins: [
    ismdRustPlugin({
      locals: (id) => ({
        pageName: id.includes('about') ? 'About' : 'Home',
      }),
    }),
  ],
});
