// Демо-панель на сторінці: будується в DOM так само, як це роблять реальні розширення.
(() => {
  const box = document.createElement('div');
  box.id = 'demo-panel';
  box.innerHTML = `
    <div class="dp-head">Демо панель на сторінці</div>
    <div class="dp-body">
      <label class="dp-label">Канал</label>
      <select class="dp-select"><option>Основний</option><option>Резервний</option></select>
      <button class="dp-btn">Застосувати</button>
      <div class="dp-status">Готово до роботи</div>
    </div>
  `;
  document.body.appendChild(box);
})();
