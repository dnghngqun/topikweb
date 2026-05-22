const API_URL = import.meta.env.VITE_API_URL || '/api';

let tokenProvider = async () => '';

export function setTokenProvider(provider) {
  tokenProvider = provider;
}

export async function api(path, options = {}) {
  const token = await tokenProvider();
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || data.error || 'API error');
  }
  return data;
}
