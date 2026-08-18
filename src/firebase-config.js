import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInAnonymously,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

export const authReady = new Promise((resolve, reject) => {
  let unsubscribe = () => {};
  let signInStarted = false;
  const timeout = setTimeout(() => {
    unsubscribe();
    reject(new Error('Authentication timed out.'));
  }, 15000);
  const finish = (callback, value) => {
    clearTimeout(timeout);
    unsubscribe();
    callback(value);
  };

  setPersistence(auth, browserLocalPersistence).then(() => {
    unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user?.uid) finish(resolve, user);
      else if (!signInStarted) {
        signInStarted = true;
        signInAnonymously(auth).catch((error) => finish(reject, error));
      }
    }, (error) => finish(reject, error));
  }).catch((error) => finish(reject, error));
});
