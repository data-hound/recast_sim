import { defineConfig } from 'vite';
import informer from '@entrinsik/vite-plugin-informer';

// Static front end (public/ is synced from ../../../web by sync.sh) + one optional server route (server/caselog).
export default defineConfig({
  base: './',
  plugins: [informer()]
});
