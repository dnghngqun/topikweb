import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, FileText, RotateCcw, XCircle } from 'lucide-react';
import { api } from '../lib/api';

function answerLabel(value) {
  if (!value) return 'Chưa chọn';
  if (typeof value === 'object') return Object.values(value).filter(Boolean).join(', ') || 'Chưa chọn';
  return String(value);
}

export function ExamResult() {
  const { slug, attemptId } = useParams();
  const [data, setData] = useState(null);

  useEffect(() => {
    api(`/attempts/${attemptId}/result`).then(setData).catch(console.error);
  }, [attemptId]);

  const wrongItems = useMemo(
    () => (data?.items || []).filter((item) => item.gradable && item.user_answer && !item.correct),
    [data],
  );

  if (!data) return <div className="center-card">Đang tính kết quả...</div>;

  const { exam, summary } = data;

  return (
    <div className="result-page">
      <Link className="back-link" to={`/topik/${slug}`}><ArrowLeft size={17} /> Quay lại đề</Link>
      <section className="result-hero">
        <span className="icon-tile"><FileText size={28} /></span>
        <div>
          <small>TOPIK {exam.topik_level} · 제{exam.round_no}회</small>
          <h1>Kết quả bài làm</h1>
          <p>{exam.title_en}</p>
        </div>
      </section>

      <div className="result-grid">
        <div className="result-card score-card">
          <strong>{summary.has_answer_key ? `${summary.auto_score}/${summary.total_score}` : '--'}</strong>
          <span>{summary.has_answer_key ? 'Điểm tự động' : 'Nguồn này chưa công khai đáp án'}</span>
        </div>
        <div className="result-card">
          <strong>{summary.answered_count}/{summary.question_count}</strong>
          <span>Câu đã làm</span>
        </div>
        <div className="result-card">
          <strong>{summary.correct_count}/{summary.auto_gradable_count}</strong>
          <span>Câu có thể chấm</span>
        </div>
      </div>

      {!summary.has_answer_key ? (
        <div className="result-notice">
          Crawler lấy được đề, ảnh và audio, nhưng nguồn này không để lộ đáp án đúng trong HTML public nên hệ thống không chấm bừa.
        </div>
      ) : null}

      <section className="result-list">
        <h2>Chi tiết câu trả lời</h2>
        {(summary.has_answer_key ? wrongItems : data.items.filter((item) => item.user_answer)).slice(0, 80).map((item) => (
          <div className="result-row" key={item.number}>
            <span>Câu {item.number}</span>
            <b>{answerLabel(item.user_answer)}</b>
            {item.gradable ? (
              item.correct ? <CheckCircle2 size={18} /> : <XCircle size={18} />
            ) : (
              <small>Chưa có đáp án</small>
            )}
          </div>
        ))}
      </section>

      <Link className="start-btn retake-btn" to={`/topik/${slug}/take`}><RotateCcw size={20} /> Làm lại</Link>
    </div>
  );
}
