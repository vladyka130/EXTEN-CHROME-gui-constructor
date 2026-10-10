// Демо-логіка popup: навмисно проста, щоб перевірити, що конструктор її не чіпає.
const ITEMS = ['Антенна Північ', 'Антенна Південь', 'Резервний канал', 'Точка звʼязку 4'];

function render(filter = '') {
  const list = document.getElementById('list');
  const rows = ITEMS.filter((i) => i.toLowerCase().includes(filter.toLowerCase()));
  list.innerHTML = rows.map((i) => `<li><b>›</b> ${i}</li>`).join('');
  document.getElementById('counter').textContent = rows.length + ' записів';
}

document.getElementById('quick').addEventListener('input', (e) => render(e.target.value));
document.getElementById('refresh').addEventListener('click', () => render(document.getElementById('quick').value));
render();
