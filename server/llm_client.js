import fetchNative from 'node-fetch';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_TEMP = Number.isFinite(Number(process.env.LLM_TEMPERATURE)) ? Number(process.env.LLM_TEMPERATURE) : 0.3;
const DEFAULT_MAX_TOKENS = Number.isFinite(Number(process.env.LLM_MAX_TOKENS)) ? Number(process.env.LLM_MAX_TOKENS) : 2048;

const SUPPORTED = new Set(['gemini', 'openai', 'mock']);

function sanitizeProviderList(env = process.env) {
  const chain = (env.LLM_PROVIDER_CHAIN || env.LLM_PROVIDER || 'gemini')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  return chain.length ? chain : ['gemini'];
}

function buildGenerationConfig(env = process.env) {
  return {
    temperature: Number.isFinite(Number(env.LLM_TEMPERATURE)) ? Number(env.LLM_TEMPERATURE) : DEFAULT_TEMP,
    maxOutputTokens: Number.isFinite(Number(env.LLM_MAX_TOKENS)) ? Number(env.LLM_MAX_TOKENS) : DEFAULT_MAX_TOKENS
  };
}

function resolveFetch() {
  if (typeof fetch !== 'undefined') return fetch;
  return fetchNative;
}

function cleanMessages(messages = []) {
  return messages.slice(-12).map((m) => ({
    role: m.role === 'assistant' || m.role === 'model' ? 'assistant' : 'user',
    content: String(m.content ?? '')
  }));
}

export function createLLMClient({ env = process.env, logger = console } = {}) {
  const fetchImpl = resolveFetch();
  const generationConfig = buildGenerationConfig(env);
  const providerChain = sanitizeProviderList(env).filter((name) => {
    if (!SUPPORTED.has(name)) {
      logger?.warn?.(`[llm] Ignoring unsupported provider "${name}"`);
      return false;
    }
    return true;
  });

  if (!providerChain.length) providerChain.push('gemini');

  const providers = {
    gemini: {
      isReady: () => Boolean(env.GEMINI_API_KEY),
      id: () => (env.GEMINI_MODEL || 'models/gemini-2.5-flash'),
      async generate(prompt, context = {}) {
        if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
        const body = {
          contents: [
            { role: 'user', parts: [{ text: prompt }] },
            { role: 'user', parts: [{ text: `Context JSON (truncated):\n${JSON.stringify(context).slice(0, 6000)}` }] }
          ],
          generationConfig
        };
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(providers.gemini.id().replace(/^models\//, ''))}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
        const res = await fetchImpl(endpoint, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
        if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || '';
      },
      async chat(messages, context = {}) {
        if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
        const contents = [];
        for (const msg of cleanMessages(messages)) {
          const role = msg.role === 'assistant' ? 'model' : 'user';
          contents.push({ role, parts: [{ text: msg.content }] });
        }
        contents.push({ role: 'user', parts: [{ text: `Context JSON (truncated):\n${JSON.stringify(context).slice(0, 6000)}` }] });
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(providers.gemini.id().replace(/^models\//, ''))}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
        const res = await fetchImpl(endpoint, { method: 'POST', body: JSON.stringify({ contents, generationConfig }), headers: { 'Content-Type': 'application/json' } });
        if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || '';
      }
    },
    openai: {
      isReady: () => Boolean(env.OPENAI_API_KEY),
      id: () => env.OPENAI_MODEL || 'gpt-4o-mini',
      async generate(prompt, context = {}) {
        if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
        const body = {
          model: providers.openai.id(),
          temperature: generationConfig.temperature,
          max_tokens: generationConfig.maxOutputTokens,
          messages: [
            { role: 'system', content: 'You are a data assistant.' },
            { role: 'user', content: `${prompt}\n\nContext JSON (truncated):\n${JSON.stringify(context).slice(0, 6000)}` }
          ]
        };
        const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENAI_API_KEY}`
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
        const data = await res.json();
        return data?.choices?.[0]?.message?.content || '';
      },
      async chat(messages, context = {}) {
        if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
        const adapted = [
          { role: 'system', content: 'You are a data analyst for smart buildings.' },
          ...cleanMessages(messages).map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: `Context JSON (truncated):\n${JSON.stringify(context).slice(0, 6000)}` }
        ];
        const body = {
          model: providers.openai.id(),
          temperature: generationConfig.temperature,
          max_tokens: generationConfig.maxOutputTokens,
          messages: adapted
        };
        const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENAI_API_KEY}`
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
        const data = await res.json();
        return data?.choices?.[0]?.message?.content || '';
      }
    },
    mock: {
      isReady: () => true,
      id: () => 'mock-agent',
      async generate(prompt) {
        return `{"action":"final","answer":"Mock response for prompt: ${prompt.slice(0, 40)}","chart":null}`;
      },
      async chat() {
        return '{"action":"final","answer":"Mock response","chart":null}';
      }
    }
  };

  function providerReady(name) {
    return providers[name]?.isReady?.() || false;
  }

  async function runWithProviders(fn) {
    let lastError = null;
    const retries = Math.max(1, Number(env.LLM_CHAT_RETRIES || 3));
    const baseDelay = Math.max(250, Number(env.LLM_CHAT_BACKOFF_MS || 750));

    for (let attempt = 0; attempt < retries; attempt += 1) {
      for (const name of providerChain) {
        if (!providerReady(name)) {
          lastError = new Error(`Provider ${name} not configured`);
          continue;
        }
        try {
          const result = await fn(providers[name]);
          if (result && String(result).trim()) {
            return result;
          }
          lastError = new Error(`Empty response from ${name}`);
        } catch (err) {
          lastError = err;
          logger?.warn?.(`[llm] ${name} attempt failed: ${err?.message || err}`);
        }
      }
      if (attempt < retries - 1) {
        const delay = Math.min(10_000, baseDelay * Math.pow(2, attempt));
        await wait(delay);
      }
    }
    throw lastError || new Error('LLM invocation failed');
  }

  return {
    providerChain,
    isReady() {
      return providerChain.some((name) => providerReady(name));
    },
    async generate(prompt, context) {
      return runWithProviders((provider) => provider.generate(prompt, context));
    },
    async chat(messages, context) {
      return runWithProviders((provider) => provider.chat(messages, context));
    }
  };
}
