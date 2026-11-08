// index.html.tmp.mjs
import { api, fmtDate, esc, mountHeader, toast, site } from "/app.js";
import { autoThumb } from "/cover.js";
var listEl = document.getElementById("list");
var tagbarEl = document.getElementById("tagbar");
var catbarEl = document.getElementById("catbar");
var pagerEl = document.getElementById("pager");
var qInput = document.getElementById("q");
var pathParts = location.pathname.split("/").filter(Boolean);
var currentTag = pathParts[0] === "tag" ? decodeURIComponent(pathParts[1] || "") : "";
var currentCat = pathParts[0] === "cat" ? decodeURIComponent(pathParts[1] || "") : "";
var currentQ = new URLSearchParams(location.search).get("q") || "";
var page = parseInt(new URLSearchParams(location.search).get("page") || "1", 10) || 1;
qInput.value = currentQ;
var SITE = await site();
if (currentCat) {
  const C = window.__CAT__ || {};
  const cname = C.name || currentCat;
  document.getElementById("hero-title").textContent = cname;
  document.getElementById("hero-sub").textContent = C.desc || `\u680F\u76EE\u300C${cname}\u300D\u4E0B\u7684\u5168\u90E8\u6587\u7AE0`;
  document.title = `${cname} \xB7 ${SITE.name}`;
} else if (currentTag) {
  if (!document.title.startsWith("#")) {
    document.getElementById("hero-title").textContent = `#${currentTag}`;
    document.getElementById("hero-sub").textContent = `\u6807\u7B7E\u300C${currentTag}\u300D\u4E0B\u7684\u5168\u90E8\u6587\u7AE0`;
    document.title = `#${currentTag} \xB7 ${SITE.name}`;
  }
} else if (currentQ) {
  document.getElementById("hero-title").textContent = `\u641C\u7D22\uFF1A${currentQ}`;
  document.getElementById("hero-sub").textContent = "\u6807\u9898\u4E0E\u6B63\u6587\u5173\u952E\u8BCD\u5339\u914D";
  document.title = `${currentQ} \xB7 \u641C\u7D22`;
} else {
  document.getElementById("hero-title").textContent = SITE.name;
  document.getElementById("hero-sub").textContent = SITE.desc || "\u8BB0\u5F55\u601D\u8003\u3001\u4EE3\u7801\u4E0E\u751F\u6D3B\u3002";
  document.title = SITE.name;
}
var ctrl = null;
async function load() {
  if (ctrl)
    ctrl.abort();
  ctrl = new AbortController();
  const mine = ctrl;
  listEl.setAttribute("aria-busy", "true");
  listEl.innerHTML = skeleton();
  const params = new URLSearchParams({ page: String(page), size: "10" });
  if (currentTag)
    params.set("tag", currentTag);
  if (currentCat)
    params.set("cat", currentCat);
  if (currentQ)
    params.set("q", currentQ);
  try {
    const { posts, total, pages } = await api("/api/posts?" + params, { signal: mine.signal });
    if (mine !== ctrl)
      return;
    if (!posts.length) {
      listEl.innerHTML = `<div class="empty">${currentQ ? "\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u6587\u7AE0" : "\u8FD8\u6CA1\u6709\u6587\u7AE0\uFF0C\u53BB\u5199\u7B2C\u4E00\u7BC7\u5427"}</div>`;
      pagerEl.innerHTML = "";
      return;
    }
    listEl.innerHTML = posts.map(card).join("");
    renderPager(pages, total);
  } catch (e) {
    if (e.name === "AbortError" || mine !== ctrl)
      return;
    listEl.innerHTML = `<div class="empty">\u52A0\u8F7D\u5931\u8D25\uFF1A${esc(e.message)}<br><a class="btn sm" href="javascript:location.reload()" style="margin-top:12px">\u91CD\u8BD5</a></div>`;
  } finally {
    if (mine === ctrl)
      listEl.setAttribute("aria-busy", "false");
  }
}
function skeleton(n = 3) {
  return Array.from({ length: n }).map(
    () => '<div class="sk-card"><div class="sk sk-thumb"></div><div class="sk-body"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div></div>'
  ).join("");
}
function card(p) {
  return `
  <a class="post-card" href="/p/${encodeURIComponent(p.slug)}">
    <img class="thumb" src="${esc(p.cover || autoThumb(p))}" alt="" loading="lazy" decoding="async" width="208" height="136">
    <div class="body">
      <h2>${esc(p.title)}${p.is_private ? ' <span class="tiny muted">\u79C1\u5BC6</span>' : ""}</h2>
      ${p.excerpt ? `<p class="excerpt">${esc(p.excerpt)}</p>` : ""}
      <div class="meta">
        <span>${fmtDate(p.published_at || p.created_at)}</span>
        <span class="sep-dot">${p.reading} \u5206\u949F</span>
        ${p.comments ? `<span class="sep-dot">${p.comments} \u6761\u8BC4\u8BBA</span>` : ""}
        ${p.category ? `<span class="tag cat-chip">${esc(p.category_name || p.category)}</span>` : ""}
        ${(p.tags || []).slice(0, 3).map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}
      </div>
    </div>
  </a>`;
}
function renderPager(pages, total) {
  if (pages <= 1) {
    pagerEl.innerHTML = "";
    return;
  }
  const qs = (p) => {
    const u = new URLSearchParams();
    if (currentQ)
      u.set("q", currentQ);
    u.set("page", String(p));
    const base = currentCat ? `/cat/${encodeURIComponent(currentCat)}?` : currentTag ? `/tag/${encodeURIComponent(currentTag)}?` : "/?";
    return base + u.toString();
  };
  pagerEl.innerHTML = `
    ${page > 1 ? `<a class="btn sm" href="${qs(page - 1)}">\u2190 \u4E0A\u4E00\u9875</a>` : ""}
    <span class="page-info">${page} / ${pages}\u3000\u5171 ${total} \u7BC7</span>
    ${page < pages ? `<a class="btn sm" href="${qs(page + 1)}">\u4E0B\u4E00\u9875 \u2192</a>` : ""}`;
}
async function loadCats() {
  try {
    const { categories } = await api("/api/categories");
    if (!categories.length) {
      catbarEl.innerHTML = "";
      return;
    }
    catbarEl.innerHTML = `<span class="bar-label">\u680F\u76EE</span><a class="tag" href="/" style="${!currentCat && !currentTag ? "background:var(--accent-soft);color:var(--accent)" : ""}">\u5168\u90E8</a>` + categories.map((c) => `<a class="tag cat-chip" href="/cat/${encodeURIComponent(c.slug)}" title="${esc(c.desc || "")}"
        style="${currentCat === c.slug ? "background:var(--accent-soft);color:var(--accent)" : ""}">${esc(c.name)} ${c.count}</a>`).join("");
  } catch {
  }
}
async function loadTags() {
  try {
    const { tags } = await api("/api/tags");
    if (!tags.length)
      return;
    tagbarEl.innerHTML = `<span class="bar-label">\u6807\u7B7E</span><a class="tag" href="/" style="${!currentTag ? "background:var(--accent-soft);color:var(--accent)" : ""}">\u5168\u90E8</a>` + tags.map((t) => `<a class="tag" href="/tag/${encodeURIComponent(t.name)}"
        style="${currentTag === t.name ? "background:var(--accent-soft);color:var(--accent)" : ""}">#${esc(t.name)} ${t.count}</a>`).join("");
  } catch {
  }
}
var timer;
qInput.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const v = qInput.value.trim();
    const url = new URL(location.href);
    if (v)
      url.searchParams.set("q", v);
    else
      url.searchParams.delete("q");
    url.searchParams.delete("page");
    if (currentCat) {
      location.href = `/cat/${encodeURIComponent(currentCat)}${v ? "?q=" + encodeURIComponent(v) : ""}`;
    } else if (currentTag) {
      location.href = `/tag/${encodeURIComponent(currentTag)}${v ? "?q=" + encodeURIComponent(v) : ""}`;
    } else {
      history.replaceState(null, "", url);
      currentQ = v;
      page = 1;
      document.getElementById("hero-title").textContent = v ? `\u641C\u7D22\uFF1A${v}` : SITE.name;
      document.getElementById("hero-sub").textContent = v ? "\u6807\u9898\u4E0E\u6B63\u6587\u5173\u952E\u8BCD\u5339\u914D" : SITE.desc || "\u8BB0\u5F55\u601D\u8003\u3001\u4EE3\u7801\u4E0E\u751F\u6D3B\u3002";
      load();
    }
  }, 320);
});
mountHeader(currentTag ? "tag" : currentCat ? "cat" : "home");
loadCats();
loadTags();
var BOOT = window.__LIST__;
if (!BOOT || currentQ)
  load();
