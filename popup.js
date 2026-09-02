const $ = (sel) => document.querySelector(sel);
const statusEl = $('#status');

function say(msg) {
  statusEl.textContent = msg;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function onX(tab) {
  return Boolean(
    tab && /^https:\/\/([\w-]+\.)*(x|twitter)\.com\//.test(tab.url || '')
  );
}

// quiet=true suppresses error text (used for the initial status probe)
async function send(type, quiet) {
  const tab = await activeTab();
  if (!onX(tab)) {
    if (!quiet) say('ابتدا یک صفحهٔ X.com را باز کنید');
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch (_e) {
    if (!quiet) say('صفحه را دوباره بارگذاری کنید (F5)');
    return null;
  }
}

function bindSetting(el, key, transform) {
  el.addEventListener('change', () => {
    const value = transform ? transform(el) : el.value;
    chrome.storage.local.set({ [key]: value });
    say('ذخیره شد');
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get({
    target: 'fa',
    mode: 'manual',
    showOriginal: true,
  });

  $('#target').value = stored.target;
  document.querySelector(`input[name="mode"][value="${stored.mode}"]`).checked = true;
  $('#showOriginal').checked = stored.showOriginal;

  bindSetting($('#target'), 'target');
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) chrome.storage.local.set({ mode: radio.value });
    });
  });
  bindSetting($('#showOriginal'), 'showOriginal', (el) => el.checked);

  $('#go').addEventListener('click', async () => {
    say('در حال ترجمه…');
    const res = await send('translateAll');
    if (!res) return;
    if (res.reason === 'busy') {
      say('ترجمه قبلی هنوز در جریان است…');
      return;
    }
    if (!res.total) {
      say('دیدگاه جدیدی یافت نشد');
      return;
    }
    say(`انجام شد: ${res.translated} ترجمه، ${res.failed} خطا`);
  });

  $('#restore').addEventListener('click', async () => {
    const res = await send('restoreAll');
    if (res && res.ok) say('متن اصلی بازگردانده شد');
  });

  const g = await send('getStatus', true);
  if (g && g.translated) say(`${g.translated} دیدگاه ترجمه‌شده در صفحه`);
});
