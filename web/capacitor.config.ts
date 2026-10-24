import type { CapacitorConfig } from '@capacitor/cli';

/**
 * SAMAAN native shell. The same web build (dist/) runs inside a WKWebView, the way the team's
 * earlier Smart Sanskriti app did. The API URL is baked at build time via VITE_API_URL; for a
 * phone on the same Wi-Fi as the laptop that is http://<laptop-ip>:8000, so cleartext HTTP must
 * be allowed (hackathon only; production goes behind HTTPS).
 */
const config: CapacitorConfig = {
  appId: 'ai.samaan.app',
  appName: 'SAMAAN',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#FAFAF9',
    allowsLinkPreview: false,
    limitsNavigationsToAppBoundDomains: false,
  },
  server: {
    // capacitor://localhost is the app origin; allow the dev API and OpenFreeMap tiles.
    cleartext: true,
    allowNavigation: ['*.openfreemap.org', '192.168.*.*', '10.*.*.*', '172.16.*.*', 'localhost'],
  },
  plugins: {
    SpeechRecognition: {},
  },
};

export default config;
