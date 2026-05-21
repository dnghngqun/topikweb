import React, { Component, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { setTokenProvider, api } from './lib/api';
import { subscribeFirebase } from './lib/firebase';
import { AppShell } from './components/AppShell.jsx';
import { TopikList } from './pages/TopikList.jsx';
import { ExamDetail } from './pages/ExamDetail.jsx';
import { TakeExam } from './pages/TakeExam.jsx';
import { ExamResult } from './pages/ExamResult.jsx';
import { Home } from './pages/Home.jsx';
import { AdminTools } from './pages/AdminTools.jsx';
import './styles/app.css';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal-error">
          <h1>Frontend đang lỗi runtime</h1>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [profile, setProfile] = useState({
    display_name: 'Đặng Hồng Quân',
    email: 'demo@topik.local',
    provider: 'dev',
  });

  useEffect(() => {
    const unsub = subscribeFirebase(async (user) => {
      setFirebaseUser(user);
      setTokenProvider(async () => (user ? user.getIdToken() : ''));
      try {
        const me = await api('/me');
        setProfile(me.user);
      } catch (error) {
        console.warn('Using local dev auth profile:', error.message);
      }
    });
    return unsub;
  }, []);

  const authState = useMemo(() => ({ firebaseUser, profile, setProfile }), [firebaseUser, profile]);

  return (
    <BrowserRouter>
      <AppShell authState={authState}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/topik" element={<TopikList />} />
          <Route path="/topik/:slug" element={<ExamDetail />} />
          <Route path="/topik/:slug/take" element={<TakeExam />} />
          <Route path="/topik/:slug/results/:attemptId" element={<ExamResult />} />
          <Route path="/admin" element={<AdminTools />} />
          <Route path="*" element={<Navigate to="/topik" replace />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
