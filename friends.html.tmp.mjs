
import { api, esc, mountHeader, toast } from '/app.js';

const grid = document.getElementById('grid');

// Worker 已经把卡片渲染进 HTML 了。有这份数据就不重建 DOM，
// 只补管理员才有的删除按钮——否则爬虫抓到的是「加载中」，用户首屏也会闪一下。
const SEED = window.__FRIENDS__ || null;

// 与 Worker 的 friendIcon 同一套规则：有自家头像才出图，否则首字母方块。
// 不再回 Google 的 s2/favicons —— 那是一个友链一次第三方请求。
function iconHTML(f) {
  if (f.avatar) return `<img class="fav" src="${esc(f.avatar)}" alt="" loading="lazy" decoding="async" width="38" height="38">`;
  const ch = String(f.name || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="fav ph" aria-hidden="true">${esc(ch)}</span>`;
}

let USER_ADMIN = false;

function bindDeletes() {
  if (!USER_ADMIN) return;
  grid.querySelectorAll('.friend-card').forEach((a) => {
    if (a.querySelector('[data-del]')) return;
    const id = a.dataset.id;
    if (!id) return;
    const btn = document.createElement('button');
    btn.className = 'btn sm';
    btn.dataset.del = id;
    btn.textContent = '×';
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm('删除这条友链？')) return;
      await api('/api/friends/' + id, { method: 'DELETE' });
      toast('已删除');
      load();
    };
    a.appendChild(btn);
  });
}

// 与 Worker 的 friendsBody 同一套三态规则：1 正常 / 2 有响应但状态异常 / 0 拿不到响应
function dotState(f) {
  const n = Number(f.status);
  return n === 1 ? 'on' : n === 2 ? 'warn' : 'off';
}
function dotLabel(f) {
  const st = dotState(f);
  const base = st === 'on' ? '可访问' : st === 'warn' ? `有响应（HTTP ${f.http_status || '?'}）` : '无法访问';
  return f.latency_ms > 0 ? `${base} · ${f.latency_ms}ms` : base;
}

function paint(friends) {
  if (!friends.length) {
    grid.innerHTML = '<div class="empty">还没有友链</div>';
    return;
  }
  grid.innerHTML = friends.map((f) => `
      <a class="friend-card" href="${esc(f.url)}" target="_blank" rel="noopener" data-id="${f.id}">
        ${iconHTML(f)}
        <div class="info">
          <div class="nm">
            <span class="dot ${dotState(f)}" title="${dotLabel(f)}"></span>
            ${esc(f.name)}
          </div>
          <div class="ds">${esc(f.desc || new URL(f.url).hostname)}</div>
        </div>
      </a>`).join('');
  bindDeletes();
}

async function load() {
  try {
    const { friends } = await api('/api/friends');
    paint(friends);
  } catch (e) {
    // 首屏已经有 SSR 内容时，刷新失败不该把页面清空
    if (!SEED) grid.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

const user = await mountHeader('friends');
USER_ADMIN = !!(user && user.is_admin);
if (USER_ADMIN) document.getElementById('admin-box').style.display = 'block';

if (SEED) bindDeletes();
else load();

document.getElementById('add-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  // 用 FormData 取值：form.name 拿到的是 <form> 的 name 属性（空串），不是输入框
  const d = new FormData(e.target);
  try {
    await api('/api/friends', {
      method: 'POST',
      body: {
        name: d.get('name') || '',
        url: d.get('url') || '',
        avatar: d.get('avatar') || '',
        desc: d.get('desc') || '',
      },
    });
    e.target.reset();
    toast('已添加，正在检测状态…');
    setTimeout(load, 1500);
  } catch (err) { toast(err.message); }
});

document.getElementById('recheck')?.addEventListener('click', async () => {
  toast('检测中…', 6000);
  try {
    const r = await api('/api/friends/check', { method: 'POST' });
    toast(`检测完成，共 ${r.checked} 个`);
    load();
  } catch (e) { toast(e.message); }
});
