import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Circle,
  Clock3,
  Crosshair,
  Headphones,
  LayoutList,
  X,
  Pause,
  Play,
  Send,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { api } from '../lib/api';

function fmt(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function questionType(number) {
  if (number <= 50) return 'listening';
  if (number <= 54) return 'writing';
  return 'reading';
}

function makeMissingQuestion(exam, current) {
  return {
    number: current,
    points: 2,
    prompt: 'Câu này chưa được crawler import đủ dữ liệu.',
    passage: '',
    type: 'multiple_choice',
    choices: [],
    exam,
    missing: true,
  };
}

export function TakeExam() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [current, setCurrent] = useState(1);
  const [answers, setAnswers] = useState({});
  const [attempt, setAttempt] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [secondsLeft, setSecondsLeft] = useState(60 * 60);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const audioRef = useRef(null);
  const previousAudioSrcRef = useRef('');

  useEffect(() => {
    api(`/exams/${slug}/questions`).then(async (payload) => {
      setData(payload);
      setSecondsLeft(payload.exam.duration_minutes * 60);
      const newAttempt = await api(`/exams/${slug}/attempts`, { method: 'POST' });
      setAttempt(newAttempt.attempt);
    }).catch(console.error);
  }, [slug]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSecondsLeft((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const exam = data?.exam;
  const questionMap = useMemo(() => new Map((data?.questions || []).map((question) => [question.number, question])), [data]);
  const importedNumbers = useMemo(() => (data?.questions || []).map((item) => item.number), [data]);
  const total = Math.max(exam?.question_count || 0, ...importedNumbers);
  const question = questionMap.get(current) || makeMissingQuestion(exam, current);
  const currentSection =
    data?.sections?.find((sectionItem) => current >= sectionItem.question_start && current <= sectionItem.question_end) || null;
  const section = currentSection?.section_key || questionType(current);
  const activeAudioSrc = section === 'listening' ? (question?.audio_url || exam?.audio_url || '') : '';
  const hasOnlyChoiceLabels = (question.choices || []).length > 0 && (question.choices || []).every((choice) => {
    const text = String(choice.text || choice.html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    return /^[①②③④1-4.()]+$/.test(text);
  });
  const listeningAudioSources = useMemo(() => {
    const sources = (data?.questions || [])
      .filter((item) => item.section_key === 'listening' && (item.audio_url || exam?.audio_url))
      .map((item) => item.audio_url || exam?.audio_url)
      .filter(Boolean);
    return [...new Set(sources)];
  }, [data, exam?.audio_url]);
  const usesSharedListeningAudio = Boolean(activeAudioSrc && listeningAudioSources.length === 1);
  const answeredCount = Object.values(answers).filter((value) => {
    if (typeof value === 'string') return value.trim();
    return Boolean(value);
  }).length;

  async function submit() {
    if (!attempt || submitting) return;
    setSubmitting(true);
    try {
      const result = await api(`/attempts/${attempt.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ answers, status: 'submitted' }),
      });
      navigate(`/topik/${slug}/results/${result.attempt.id}`);
    } finally {
      setSubmitting(false);
    }
  }

  function updateAnswer(value) {
    setAnswers((items) => ({ ...items, [current]: value }));
  }

  function toggleAudio() {
    if (!audioRef.current || !activeAudioSrc) return;
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.playbackRate = playbackRate;
      audioRef.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  }

  function seekBy(delta) {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, Math.min(duration || 0, audioRef.current.currentTime + delta));
  }

  function changeProgress(value) {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Number(value);
    setCurrentTime(Number(value));
  }

  function cycleSpeed() {
    const speeds = [1, 1.25, 1.5, 0.75];
    const next = speeds[(speeds.indexOf(playbackRate) + 1) % speeds.length];
    setPlaybackRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  useEffect(() => {
    if (!activeAudioSrc) {
      previousAudioSrcRef.current = '';
      setPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      return;
    }

    if (previousAudioSrcRef.current === activeAudioSrc) return;

    previousAudioSrcRef.current = activeAudioSrc;
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.load();
    }
  }, [activeAudioSrc]);

  if (!data?.exam) return <div className="take-loading">Đang tải bài thi...</div>;

  const headerTitle = section === 'listening'
    ? currentSection?.title || `듣기 (Câu 1-${exam.topik_level === 'I' ? 30 : 50})`
    : section === 'writing'
      ? currentSection?.title || '쓰기 (Câu 51-54)'
      : currentSection?.title || `읽기 (Câu ${exam.topik_level === 'I' ? 31 : 51}-${total})`;

  return (
    <div className="take-page">
      <header className="take-header">
        <div className="take-title">
          <span className="take-icon"><Headphones size={26} /></span>
          <div>
            <small>TOPIK {exam.topik_level} · 제{exam.round_no}회 · PHẦN {section === 'reading' ? '3/3' : section === 'writing' ? '2/3' : '1/3'}</small>
            <h1>{headerTitle}</h1>
          </div>
        </div>
        <div className="take-actions">
          <span className="timer"><Clock3 size={18} /> {fmt(secondsLeft)}</span>
          <button className="submit-btn" type="button" onClick={() => setShowSubmitConfirm(true)}><Send size={18} /> Nộp bài</button>
        </div>
      </header>
      <main className="take-main">
        <section className="question-column">
          {section === 'listening' ? (
          <div className={`audio-box ${activeAudioSrc ? '' : 'audio-missing'}`}>
            <div className="audio-range">
              <small>{fmt(currentTime)}</small>
              <input
                type="range"
                min="0"
                max={duration || 0}
                value={Math.min(currentTime, duration || currentTime)}
                onChange={(event) => changeProgress(event.target.value)}
                disabled={!activeAudioSrc || !duration}
              />
              <small>{duration ? fmt(duration) : '--:--'}</small>
            </div>
            <div className="audio-controls">
              <button type="button" onClick={() => seekBy(-5)} disabled={!activeAudioSrc}><SkipBack size={19} /></button>
              <button type="button" className="play-big" onClick={toggleAudio} disabled={!activeAudioSrc}>
                {playing ? <Pause size={22} /> : <Play size={22} />}
              </button>
              <button type="button" onClick={() => seekBy(5)} disabled={!activeAudioSrc}><SkipForward size={19} /></button>
              <div className="spacer" />
              <button type="button" className="blue-mini"><Crosshair size={18} /></button>
              <button type="button" className="blue-mini"><LayoutList size={18} /></button>
              <button type="button" className="speed" onClick={cycleSpeed}>{playbackRate}x</button>
            </div>
            <div className="transcript">
              {activeAudioSrc
                ? usesSharedListeningAudio
                  ? 'Audio toàn bài nghe'
                  : `Audio câu ${question.number}`
                : 'Đề nghe này chưa có audio, crawler sẽ không đưa lên danh sách chính.'}
            </div>
            <audio
              ref={audioRef}
              src={activeAudioSrc}
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
              onEnded={() => setPlaying(false)}
            />
          </div>
          ) : null}
          <article className="question-card">
            {question.prompt && (!question.content_html || !/※/.test(question.content_html)) ? (
              <div className="instruction">※ {question.prompt}</div>
            ) : null}
            <div className="question-body">
              <h2>{question.number}. <span>{question.points}점</span></h2>
              {question.content_html ? (
                <div className="question-html" dangerouslySetInnerHTML={{ __html: question.content_html }} />
              ) : question.passage ? (
                <pre className="passage">{question.passage}</pre>
              ) : null}
              {!question.content_html && question.image_url ? (
                <img className="question-image" src={question.image_url} alt={`Question ${question.number}`} />
              ) : null}
              {question.content_html && /<img/i.test(question.content_html) && hasOnlyChoiceLabels ? (
                <div className="image-choice-note">Chọn đáp án tương ứng với ảnh/biểu đồ phía trên.</div>
              ) : null}
              {question.type === 'essay' ? (
                <>
                  <textarea className="essay" value={answers[current] || ''} onChange={(event) => updateAnswer(event.target.value)} placeholder="Viết 200-300 ký tự..." />
                  <div className="char-count">{(answers[current] || '').length} / 200-300 ký tự</div>
                </>
              ) : question.type === 'short_answer' ? (
                <div className="short-answers">
                  <label>㉠ đáp án <input value={answers[current]?.a || ''} onChange={(event) => updateAnswer({ ...(answers[current] || {}), a: event.target.value })} placeholder="Điền vào chỗ ㉠" /></label>
                  <label>㉡ đáp án <input value={answers[current]?.b || ''} onChange={(event) => updateAnswer({ ...(answers[current] || {}), b: event.target.value })} placeholder="Điền vào chỗ ㉡" /></label>
                </div>
              ) : (
                <div className="choice-grid">
                  {(question.choices || []).map((choice) => (
                    <button
                      key={choice.id}
                      className={answers[current] === choice.id ? 'chosen' : ''}
                      onClick={() => updateAnswer(choice.id)}
                    >
                      {choice.html ? <span dangerouslySetInnerHTML={{ __html: choice.html }} /> : choice.text}
                    </button>
                  ))}
                  {question.missing ? <div className="missing-question">Dữ liệu câu này chưa đủ nên không cho làm giả bằng đáp án placeholder.</div> : null}
                </div>
              )}
            </div>
          </article>
          <div className="pager">
            <button disabled={current === 1} onClick={() => setCurrent((value) => Math.max(1, value - 1))}><ArrowLeft size={18} /> Câu trước</button>
            <span>Câu {current} / {total}</span>
            <button disabled={current === total} onClick={() => setCurrent((value) => Math.min(total, value + 1))}>Câu sau <ArrowRight size={18} /></button>
          </div>
        </section>
        <QuestionBoard
          total={total}
          current={current}
          answers={answers}
          setCurrent={setCurrent}
          answeredCount={answeredCount}
          topikLevel={exam.topik_level}
          sections={data.sections || []}
        />
      </main>
      {showSubmitConfirm ? (
        <div className="submit-overlay" role="presentation">
          <div className="submit-modal" role="dialog" aria-modal="true" aria-labelledby="submit-title">
            <button className="modal-close" type="button" onClick={() => setShowSubmitConfirm(false)} aria-label="Đóng">
              <X size={18} />
            </button>
            <h2 id="submit-title">Nộp bài thi?</h2>
            <p>
              Bạn đã làm <strong>{answeredCount}/{total}</strong> câu. Còn <b>{Math.max(0, total - answeredCount)}</b> câu chưa làm sẽ bị tính sai.
            </p>
            <div className="submit-modal-actions">
              <button type="button" className="continue-btn" onClick={() => setShowSubmitConfirm(false)}>Tiếp tục làm</button>
              <button type="button" className="confirm-submit-btn" onClick={submit} disabled={submitting}>
                {submitting ? 'Đang nộp...' : 'Nộp bài'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QuestionBoard({ total, current, answers, setCurrent, answeredCount, topikLevel, sections }) {
  const listeningEnd = topikLevel === 'I' ? 30 : 50;
  const groups = sections.length
    ? sections.map((section) => [section.title, section.question_start, section.question_end, section.section_key])
    : topikLevel === 'I'
      ? [
          ['듣기 (1-30)', 1, 30, 'listening'],
          ['읽기 (31-70)', 31, 70, 'reading'],
        ]
      : [
          ['듣기 (1-50)', 1, listeningEnd, 'listening'],
          ['쓰기 (51-54)', 51, 54, 'writing'],
          ['읽기 (55-104)', 55, total, 'reading'],
        ];

  return (
    <aside className="question-board">
      <div className="board-head"><h2>Bảng câu hỏi</h2><span>{answeredCount}/{total}</span></div>
      {groups.map(([label, start, end, key]) => (
        <section key={label}>
          <h3>{label}</h3>
          <div className="number-grid">
            {Array.from({ length: end - start + 1 }, (_, index) => start + index).map((number) => {
              const locked = topikLevel === 'II' && number > 50 && number < 55 ? false : false;
              return (
                <button
                  key={number}
                  disabled={locked}
                  className={`${current === number ? 'now' : ''} ${answers[number] ? 'done' : ''}`}
                  onClick={() => setCurrent(number)}
                >
                  {number}
                </button>
              );
            })}
          </div>
          {key === 'writing' || key === 'reading' ? <small>Mở sau khi xong phần trước.</small> : null}
        </section>
      ))}
      <div className="legend">
        <span><Circle size={12} /> Chưa</span>
        <span><Circle size={12} fill="#b8d6fb" /> Đã làm</span>
        <span><Circle size={12} fill="#4b8df5" /> Hiện tại</span>
      </div>
    </aside>
  );
}
