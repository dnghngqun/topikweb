import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, BookOpen, Clock3, Headphones, Medal, Pencil, Play, Rows3 } from 'lucide-react';
import { api } from '../lib/api';

const sectionIcon = { listening: Headphones, writing: Pencil, reading: BookOpen };

export function ExamDetail() {
  const { slug } = useParams();
  const [data, setData] = useState(null);

  useEffect(() => {
    api(`/exams/${slug}`).then(setData).catch(console.error);
  }, [slug]);

  if (!data) return <div className="center-card">Đang tải đề...</div>;

  const { exam, sections } = data;

  return (
    <div className="detail-wrap">
      <Link className="back-link" to="/topik"><ArrowLeft size={17} /> Tất cả đề</Link>
      <section className="detail-card">
        <header className="detail-hero">
          <span className="yellow-badge">{exam.subject}</span>
          <h1>제{exam.round_no}회 한국어능력시험 TOPIK {exam.topik_level}</h1>
          <p>{exam.title_en}</p>
        </header>
        <div className="detail-stats">
          <span><Rows3 size={18} /> TỔNG CÂU <strong>{exam.question_count}</strong></span>
          <span><Medal size={18} /> TỔNG ĐIỂM <strong>{exam.total_score}</strong></span>
          <span><Clock3 size={18} /> THỜI GIAN <strong>{exam.duration_minutes} phút</strong></span>
        </div>
        <div className="section-list">
          <h2>Cấu trúc bài thi</h2>
          {sections.map((section) => {
            const Icon = sectionIcon[section.section_key] || BookOpen;
            return (
              <div className={`section-row ${section.section_key}`} key={section.id}>
                <span><Icon size={21} /> {section.title}</span>
                <div>
                  <b>Câu {section.question_start}-{section.question_end}</b>
                  <b>{section.score} điểm</b>
                  <b>{section.duration_minutes} phút</b>
                </div>
              </div>
            );
          })}
        </div>
        <div className="notice">
          <strong><AlertTriangle size={20} /> Lưu ý trước khi làm bài</strong>
          <ul>
            <li>Phần Nghe sẽ tự động phát theo thứ tự. Hãy chuẩn bị tai nghe.</li>
            <li>Mỗi phần có thời gian riêng. Hết giờ sẽ tự chuyển phần kế tiếp.</li>
            <li>Sau khi nộp bài bạn sẽ thấy điểm và phần giải thích từng câu.</li>
          </ul>
        </div>
        <Link to={`/topik/${slug}/take`} className="start-btn"><Play size={22} /> Bắt đầu làm bài</Link>
      </section>
    </div>
  );
}
