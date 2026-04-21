import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: '.',
  server: {
    // Match hosted and in-app URLs under `/app/` (see stateRestore.js, firebase.json redirects from `/client`).
    open: '/app/home.html',
    port: 5173,
    strictPort: false,
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        home: path.resolve(__dirname, 'app/home.html'),
        calendar: path.resolve(__dirname, 'app/calendar.html'),
        about: path.resolve(__dirname, 'app/about.html'),
        hotline: path.resolve(__dirname, 'app/hotline.html'),
        login: path.resolve(__dirname, 'app/login.html'),
        admin: path.resolve(__dirname, 'app/admin.html'),
        adminCalendar: path.resolve(__dirname, 'app/admin-calendar.html'),
        adminAccounts: path.resolve(__dirname, 'app/admin-accounts.html'),
      },
    },
  },
  resolve: {
    alias: {
      'firebase/app': path.resolve(__dirname, 'node_modules/firebase/app/dist/esm/index.esm.js'),
      'firebase/firestore': path.resolve(__dirname, 'node_modules/firebase/firestore/dist/esm/index.esm.js'),
      'firebase/analytics': path.resolve(__dirname, 'node_modules/firebase/analytics/dist/esm/index.esm.js'),
      'firebase/auth': path.resolve(__dirname, 'node_modules/firebase/auth/dist/esm/index.esm.js'),
      'firebase/storage': path.resolve(__dirname, 'node_modules/firebase/storage/dist/esm/index.esm.js'),
      'firebase/functions': path.resolve(__dirname, 'node_modules/firebase/functions/dist/esm/index.esm.js'),
    },
  },
});
