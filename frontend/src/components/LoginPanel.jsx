import { useState } from 'react';
import { LogIn, Mail } from 'lucide-react';
import { firebaseEnabled, loginWithEmail, loginWithGoogle, logoutFirebase } from '../lib/firebase';

export function LoginPanel({ authState }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState('login');
  const [error, setError] = useState('');
  const profile = authState.profile;

  async function submit(event) {
    event.preventDefault();
    setError('');
    try {
      await loginWithEmail(email, password, mode);
      setOpen(false);
    } catch (err) {
      setError(err.message);
    }
  }

  if (profile) {
    return (
      <div className="user-card">
        <div className="avatar">{profile.display_name?.[0] || 'T'}</div>
        <div>
          <strong>{profile.display_name || 'TOPIK User'}</strong>
          <small>{profile.email}</small>
        </div>
      </div>
    );
  }

  return (
    <div className="login-box">
      <button className="login-trigger" type="button" onClick={() => setOpen((value) => !value)}>
        <LogIn size={16} /> Đăng nhập
      </button>
      {open ? (
        <form className="login-pop" onSubmit={submit}>
          <button className="google-btn" type="button" disabled={!firebaseEnabled} onClick={loginWithGoogle}>
            <Mail size={16} /> Google
          </button>
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" />
          <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Mật khẩu" type="password" />
          <button className="blue-btn" type="submit" disabled={!firebaseEnabled}>
            {mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </button>
          <button className="link-btn" type="button" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
            {mode === 'login' ? 'Tạo account' : 'Đã có account'}
          </button>
          {!firebaseEnabled ? <small>Chưa có Firebase env, đang dùng dev auth ở backend.</small> : null}
          {error ? <small className="error">{error}</small> : null}
        </form>
      ) : null}
    </div>
  );
}
