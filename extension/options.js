const t = document.getElementById('t');
chrome.storage.local.get('token').then((v) => { t.value = v.token || ''; });
document.getElementById('s').onclick = async () => {
  await chrome.storage.local.set({ token: t.value.trim() });
  const m = document.getElementById('m');
  try {
    const r = await fetch('http://127.0.0.1:24680/ping');
    m.textContent = r.ok ? 'Saved. Mjolnir is running.' : 'Saved.';
  } catch {
    m.textContent = 'Saved. Mjolnir is not running right now.';
  }
};
