import axios from 'axios';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function askOpenRouter(messages, options = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      content: 'OPENROUTER_API_KEY chưa được cấu hình. Bạn vẫn có thể dùng dữ liệu đề và crawler heuristic.',
      model: null,
    };
  }

  const model = options.model || process.env.OPENROUTER_MODEL || 'openrouter/free';
  const response = await axios.post(
    OPENROUTER_URL,
    {
      model,
      messages,
      temperature: options.temperature ?? 0.2,
      ...(options.max_tokens ? { max_tokens: options.max_tokens } : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': options.referer || 'http://localhost:5173',
        'X-Title': 'TopikWebCodex',
      },
      timeout: 60000,
    },
  );

  return {
    content: response.data?.choices?.[0]?.message?.content || '',
    model,
  };
}
