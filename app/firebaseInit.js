import { getApp, getApps, initializeApp } from "firebase/app";
import { getAnalytics, isSupported, logEvent } from "firebase/analytics";

function requiredEnv(name) {
  const value = import.meta.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Add it to .env (Vite requires the VITE_ prefix).`
    );
  }
  return value;
}

const firebaseConfig = {
  apiKey: requiredEnv("VITE_FIREBASE_API_KEY"),
  authDomain: requiredEnv("VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: requiredEnv("VITE_FIREBASE_PROJECT_ID"),
  storageBucket: requiredEnv("VITE_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: requiredEnv("VITE_FIREBASE_MESSAGING_SENDER_ID"),
  appId: requiredEnv("VITE_FIREBASE_APP_ID"),
  measurementId: requiredEnv("VITE_FIREBASE_MEASUREMENT_ID"),
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const appCheck = null;

export const analyticsPromise = isSupported().then((yes) =>
  yes ? getAnalytics(app) : null
);

export async function logPageView(title) {
  const analytics = await analyticsPromise;
  if (analytics) {
    logEvent(analytics, "page_view", {
      page_title: title,
      page_location: window.location.href,
      page_path: window.location.pathname,
    });
  }
}

export async function trackEvent(eventName, params = {}) {
  const analytics = await analyticsPromise;
  if (analytics) {
    logEvent(analytics, eventName, params);
  }
}
