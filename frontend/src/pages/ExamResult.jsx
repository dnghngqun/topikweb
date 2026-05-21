import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, FileText, RotateCcw, XCircle } from 'lucide-react';
import { api } from '../lib/api';

function answerLabel(value) {
  if (!value) return 'Chưa chọn';
  if (typeof value === 'object') return Object.values(value).filter(Boolean).join(', ') || 'Chưa chọn';
  return String(value);
}

function displayAnswer(item, field, fallbackField) {
  return item[field] || answerLabel(item[fallbackField]);
}

function explanationText(item) {
  if (item.explanation) return item.explanation;
  if (!item.gradable) return 'Câu này cần chấm thủ công.';
  if (item.correct) return `Đúng. Bạn được ${item.score_awarded || 0}/${item.points || 0} điểm.`;
  return `Sai. Bạn chọn ${displayAnswer(item, 'user_answer_text', 'user_answer')}; đáp án đúng là ${displayAnswer(item, 'correct_answer_text', 'correct_answer')}.`;
}

export function ExamResult() {
  const { slug, attemptId } = useParams();
  const [data, setData] = useState(null);

  useEffect(() => {
    api(`/attempts/${attemptId}/result`).then(setData).catch(console.error);
  }, [attemptId]);

  const detailItems = useMemo(
    () => (data?.items || []).filter((item) => item.user_answer || item.type !== 'multiple_choice'),
    [data],
  );

  if (!data) return <div className="center-card">Đang tính kết quả...</div>;

  const { exam, summary } = data;
  const scoreTotal = summary.auto_gradable_score || summary.total_score;
  const hasManualItems = summary.manual_count > 0;

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
          <strong>{summary.has_answer_key ? `${summary.auto_score}/${scoreTotal}` : '--'}</strong>
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
      {summary.has_answer_key && hasManualItems ? (
        <div className="result-notice">
          Phần trắc nghiệm đã chấm tự động. {summary.manual_count} câu viết/tự luận cần chấm thủ công nên không cộng vào điểm tự động.
        </div>
      ) : null}

      <section className="result-list">
        <h2>Chi tiết câu trả lời</h2>
        <div className="result-table">
          <div className="result-table-head">
            <span>Câu</span>
            <span>Bài làm</span>
            <span>Đáp án</span>
            <span>Điểm</span>
            <span>Giải thích</span>
            <span />
          </div>
          {detailItems.slice(0, 120).map((item) => (
            <div className="result-row" key={item.number}>
              <span>Câu {item.number}</span>
              <b>{displayAnswer(item, 'user_answer_text', 'user_answer')}</b>
              <b>{item.gradable ? displayAnswer(item, 'correct_answer_text', 'correct_answer') : 'Chấm thủ công'}</b>
              <b>{item.gradable ? `${item.score_awarded || 0}/${item.points || 0}` : '-'}</b>
              <small>{explanationText(item)}</small>
              {item.gradable ? (
                item.correct ? <CheckCircle2 className="result-ok" size={18} /> : <XCircle className="result-bad" size={18} />
              ) : (
                <small>Manual</small>
              )}
            </div>
          ))}
        </div>
      </section>

      <Link className="start-btn retake-btn" to={`/topik/${slug}/take`}><RotateCcw size={20} /> Làm lại</Link>
    </div>
  );
}
