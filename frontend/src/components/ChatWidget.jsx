import { useState } from 'react';
import { Bot, MessageCircle, Send, X } from 'lucide-react';
import { api } from '../lib/api';

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Bạn cần hỏi giải thích ngữ pháp, đáp án hay chiến thuật làm bài TOPIK?' },
  ]);
  const [loading, setLoading] = useState(false);

  async function send(event) {
    event.preventDefault();
    if (!input.trim()) return;
    const message = input.trim();
    setInput('');
    setMessages((items) => [...items, { role: 'user', content: message }]);
    setLoading(true);
    try {
      const result = await api('/chat', { method: 'POST', body: JSON.stringify({ message }) });
      setMessages((items) => [...items, { role: 'assistant', content: result.answer }]);
    } catch (error) {
      setMessages((items) => [...items, { role: 'assistant', content: error.message }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {open ? (
        <section className="chat-panel">
          <header>
            <span><Bot size={17} /> AI TOPIK</span>
            <button type="button" onClick={() => setOpen(false)}><X size={16} /></button>
          </header>
          <div className="chat-log">
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`bubble ${message.role}`}>
                {message.content}
              </div>
            ))}
            {loading ? <div className="bubble assistant">Đang trả lời...</div> : null}
          </div>
          <form onSubmit={send}>
            <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Nhập câu hỏi..." />
            <button type="submit"><Send size={17} /></button>
          </form>
        </section>
      ) : null}
      <button className="floating-chat" type="button" onClick={() => setOpen(true)}>
        <MessageCircle size={20} /> Nhắn tin
      </button>
    </>
  );
}
