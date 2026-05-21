import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Clock3, FileText, Medal, Rows3 } from 'lucide-react';
import { api } from '../lib/api';

export function TopikList() {
  const [exams, setExams] = useState([]);
  const [level, setLevel] = useState('all');

  useEffect(() => {
    api('/exams').then((data) => setExams(data.exams)).catch(console.error);
  }, []);

  const visible = useMemo(
    () => exams.filter((exam) => (level === 'all' || exam.topik_level === level) && exam.ready_for_practice),
    [exams, level],
  );

  return (
    <div className="topik-page">
      <header className="page-title">
        <span className="icon-tile"><FileText size={28} /></span>
        <div>
          <h1>Đề thi TOPIK</h1>
          <p>Làm bài theo đúng cấu trúc kỳ thi thật: nghe, đọc, chấm điểm và xem giải thích đáp án.</p>
        </div>
      </header>
      <div className="segmented">
        <button className={level === 'all' ? 'selected' : ''} onClick={() => setLevel('all')}>Tất cả</button>
        <button className={level === 'I' ? 'selected' : ''} onClick={() => setLevel('I')}>TOPIK I</button>
        <button className={level === 'II' ? 'selected' : ''} onClick={() => setLevel('II')}>TOPIK II</button>
      </div>
      <div className="exam-grid">
        {visible.map((exam) => (
          <Link to={`/topik/${exam.slug}`} className="exam-card" key={exam.id}>
            <div className="exam-card-head">
              <span className="yellow-badge">TOPIK {exam.topik_level} · 제{exam.round_no}회</span>
              <ChevronRight size={24} />
            </div>
            <h2>{exam.title_ko}</h2>
            <div className="stat-row">
              <span><Rows3 size={16} /> CÂU <strong>{exam.question_imported_count || exam.question_count}</strong></span>
              <span><Medal size={16} /> AUDIO <strong>{exam.audio_question_count || 0}</strong></span>
              <span><Clock3 size={16} /> PHÚT <strong>{exam.duration_minutes}</strong></span>
            </div>
          </Link>
        ))}
      </div>
      {!visible.length ? (
        <div className="center-card empty-state">Chưa có đề đủ đáp án, audio và option hợp lệ để hiển thị. Vào Crawler để nhập thêm nguồn TOPIK.</div>
      ) : null}
    </div>
  );
}
