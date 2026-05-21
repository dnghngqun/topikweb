import { useState } from 'react';
import { Bot, Database, DownloadCloud, Link2, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

export function AdminTools() {
  const [sourceUrl, setSourceUrl] = useState('');
  const [useAi, setUseAi] = useState(true);
  const [message, setMessage] = useState('');
  const [summary, setSummary] = useState([]);
  const [busy, setBusy] = useState(false);

  async function crawl(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await api('/crawl', {
        method: 'POST',
        body: JSON.stringify({ sourceUrl, ai: useAi }),
      });
      setMessage(`Đã nhập ${result.exam.slug}. PDF: ${result.pdfCount}, ảnh: ${result.imageCount}, audio: ${result.assets.audio || 'chưa thấy'}`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function runDailyNow() {
    setBusy(true);
    setMessage('');
    try {
      const result = await api('/crawl/run-due', {
        method: 'POST',
        body: JSON.stringify({ force: true }),
      });
      setSummary(result.summary || []);
      setMessage(`Đã chạy crawler định kỳ: ${result.summary?.length || 0} nguồn.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-page">
      <header className="page-title">
        <span className="icon-tile"><Database size={28} /></span>
        <div>
          <h1>Crawler TOPIK</h1>
          <p>Nhập URL chứa đề TOPIK, đáp án, audio hoặc PDF. Tool sẽ tạo exam, section và lưu asset tìm được.</p>
        </div>
      </header>
      <form className="admin-card" onSubmit={crawl}>
        <label>
          <span><Link2 size={18} /> URL nguồn</span>
          <input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://..." />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={useAi} onChange={(event) => setUseAi(event.target.checked)} />
          <span><Bot size={18} /> Dùng OpenRouter để trích metadata/đáp án nếu trang là text</span>
        </label>
        <button className="blue-action" disabled={busy || !sourceUrl} type="submit">
          <DownloadCloud size={20} /> {busy ? 'Đang crawl...' : 'Crawl dữ liệu'}
        </button>
        {message ? <pre className="admin-result">{message}</pre> : null}
      </form>
      <section className="admin-card">
        <h2>Crawl tự động hằng ngày</h2>
        <p>Backend tự chạy theo `CRAWL_INTERVAL_HOURS` để kiểm tra nguồn mới. Nút này ép chạy ngay.</p>
        <button className="blue-action" disabled={busy} type="button" onClick={runDailyNow}>
          <RefreshCw size={20} /> Chạy kiểm tra ngay
        </button>
        {summary.length ? (
          <pre className="admin-result">{JSON.stringify(summary, null, 2)}</pre>
        ) : null}
      </section>
      <section className="admin-card">
        <h2>Import JSON trực tiếp</h2>
        <p>Backend có endpoint <code>POST /api/import</code> để nhập payload gồm <code>exam</code> và <code>questions</code>. Dùng khi crawler tải được dữ liệu từ PDF/OCR bên ngoài.</p>
      </section>
    </div>
  );
}
