const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseEnabled = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId,
);

let auth = null;
let firebaseModulePromise = null;

async function loadFirebase() {
  if (!firebaseEnabled) return null;
  if (!firebaseModulePromise) {
    firebaseModulePromise = Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
    ]).then(([appMod, authMod]) => {
      const app = appMod.initializeApp(firebaseConfig);
      auth = authMod.getAuth(app);
      return { auth, authMod };
    });
  }
  return firebaseModulePromise;
}

export async function loginWithGoogle() {
  const loaded = await loadFirebase();
  if (!loaded) return null;
  const provider = new loaded.authMod.GoogleAuthProvider();
  return loaded.authMod.signInWithPopup(loaded.auth, provider);
}

export async function loginWithEmail(email, password, mode = 'login') {
  const loaded = await loadFirebase();
  if (!loaded) return null;
  if (mode === 'signup') return loaded.authMod.createUserWithEmailAndPassword(loaded.auth, email, password);
  return loaded.authMod.signInWithEmailAndPassword(loaded.auth, email, password);
}

export async function logoutFirebase() {
  const loaded = await loadFirebase();
  if (loaded) await loaded.authMod.signOut(loaded.auth);
}

export function subscribeFirebase(callback) {
  if (!firebaseEnabled) {
    callback(null);
    return () => {};
  }
  let unsubscribe = () => {};
  loadFirebase()
    .then((loaded) => {
      if (!loaded) {
        callback(null);
        return;
      }
      unsubscribe = loaded.authMod.onAuthStateChanged(loaded.auth, callback);
    })
    .catch(() => callback(null));
  return () => unsubscribe();
}
