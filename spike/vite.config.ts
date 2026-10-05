import { defineConfig } from 'vite';

// `npm run spike` → http://localhost:5173/
// Add http://localhost:5173 as an Authorized JavaScript origin on your OAuth client.
export default defineConfig({
  root: 'spike',
  server: { port: 5173, strictPort: true },
});
