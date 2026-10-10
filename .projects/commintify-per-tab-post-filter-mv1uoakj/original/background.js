// Еталонка живе в локальній мережі на http, а Commintify відкритий через https.
// Запит із такої сторінки Chrome ріже (mixed content + дозвіл на локальну мережу),
// на Windows зазвичай саме тому: «Failed to fetch». Із сервіс-воркера запит іде
// від origin розширення, якому host_permissions уже дозволяють http://*/*.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'cmpf:etalon' || typeof msg.url !== 'string') return;
  fetch(msg.url, { credentials: 'omit', cache: 'no-store' })
    .then(async (res) => {
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (e) {}
      respond({ ok: res.ok, status: res.status, data, note: data ? '' : text.slice(0, 160) });
    })
    .catch((err) => respond({ ok: false, status: 0, error: String((err && err.message) || err) }));
  return true;
});
