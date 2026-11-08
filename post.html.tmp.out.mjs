// post.html.tmp.mjs
import { api, fmtDate, fmtRelative, esc, mountHeader, toast, me, site, bindCopyButtons, bindReadingProgress } from "/app.js";
bindCopyButtons(document);
var segs = location.pathname.split("/").filter(Boolean);
var slug = decodeURIComponent(segs[0] === "p" ? segs[1] || "" : segs[0] || "");
var page = document.getElementById("page");
var POST = window.__POST__ || null;
var USER = null;
var replyTo = null;
function hydrate() {
  const p = POST;
  const slot = document.querySelector(".post-edit");
  if (slot && USER && (USER.is_admin || USER.id === p.author_id)) {
    slot.innerHTML = `<a class="btn sm" href="/editor?id=${p.id}">\u7F16\u8F91</a>`;
  }
  bindReply();
  bindForm();
  bindReadingProgress(document.querySelector(".post-body"));
}
function fallbackNotice() {
  page.innerHTML = '<div class="empty">\u6B63\u6587\u6CA1\u53D6\u5230\uFF0C\u53EF\u80FD\u662F\u9875\u9762\u7F13\u5B58\u8FC7\u671F\u4E86\u3002<a href="javascript:location.reload()">\u5237\u65B0\u4E00\u4E0B</a></div>';
}
async function loadComments() {
  const box = document.getElementById("cmt-list");
  if (!box)
    return;
  try {
    const { comments, total } = await api("/api/comments?slug=" + encodeURIComponent(slug));
    document.getElementById("cmt-count").textContent = total ? `(${total})` : "";
    if (!comments.length) {
      box.innerHTML = '<div class="muted small" style="padding:14px 0">\u8FD8\u6CA1\u6709\u8BC4\u8BBA\uFF0C\u6765\u62A2\u6C99\u53D1\u3002</div>';
      return;
    }
    box.innerHTML = comments.map(renderCmt).join("");
  } catch (e) {
    box.innerHTML = `<div class="muted small">\u8BC4\u8BBA\u52A0\u8F7D\u5931\u8D25</div>`;
  }
}
function avatarText(name) {
  return esc(String(name || "?").slice(0, 1).toUpperCase());
}
function renderCmt(c, isChild = false) {
  const del = USER && USER.is_admin ? `<button data-del="${c.id}">\u5220\u9664</button>` : "";
  const reply = !isChild ? `<button data-reply="${c.id}" data-name="${esc(c.name)}">\u56DE\u590D</button>` : "";
  const homepage = c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener nofollow" class="muted">${esc(c.name)}</a>` : esc(c.name);
  return `
  <div class="cmt" data-cid="${c.id}">
    <div class="ava">${avatarText(c.name)}</div>
    <div class="main">
      <div class="head">
        <b>${homepage}</b>
        ${c.is_admin ? '<span class="badge-owner">\u535A\u4E3B</span>' : ""}
        <span class="when">${fmtRelative(c.created_at)}</span>
        ${USER && USER.is_admin && c.email ? `<a class="cmt-mail" href="mailto:${esc(c.email)}" title="\u8054\u7CFB\u90AE\u7BB1\uFF0C\u4EC5\u7BA1\u7406\u5458\u53EF\u89C1">${esc(c.email)}</a>` : ""}
      </div>
      <div class="text">${esc(c.content)}</div>
      <div class="acts">${reply}${del}</div>
      ${c.replies && c.replies.length ? `<div class="replies">${c.replies.map((r) => renderCmt(r, true)).join("")}</div>` : ""}
    </div>
  </div>`;
}
function bindReply() {
  const box = document.getElementById("cmt-list");
  if (!box)
    return;
  box.addEventListener("click", async (e) => {
    const r = e.target.closest("[data-reply]");
    if (r) {
      replyTo = { id: +r.dataset.reply, name: r.dataset.name };
      const hint = document.getElementById("reply-hint");
      hint.style.display = "block";
      hint.innerHTML = `\u56DE\u590D <b>${esc(replyTo.name)}</b> \xB7 <a href="javascript:;" id="cancel-reply">\u53D6\u6D88</a>`;
      document.getElementById("cancel-reply").onclick = () => {
        replyTo = null;
        hint.style.display = "none";
      };
      document.querySelector("#cmt-form textarea").focus();
      return;
    }
    const d = e.target.closest("[data-del]");
    if (d) {
      if (!confirm("\u5220\u9664\u8FD9\u6761\u8BC4\u8BBA\uFF1F\u5176\u4E0B\u7684\u56DE\u590D\u4E5F\u4F1A\u4E00\u5E76\u5220\u9664\u3002"))
        return;
      try {
        await api("/api/comments/" + d.dataset.del, { method: "DELETE" });
        toast("\u5DF2\u5220\u9664");
        loadComments();
      } catch (err) {
        toast(err.message);
      }
    }
  });
}
function bindForm() {
  const form = document.getElementById("cmt-form");
  const f = form.elements;
  const field = (n) => f.namedItem(n);
  if (USER) {
    const nameEl = field("name");
    nameEl.value = USER.name || USER.login || "";
    nameEl.readOnly = true;
    nameEl.title = "\u767B\u5F55\u8D26\u53F7\u7684\u6635\u79F0\uFF0C\u65E0\u9700\u586B\u5199";
  }
  try {
    const saved = JSON.parse(localStorage.getItem("cmt:guest") || "{}");
    if (!USER) {
      if (saved.name)
        field("name").value = saved.name;
      if (saved.email)
        field("email").value = saved.email;
      if (saved.website)
        field("website").value = saved.website;
    } else {
      field("email").value = USER.email || saved.email || "";
      if (saved.website)
        field("website").value = saved.website;
    }
  } catch {
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = field("content").value.trim();
    const name = field("name").value.trim();
    const email = field("email").value.trim();
    const website = field("website").value.trim();
    if (!content) {
      toast("\u8BF4\u70B9\u4EC0\u4E48\u5427");
      field("content").focus();
      return;
    }
    if (!name) {
      toast("\u8BF7\u5148\u586B\u6635\u79F0");
      field("name").focus();
      return;
    }
    if (!email) {
      toast("\u8BF7\u586B\u5199\u8054\u7CFB\u90AE\u7BB1");
      field("email").focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast("\u90AE\u7BB1\u683C\u5F0F\u4E0D\u6B63\u786E");
      field("email").focus();
      return;
    }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "\u53D1\u9001\u4E2D\u2026";
    try {
      await api("/api/comments", {
        method: "POST",
        body: {
          slug,
          content,
          parent_id: replyTo?.id || null,
          name,
          email,
          website
        }
      });
      localStorage.setItem("cmt:guest", JSON.stringify({ name: USER ? "" : name, email, website }));
      field("content").value = "";
      replyTo = null;
      document.getElementById("reply-hint").style.display = "none";
      toast("\u8BC4\u8BBA\u5DF2\u53D1\u5E03");
      loadComments();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "\u53D1\u8868\u8BC4\u8BBA";
    }
  });
}
USER = await mountHeader();
if (POST) {
  hydrate();
  loadComments();
} else {
  fallbackNotice();
}
