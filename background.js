// Background service worker: performs translation requests to Google
// Translate's free public endpoints. Fetching here (not in the content
// script) lets the extension's host_permissions bypass page CORS rules.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function singleUrl(text, sl, tl) {
  return (
    'https://translate.googleapis.com/translate_a/single?client=gtx' +
    `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=` +
    encodeURIComponent(text)
  );
}

function fallbackUrl(text, sl, tl) {
  return (
    'https://clients5.google.com/translate_a/t?client=dict-chrome-ex' +
    `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&q=` +
    encodeURIComponent(text)
  );
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: '*/*' } });
  if (!res.ok) {
    throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
  }
  return res.json();
}

// translate_a/single returns [[["translated","original",...],...], null, "detected"]
function parseSingle(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('unexpected payload');
  }
  const text = data[0]
    .filter((seg) => Array.isArray(seg) && typeof seg[0] === 'string')
    .map((seg) => seg[0])
    .join('');
  return { text, detected: typeof data[2] === 'string' ? data[2] : null };
}

// clients5 dict-chrome-ex returns ["ترجمه"] or [["ترجمه","orig"],...] or {sentences:[...]}
function parseFallback(data) {
  if (Array.isArray(data)) {
    if (typeof data[0] === 'string') return { text: data.join(' '), detected: null };
    if (Array.isArray(data[0]) && typeof data[0][0] === 'string') {
      return { text: data.map((d) => d[0]).join(' '), detected: null };
    }
  }
  if (data && Array.isArray(data.sentences)) {
    return {
      text: data.sentences.map((s) => s.trans || '').join(''),
      detected: data.src || null,
    };
  }
  throw new Error('unexpected payload');
}

async function googleTranslate(text, sl, tl) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await fetchJson(singleUrl(text, sl, tl));
      const parsed = parseSingle(data);
      if (parsed.text.trim()) return parsed;
      lastErr = new Error('empty translation');
    } catch (err) {
      lastErr = err;
      // Retry only on rate-limit / server errors.
      if (err.status !== 429 && err.status !== 503) break;
      await sleep(700 * Math.pow(2, attempt) + Math.random() * 300);
    }
  }
  try {
    return parseFallback(await fetchJson(fallbackUrl(text, sl, tl)));
  } catch (err) {
    lastErr = err;
  }
  throw lastErr || new Error('translation failed');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'translate') return;
  // Tweets are short; cap defensively to keep the GET URL small.
  const text = String(msg.text || '').slice(0, 1500);
  const sl = msg.sl || 'auto';
  const tl = msg.tl || 'fa';
  googleTranslate(text, sl, tl)
    .then((r) => sendResponse({ ok: true, text: r.text, detected: r.detected }))
    .catch((err) =>
      sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
  return true; // async response
});
