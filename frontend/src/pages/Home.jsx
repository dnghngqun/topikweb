import { Link } from 'react-router-dom';
import { FileText, Headphones, Languages } from 'lucide-react';

export function Home() {
  return (
    <div className="home-grid">
      <section className="hero-panel">
        <div>
          <span className="tag">한글 TOPIK</span>
          <h1>Luyện TOPIK theo đúng cấu trúc đề thi</h1>
          <p>Chọn đề, làm bài theo thời gian, nghe audio, nhập phần viết và xem đáp án mẫu.</p>
        </div>
        <Link to="/topik" className="blue-action"><FileText size={22} /> Vào luyện đề</Link>
      </section>
      <section className="quick-grid">
        <div><Languages /> Từ vựng</div>
        <div><FileText /> Ngữ pháp</div>
        <div><Headphones /> Shadowing</div>
      </section>
    </div>
  );
}
