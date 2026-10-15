// 轻量提示气泡：所有视图共用。
// 独立成模块的原因：views 之前从 dashboard.js 反向导入 toast，导致轻量页
// （stash.html）必须加载整个仪表盘框架才能用收纳视图；解开这层耦合后，
// 轻量页只需引入本文件即可。元素不存在时自行创建（轻量页没有静态 #toast）。

let toastTimer = null;

function ensureToastEl() {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

export function toast(msg, isError = false) {
  const el = ensureToastEl();
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}
