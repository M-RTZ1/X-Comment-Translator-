// Content script for X.com / Twitter: finds tweet/reply text blocks,
// translates them in bulk via the background service worker, and injects
// the translation next to the original with proper RTL handling.

(() => {
  'use strict';

  const SEL_TWEET_TEXT = 'article [data-testid="tweetText"]';
  const RTL_LANGS = new Set(['fa', 'ar', 'he', 'ur', 'ps', 'sd', 'ug', 'ckb', 'yi']);
  const LANG_NAMES = {
    fa: 'فارسی',
    ar: 'العربية',
    en: 'English',
    tr: 'Türkçe',
    ur: 'اردو',
    he: 'עברית',
    hi: 'हिन्दी',
    'zh-CN': '中文（简体）',
    ja: '日本語',
    ko: '한국어',
    ru: 'Русский',
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    pt: 'Português',
    it: 'Italiano',
    nl: 'Nederlands',
    pl: 'Polski',
    uk: 'Українська',
    id: 'Bahasa Indonesia',
    vi: 'Tiếng Việt',
    th: 'ไทย',
  };

  const state = {
    target: 'fa',
    showOriginal: true,
    auto: false,
    busy: false,
    gen: 0, // bumped on restore so in-flight jobs abort cleanly
    cache: new Map(), // key -> { text, detected }
    records: new Map(), // original element -> record
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Run async workers over items with a concurrency cap.
  async function pool(items, limit, worker) {
    let i = 0;
    const runners = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (i < items.length) {
          const idx = i++;
          try {
            await worker(items[idx]);
          } catch (_e) {
            /* counted by caller */
          }
        }
      }
    );
    await Promise.all(runners);
  }

  function normalize(raw) {
    return raw.replace(/\s+/g, ' ').trim();
  }

  // ---------------- settings ----------------

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        { target: 'fa', showOriginal: true, mode: 'manual' },
        (s) => {
          state.target = s.target;
          state.showOriginal = s.showOriginal;
          state.auto = s.mode === 'auto';
          resolve();
        }
      );
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.target) state.target = changes.target.newValue;
    if (changes.showOriginal) state.showOriginal = changes.showOriginal.newValue;
    if (changes.mode) {
      state.auto = changes.mode.newValue === 'auto';
      if (state.auto) scheduleScan(200);
    }
  });

  // ---------------- translation ----------------

  async function translateText(text) {
    const key = state.target + '::' + text.toLowerCase();
    if (state.cache.has(key)) return state.cache.get(key);
    const resp = await chrome.runtime.sendMessage({
      type: 'translate',
      text,
      tl: state.target,
    });
    if (!resp || !resp.ok) throw new Error(resp ? resp.error : 'no response');
    const entry = { text: resp.text, detected: resp.detected || null };
    state.cache.set(key, entry);
    return entry;
  }

  async function processElement(el, gen) {
    if (state.records.has(el)) return 'skip';
    const raw = normalize(el.textContent);
    if (!raw) return 'skip';

    const entry = await translateText(raw);
    if (gen !== state.gen) return 'abort'; // originals were restored meanwhile

    if (
      entry.detected &&
      entry.detected.split('-')[0] === state.target.split('-')[0]
    ) {
      return 'same-lang';
    }
    injectTranslation(el, entry.text);
    return 'translated';
  }

  // ---------------- DOM injection ----------------

  function visibleTexts() {
    return [...document.querySelectorAll(SEL_TWEET_TEXT)].filter(
      (el) => el.offsetParent !== null && normalize(el.textContent).length > 0
    );
  }

  function injectTranslation(el, translated) {
    const doc = el.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.className = 'xtx-wrap';

    const bar = doc.createElement('div');
    bar.className = 'xtx-bar';

    const tag = doc.createElement('span');
    tag.className = 'xtx-tag';
    tag.textContent = LANG_NAMES[state.target] || state.target;

    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'xtx-btn';

    const body = doc.createElement('div');
    body.className = 'xtx-body';
    body.dir = RTL_LANGS.has(state.target.split('-')[0]) ? 'rtl' : 'ltr';
    body.textContent = translated; // textContent only -> no XSS surface

    bar.append(tag, btn);
    wrap.append(bar, body);

    const record = { el, wrap, btn, hideOrig: !state.showOriginal };
    syncVisibility(record);
    btn.addEventListener('click', () => {
      record.hideOrig = !record.hideOrig;
      syncVisibility(record);
    });

    el.insertAdjacentElement('afterend', wrap);
    state.records.set(el, record);
  }

  function syncVisibility(record) {
    record.el.style.display = record.hideOrig ? 'none' : '';
    record.btn.textContent = record.hideOrig ? 'نمایش متن اصلی' : 'پنهان کردن اصلی';
  }

  // ---------------- bulk actions ----------------

  async function translateVisible({ silent } = {}) {
    if (state.busy) return { ok: true, reason: 'busy' };
    const els = visibleTexts().filter((el) => !state.records.has(el));
    if (!els.length) {
      flash(silent ? '' : 'چیز جدیدی برای ترجمه نیست');
      return { ok: true, total: 0, translated: 0, failed: 0 };
    }
    state.busy = true;
    const gen = state.gen;
    const total = els.length;
    let done = 0;
    let translated = 0;
    let failed = 0;

    if (!silent) showStatus(`۰ از ${total}`);
    await pool(els, 4, async (el) => {
      try {
        const r = await processElement(el, gen);
        if (r === 'translated') translated++;
      } catch (_e) {
        failed++;
      }
      done++;
      if (!silent) {
        showStatus(`${done} از ${total}` + (failed ? ` (${failed} خطا)` : ''));
      }
    });
    state.busy = false;

    if (!silent) {
      if (translated) flash(`${translated} دیدگاه ترجمه شد`);
      else if (failed) flash('خطا در دریافت ترجمه — دوباره تلاش کنید');
      else flash('همه از قبل ترجمه شده‌اند');
    } else {
      refreshFabLabel();
    }
    return { ok: true, total, translated, failed };
  }

  function restoreAll() {
    state.gen++;
    for (const record of state.records.values()) {
      record.wrap.remove();
      record.el.style.display = '';
    }
    state.records.clear();
    refreshFabLabel();
    flash('متن اصلی بازگردانده شد');
    return { ok: true };
  }

  // ---------------- auto mode ----------------

  let scanTimer = null;
  function scheduleScan(delay = 500) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (state.auto) translateVisible({ silent: true });
    }, delay);
  }

  const observer = new MutationObserver((mutations) => {
    if (!state.auto) return;
    for (const m of mutations) {
      let relevant = false;
      for (const n of m.addedNodes) {
        // Ignore nodes we inserted ourselves to avoid feedback loops.
        if (n.nodeType === 1) {
          if (n.classList && n.classList.contains('xtx-wrap')) continue;
          if (n.querySelector && n.querySelector('.xtx-wrap')) continue;
          relevant = true;
          break;
        }
      }
      if (relevant) {
        scheduleScan();
        return;
      }
    }
  });

  // ---------------- floating button + status ----------------

  let statusTimer = null;

  function buildFab() {
    if (document.getElementById('xtx-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'xtx-fab';
    fab.type = 'button';
    const main = document.createElement('span');
    main.className = 'xtx-fab-main';
    const alt = document.createElement('span');
    alt.className = 'xtx-fab-alt';
    alt.textContent = 'Translate comments';
    fab.append(main, alt);

    const status = document.createElement('div');
    status.id = 'xtx-status';
    status.hidden = true;

    fab.addEventListener('click', () => {
      if (state.records.size) restoreAll();
      else translateVisible();
    });

    document.body.append(fab, status);
    refreshFabLabel();
  }

  function refreshFabLabel() {
    const fab = document.getElementById('xtx-fab');
    if (!fab) return;
    const main = fab.querySelector('.xtx-fab-main');
    main.textContent = state.records.size ? 'بازگردانی متن اصلی' : 'ترجمه دیدگاه‌ها';
  }

  function showStatus(text) {
    clearTimeout(statusTimer);
    const s = document.getElementById('xtx-status');
    if (!s) return;
    s.hidden = false;
    s.textContent = text;
  }

  function flash(text) {
    refreshFabLabel();
    if (!text) return;
    showStatus(text);
    statusTimer = setTimeout(() => {
      const s = document.getElementById('xtx-status');
      if (s) s.hidden = true;
    }, 3500);
  }

  // ---------------- messages from popup ----------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'ping':
        sendResponse({ ok: true });
        return;
      case 'getStatus':
        sendResponse({
          ok: true,
          translated: state.records.size,
          auto: state.auto,
        });
        return;
      case 'translateAll':
        translateVisible().then(sendResponse);
        return true;
      case 'restoreAll':
        sendResponse(restoreAll());
        return;
    }
  });

  // ---------------- init ----------------

  loadSettings().then(() => {
    buildFab();
    observer.observe(document.body, { childList: true, subtree: true });
    if (state.auto) scheduleScan(800);
  });
})();
