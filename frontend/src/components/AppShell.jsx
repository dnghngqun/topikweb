import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  BookMarked,
  BookOpen,
  Crown,
  FilePlus2,
  Flame,
  Grid2X2,
  Headphones,
  Languages,
  LogIn,
  MessageCircle,
  Settings,
  Star,
  Trophy,
} from 'lucide-react';
import { LoginPanel } from './LoginPanel.jsx';
import { ChatWidget } from './ChatWidget.jsx';

const items = [
  { to: '/', label: 'Trang chủ', icon: Grid2X2 },
  { to: '/alphabet', label: 'Bảng chữ cái', icon: Languages },
  { to: '/vocab', label: 'Từ vựng', icon: Languages },
  { to: '/my-vocab', label: 'Sổ tay từ vựng', icon: BookMarked },
  { to: '/create-file', label: 'Tạo file luyện viết', icon: FilePlus2 },
  { to: '/grammar', label: 'Ngữ pháp', icon: BookOpen },
  { to: '/my-grammar', label: 'Sổ tay ngữ pháp', icon: BookMarked },
  { to: '/review', label: 'Ôn tập', icon: Star },
  { to: '/rank', label: 'Bảng xếp hạng', icon: Trophy },
  { to: '/topik', label: 'Luyện đề', icon: FilePlus2 },
  { to: '/shadowing', label: 'Shadowing', icon: Headphones },
];

export function AppShell({ children, authState }) {
  const location = useLocation();
  const takeMode = /\/take$/.test(location.pathname);

  if (takeMode) {
    return (
      <>
        {children}
        <ChatWidget />
      </>
    );
  }

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark">한글</span>
          <span className="brand-text">NHAI<br />T.O.P.i.k.</span>
          <span className="streak"><Flame size={16} />0</span>
        </Link>
        <div className="nav-label">HỌC TẬP</div>
        <nav className="nav-list">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <Icon size={18} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <Link to="/admin" className="upgrade">
          <Crown size={19} />
          <span>Nâng cấp</span>
        </Link>
        <div className="sidebar-bottom">
          <Link to="/settings" className="nav-item">
            <Settings size={18} />
            <span>Cài đặt</span>
          </Link>
          <LoginPanel authState={authState} />
        </div>
      </aside>
      <main className="paper-bg">
        <div className="paper-inner">{children}</div>
      </main>
      <button className="floating-chat" type="button">
        <MessageCircle size={20} /> Nhắn tin
      </button>
    </div>
  );
}
