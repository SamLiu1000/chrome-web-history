// 添加书签对话框：模拟浏览器原生收藏弹窗 —— 可编辑标题、选存放文件夹，
// 确认后才写入浏览器书签。取消则什么都不做。
// openBookmarkDialog({ url, title }) -> Promise<{ saved: boolean }>

import { getBookmarkFolders } from './bookmarks.js';

export function openBookmarkDialog({ url, title = '' }) {
  return new Promise((resolve) => {
    (async () => {
      let folders = [];
      try {
        folders = await getBookmarkFolders();
      } catch { /* 无权限时退化为不选文件夹（写入"其他书签"） */ }
      const defaultFolder = folders.find((f) => f.id === '1') || folders[0] || null;

      // ---- DOM ----
      const overlay = document.createElement('div');
      overlay.className = 'bm-overlay';
      const dlg = document.createElement('div');
      dlg.className = 'bm-dialog';
      dlg.innerHTML = `
        <div class="bm-title">添加书签</div>
        <label class="bm-label">名称</label>
        <input type="text" class="bm-input" id="bmNameInput">
        <label class="bm-label">网址</label>
        <div class="bm-url" title=""></div>
        <label class="bm-label">文件夹</label>
        <select class="bm-input" id="bmFolderSel">
          ${folders.map((f) =>
            `<option value="${f.id}" ${defaultFolder && f.id === defaultFolder.id ? 'selected' : ''}>${f.title}</option>`
          ).join('')}
        </select>
        <div class="bm-actions">
          <button class="btn" id="bmCancel">取消</button>
          <button class="btn primary" id="bmSave">保存</button>
        </div>`;
      overlay.appendChild(dlg);
      document.body.appendChild(overlay);

      const nameInput = dlg.querySelector('#bmNameInput');
      const urlDiv = dlg.querySelector('.bm-url');
      const folderSel = dlg.querySelector('#bmFolderSel');
      nameInput.value = title || url;
      urlDiv.textContent = url;
      urlDiv.title = url;

      let done = false;
      const close = (saved) => {
        if (done) return;
        done = true;
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve({ saved });
      };
      const onSave = async () => {
        const t = nameInput.value.trim() || url;
        const parentId = folderSel.value || undefined;
        try {
          await chrome.bookmarks.create({ url, title: t, parentId });
          close(true);
        } catch (err) {
          alert('添加书签失败：' + (err?.message || err));
        }
      };
      const onKey = (e) => {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Enter' && document.activeElement !== folderSel) { e.preventDefault(); onSave(); }
      };
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
      dlg.querySelector('#bmCancel').addEventListener('click', () => close(false));
      dlg.querySelector('#bmSave').addEventListener('click', onSave);
      document.addEventListener('keydown', onKey, true);

      nameInput.focus();
      nameInput.select();
    })();
  });
}
