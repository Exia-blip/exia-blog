// friends.html.tmp.mjs
import { api, esc, mountHeader, toast } from "/app.js";
var grid = document.getElementById("grid");
var SEED = window.__FRIENDS__ || null;
function iconHTML(f) {
  if (f.avatar)
    return `<img class="fav" src="${esc(f.avatar)}" alt="" loading="lazy" decoding="async" width="38" height="38">`;
  const ch = String(f.name || "?").trim().charAt(0).toUpperCase() || "?";
  return `<span class="fav ph" aria-hidden="true">${esc(ch)}</span>`;
}
var USER_ADMIN = false;
function bindDeletes() {
  if (!USER_ADMIN)
    return;
  grid.querySelectorAll(".friend-card").forEach((a) => {
    if (a.querySelector("[data-del]"))
      return;
    const id = a.dataset.id;
    if (!id)
      return;
    const btn = document.createElement("button");
    btn.className = "btn sm";
    btn.dataset.del = id;
    btn.textContent = "\xD7";
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm("\u5220\u9664\u8FD9\u6761\u53CB\u94FE\uFF1F"))
        return;
      await api("/api/friends/" + id, { method: "DELETE" });
      toast("\u5DF2\u5220\u9664");
      load();
    };
    a.appendChild(btn);
  });
}
function paint(friends) {
  if (!friends.length) {
    grid.innerHTML = '<div class="empty">\u8FD8\u6CA1\u6709\u53CB\u94FE</div>';
    return;
  }
  grid.innerHTML = friends.map((f) => `
      <a class="friend-card" href="${esc(f.url)}" target="_blank" rel="noopener" data-id="${f.id}">
        ${iconHTML(f)}
        <div class="info">
          <div class="nm">
            <span class="dot ${f.status ? "on" : "off"}" title="${f.status ? "\u53EF\u8BBF\u95EE" : "\u65E0\u6CD5\u8BBF\u95EE"}"></span>
            ${esc(f.name)}
          </div>
          <div class="ds">${esc(f.desc || new URL(f.url).hostname)}</div>
        </div>
      </a>`).join("");
  bindDeletes();
}
async function load() {
  try {
    const { friends } = await api("/api/friends");
    paint(friends);
  } catch (e) {
    if (!SEED)
      grid.innerHTML = `<div class="empty">\u52A0\u8F7D\u5931\u8D25\uFF1A${esc(e.message)}</div>`;
  }
}
var user = await mountHeader("friends");
USER_ADMIN = !!(user && user.is_admin);
if (USER_ADMIN)
  document.getElementById("admin-box").style.display = "block";
if (SEED)
  bindDeletes();
else
  load();
document.getElementById("add-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const d = new FormData(e.target);
  try {
    await api("/api/friends", {
      method: "POST",
      body: {
        name: d.get("name") || "",
        url: d.get("url") || "",
        avatar: d.get("avatar") || "",
        desc: d.get("desc") || ""
      }
    });
    e.target.reset();
    toast("\u5DF2\u6DFB\u52A0\uFF0C\u6B63\u5728\u68C0\u6D4B\u72B6\u6001\u2026");
    setTimeout(load, 1500);
  } catch (err) {
    toast(err.message);
  }
});
document.getElementById("recheck")?.addEventListener("click", async () => {
  toast("\u68C0\u6D4B\u4E2D\u2026", 6e3);
  try {
    const r = await api("/api/friends/check", { method: "POST" });
    toast(`\u68C0\u6D4B\u5B8C\u6210\uFF0C\u5171 ${r.checked} \u4E2A`);
    load();
  } catch (e) {
    toast(e.message);
  }
});
