// 页面内对话框组件:替代浏览器原生 prompt/confirm(样式与书签对话框同源)。
//
//   confirmDialog({ title, message, confirmText, danger }) -> Promise<boolean>
//     确认返回 true,取消(含 Esc/点遮罩)返回 false。
//   choiceDialog({ title, message, choices }) -> Promise<value|null>
//     choices: [{ label, value, primary?, danger? }];返回被选中的 value,取消返回 null。
//   formDialog({ title, fields, confirmText, danger, note }) -> Promise<Object|null>
//     fields: [{ key, label, type: 'text'|'textarea'|'password', value, placeholder }]
//     确认返回 { key: value, ... },取消返回 null。
// Enter 提交(单行输入框)、Esc 取消;打开时自动聚焦第一个输入框并全选。

import { escapeHtml } from './util.js';

/**
 * 打开遮罩层。build(close) 填充内容并绑定按钮;
 * close(result) 关闭并 resolve(result)。
 */
function openOverlay(build) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'bm-overlay dlg-overlay';
    const close = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    // build 返回的是 DOM 元素,必须用 append;赋给 innerHTML 会被转成 "[object HTMLDivElement]"
    overlay.append(build(close));
    document.body.appendChild(overlay);
    const first = overlay.querySelector('input, textarea');
    if (first) {
      first.focus();
      if (first.select) first.select();
    }
  });
}

function footerHtml(close, confirmText, danger) {
  const frag = document.createElement('div');
  frag.className = 'row';
  frag.style.cssText = 'margin-top:12px;justify-content:flex-end;';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => close(null));
  const ok = document.createElement('button');
  ok.className = 'btn ' + (danger ? 'danger' : 'primary');
  ok.textContent = confirmText;
  frag.append(cancel, ok);
  return frag;
}

/** 确认对话框(替代 confirm)。 */
export function confirmDialog({ title = '确认', message = '', confirmText = '确定', danger = false } = {}) {
  return openOverlay((close) => {
    const box = document.createElement('div');
    box.className = 'bm-dialog';
    box.style.width = 'min(460px,92vw)';
    const h = document.createElement('h3');
    h.textContent = title;
    const body = document.createElement('div');
    body.style.cssText = 'white-space:pre-wrap;font-size:13.5px;line-height:1.7;';
    body.textContent = message;
    box.append(h, body, footerHtml(close, confirmText, danger));
    box.querySelector('.row .btn:last-child').addEventListener('click', () => close(true));
    return box;
  });
}

/** 多选一对话框。choices: [{label, value, primary?, danger?}]。
 *  返回被选中的 value；取消（Esc/遮罩/取消按钮）返回 null。 */
export function choiceDialog({ title = '请选择', message = '', choices = [] } = {}) {
  return openOverlay((close) => {
    const box = document.createElement('div');
    box.className = 'bm-dialog';
    box.style.width = 'min(460px,92vw)';
    const h = document.createElement('h3');
    h.textContent = title;
    const body = document.createElement('div');
    body.style.cssText = 'white-space:pre-wrap;font-size:13.5px;line-height:1.7;';
    body.textContent = message;
    const foot = document.createElement('div');
    foot.className = 'row';
    foot.style.cssText = 'margin-top:12px;justify-content:flex-end;flex-wrap:wrap;gap:8px;';
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => close(null));
    foot.append(cancel);
    for (const c of choices) {
      const b = document.createElement('button');
      b.className = 'btn ' + (c.danger ? 'danger' : (c.primary ? 'primary' : ''));
      b.textContent = c.label;
      b.addEventListener('click', () => close(c.value));
      foot.append(b);
    }
    box.append(h, body, foot);
    return box;
  });
}

/** 表单对话框(替代 prompt)。确认返回 {key: value};取消返回 null。 */export function formDialog({ title = '', fields = [], confirmText = '确定', danger = false, note = '' } = {}) {
  return openOverlay((close) => {
    const box = document.createElement('div');
    box.className = 'bm-dialog';
    box.style.width = 'min(480px,92vw)';
    const h = document.createElement('h3');
    h.textContent = title;
    box.append(h);
    if (note) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.style.cssText = 'font-size:12px;margin:0 0 8px;';
      p.textContent = note;
      box.append(p);
    }
    for (const f of fields) {
      const label = document.createElement('label');
      label.style.cssText = 'display:block;margin-top:10px;';
      label.textContent = f.label || '';
      let input;
      if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 4;
        input.style.cssText = 'width:100%;box-sizing:border-box;font-size:13px;margin-top:4px;';
        input.value = f.value ?? '';
      } else {
        input = document.createElement('input');
        input.type = f.type === 'password' ? 'password' : 'text';
        input.style.cssText = 'width:100%;box-sizing:border-box;';
        input.value = f.value ?? '';
        // 单行输入框 Enter = 确认
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            okBtn.click();
          }
        });
      }
      if (f.placeholder) input.placeholder = f.placeholder;
      input.dataset.dlgField = f.key;
      label.append(input);
      box.append(label);
    }
    const foot = footerHtml(close, confirmText, danger);
    const okBtn = foot.querySelector('.btn:last-child');
    okBtn.addEventListener('click', () => {
      const values = {};
      for (const input of box.querySelectorAll('[data-dlg-field]')) {
        values[input.dataset.dlgField] = input.value;
      }
      close(values);
    });
    box.append(foot);
    return box;
  });
}
