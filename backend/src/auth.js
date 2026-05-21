import admin from 'firebase-admin';
import { query } from './db.js';

let firebaseReady = false;

function initFirebase() {
  if (firebaseReady || admin.apps.length) {
    firebaseReady = true;
    return;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    return;
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
  firebaseReady = true;
}

initFirebase();

async function upsertUser(profile) {
  const result = await query(
    `INSERT INTO users (firebase_uid, email, display_name, photo_url, provider)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email)
     DO UPDATE SET
       firebase_uid = COALESCE(users.firebase_uid, EXCLUDED.firebase_uid),
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       photo_url = COALESCE(EXCLUDED.photo_url, users.photo_url),
       updated_at = now()
     RETURNING *`,
    [profile.uid, profile.email, profile.name || profile.email, profile.picture || '', profile.provider || 'firebase'],
  );
  return result.rows[0];
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (token && firebaseReady) {
      const decoded = await admin.auth().verifyIdToken(token);
      req.user = await upsertUser({
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
        provider: decoded.firebase?.sign_in_provider || 'firebase',
      });
      return next();
    }

    if (process.env.DEV_AUTH_ENABLED !== 'false') {
      req.user = await upsertUser({
        uid: 'dev-user',
        email: 'demo@topik.local',
        name: 'Đặng Hồng Quân',
        picture: '',
        provider: 'dev',
      });
      return next();
    }

    return res.status(401).json({ error: 'Unauthorized' });
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized', detail: error.message });
  }
}

export async function optionalAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token && firebaseReady) {
      const decoded = await admin.auth().verifyIdToken(token);
      req.user = await upsertUser({
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
        provider: decoded.firebase?.sign_in_provider || 'firebase',
      });
    }
  } catch (_error) {
    req.user = null;
  }
  next();
}
