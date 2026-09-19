/* 有道词库在线背单词 — 纯静态前端
   数据: data/manifest.json + data/books/<id>.json (按需加载)
   进度: localStorage + Supabase 云同步(登录后多设备共用) */
"use strict";

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* ---------- 存储 ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn("storage fail", e); } },
  del(k) { localStorage.removeItem(k); },
};
const pkey = id => "ydict.progress." + id;

let starred = store.get("ydict.starred", {}); // {word: {b: bookId, t: ts}}
function saveStarred() { store.set("ydict.starred", starred); updateStarCount(); queuePush("starred", ""); }
function updateStarCount() { $("#star-count").textContent = Object.keys(starred).length; }

/* ---------- 云同步 (Supabase) ---------- */
const SB = {
  url: "https://qvemohfojzawpnleyjsb.supabase.co",
  key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF2ZW1vaGZvanphd3BubGV5anNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxOTg1ODUsImV4cCI6MjEwNDc3NDU4NX0.NjN0Yi_XGWoZKuzBGhsxlZwS6gjx9xZdL_RazK3k1q8",
};
const auth = { session: null, isAdmin: false };

function saveSession() { if (auth.session) store.set("ydict.session", auth.session); else store.del("ydict.session"); }
function setEmail() { $("#user-email").textContent = auth.session ? auth.session.user.email : ""; }

function setSyncState(s) {
  const el = $("#sync-state");
  if (!auth.session) { el.textContent = ""; el.title = ""; return; }
  if (s === "syncing") { el.textContent = "⟳ 同步中"; }
  else if (s === "ok") { el.textContent = "✓ 已同步"; }
  else if (s === "error") { el.textContent = "⚠ 同步失败"; }
  else if (s === "local") { el.textContent = "仅本机"; }
}

async function sbAuth(path, body) {
  const r = await fetch(SB.url + path, {
    method: "POST",
    headers: { "apikey": SB.key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error_description || d.msg || d.error || ("HTTP " + r.status));
  return d;
}
async function refreshSession() {
  try {
    const d = await sbAuth("/auth/v1/token?grant_type=refresh_token", { refresh_token: auth.session.refresh_token });
    auth.session = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at, user: d.user };
    saveSession();
  } catch { doLogout(); }
}
async function ensureToken() {
  if (!auth.session) return;
  if (Date.now() < auth.session.expires_at * 1000 - 60000) return;
  await refreshSession();
}
async function sbApi(path, opts = {}, retry = true) {
  await ensureToken();
  const r = await fetch(SB.url + path, {
    ...opts,
    headers: {
      "apikey": SB.key,
      "Authorization": "Bearer " + auth.session.access_token,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (r.status === 401 && retry) {
    await refreshSession();
    if (auth.session) return sbApi(path, opts, false);
  }
  if (!r.ok) throw new Error("SB " + r.status + " " + path);
  return r;
}

async function doSignup(email, pw) {
  const d = await sbAuth("/auth/v1/signup", { email, password: pw });
  if (!d.access_token) throw new Error("需要邮箱确认,请查收邮件后再登录");
  auth.session = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at, user: d.user };
}
async function doLogin(email, pw) {
  const d = await sbAuth("/auth/v1/token?grant_type=password", { email, password: pw });
  auth.session = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at, user: d.user };
}
function doLogout(push = true) {
  if (auth.session && push) {
    const t = auth.session.access_token;
    fetch(SB.url + "/auth/v1/logout", { method: "POST", headers: { "apikey": SB.key, "Authorization": "Bearer " + t } }).catch(() => {});
  }
  auth.session = null; auth.isAdmin = false;
  saveSession(); renderAuthUI();
}
async function loadProfile() {
  try {
    const r = await sbApi("/rest/v1/profiles?select=is_admin&id=eq." + auth.session.user.id);
    const d = await r.json();
    auth.isAdmin = !!(d[0] && d[0].is_admin);
  } catch { auth.isAdmin = false; }
}

/* 推送(防抖): 学习中频繁点按钮,2.5s 内只发一次 */
const pushTimers = {};
function queuePush(kind, id) {
  if (!auth.session) return;
  clearTimeout(pushTimers[kind + "." + id]);
  pushTimers[kind + "." + id] = setTimeout(() => pushNow(kind, id), 2500);
}
async function pushNow(kind, id) {
  if (!auth.session) return;
  try {
    setSyncState("syncing");
    if (kind === "progress") {
      const data = store.get(pkey(id), null);
      if (!data) return;
      await sbApi("/rest/v1/user_progress?on_conflict=user_id,book_id", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: auth.session.user.id, book_id: id, data }),
      });
    } else {
      await sbApi("/rest/v1/user_starred?on_conflict=user_id", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: auth.session.user.id, starred }),
      });
    }
    setSyncState("ok");
  } catch (e) { console.warn(e); setSyncState("error"); }
}

/* 登录后:云端拉取 + 与本地按时间戳合并(双向,新者胜) */
async function pullMerge() {
  if (!auth.session) return;
  try {
    setSyncState("syncing");
    const [rp, rs] = await Promise.all([
      sbApi("/rest/v1/user_progress?select=book_id,data"),
      sbApi("/rest/v1/user_starred?select=starred"),
    ]);
    const cloudP = await rp.json();
    const cloudS = await rs.json();

    for (const row of cloudP) {
      const c = row.data || {};
      const local = store.get(pkey(row.book_id), null);
      if (!local || (c.at || 0) > (local.at || 0)) store.set(pkey(row.book_id), c);
    }
    const cloudStarred = cloudS.length ? (cloudS[0].starred || {}) : null;
    if (cloudStarred) {
      const merged = { ...starred };
      for (const [w, info] of Object.entries(cloudStarred)) {
        if (!merged[w] || (info.t || 0) > (merged[w].t || 0)) merged[w] = info;
      }
      starred = merged; store.set("ydict.starred", starred); updateStarCount();
    }
    /* 本地较新(或云端缺)的词书推上去 */
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith("ydict.progress.")) continue;
      const id = k.slice(15), local = store.get(k, null);
      if (!local) continue;
      const crow = cloudP.find(r => r.book_id === id);
      if (!crow || (local.at || 0) > ((crow.data || {}).at || 0)) queuePush("progress", id);
    }
    queuePush("starred", "");
    setSyncState("ok");
    reloadCurrentBook();
  } catch (e) { console.warn(e); setSyncState("error"); }
}
/* 合并后如果当前书进度变了,热替换内存中的进度 */
function reloadCurrentBook() {
  if (!book || tempSession) return;
  const p = store.get(pkey(book.id), null);
  if (p && p.order && p.order.length === book.words.length) {
    order = p.order; cur = Math.min(p.cur || 0, p.order.length - 1);
    known = new Set(p.known || []); unknown = new Set(p.unknown || []);
    renderStudy();
  }
}

async function afterLogin() {
  saveSession(); setEmail();
  await loadProfile();
  renderAuthUI();
  await pullMerge();
  closeAuthModal();
}

/* ---------- 状态 ---------- */
let manifest = null;          // {books:[...]}
let book = null;              // 当前书数据 {id,t,words}
let bookMeta = null;          // manifest 里的元数据
let order = [];               // 学习顺序(指向 words 下标)
let cur = 0;
let known = new Set(), unknown = new Set(); // 单词字符串
let wordIndex = {};           // headWord -> word obj
let tempSession = null;       // {list:[wordObj], label} 只学生词/背生词本时的临时列表
let currentDetailWord = null; // 发音按钮用

const GROUPS = ["小学", "初中", "高中", "四级", "六级", "考研", "专四", "专八",
  "雅思", "托福", "GRE", "SAT", "GMAT", "BEC"];

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function speak(word, variant) {
  const v = variant || 2; // 2=美音 1=英音
  try {
    const a = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${v}`);
    a.play().catch(() => ttsFallback(word));
  } catch { ttsFallback(word); }
}
function ttsFallback(word) {
  try {
    const u = new SpeechSynthesisUtterance(word);
    u.lang = "en-US";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}

/* ---------- 词书抽屉 ---------- */
async function loadManifest() {
  const r = await fetch("data/manifest.json");
  manifest = await r.json();
  renderBookList("");
}
function renderBookList(filter) {
  const box = $("#book-list");
  const f = (filter || "").trim().toLowerCase();
  const groups = {};
  for (const b of manifest.books) {
    if (f && !(b.t.toLowerCase().includes(f) || b.id.toLowerCase().includes(f) ||
               (b.g || "").toLowerCase().includes(f))) continue;
    (groups[b.g || "其他"] = groups[b.g || "其他"] || []).push(b);
  }
  let html = "";
  for (const g of [...GROUPS, "其他"]) {
    if (!groups[g]) continue;
    html += `<div class="book-group"><h3>${esc(g)}</h3>`;
    for (const b of groups[g]) {
      const isCur = book && book.id === b.id;
      html += `<button class="book-item${isCur ? " current" : ""}" data-id="${esc(b.id)}">
        <span>${esc(b.t)}</span><span class="cnt">${b.n}词</span></button>`;
    }
    html += `</div>`;
  }
  box.innerHTML = html || `<div class="hint" style="padding:12px">没有匹配的词书</div>`;
}
function openDrawer() { $("#drawer").classList.remove("hidden"); $("#mask").classList.remove("hidden"); }
function closeDrawer() { $("#drawer").classList.add("hidden"); $("#mask").classList.add("hidden"); }

/* ---------- 加载与切换词书 ---------- */
async function selectBook(id) {
  saveProgress();
  $("#book-title").textContent = "加载中…";
  try {
    const r = await fetch(`data/books/${id}.json`);
    if (!r.ok) throw new Error(r.status);
    book = await r.json();
  } catch (e) {
    $("#book-title").textContent = "加载失败,请重试";
    return;
  }
  bookMeta = manifest.books.find(b => b.id === id) || { t: id };
  wordIndex = {};
  for (const w of book.words) if (!(w.w in wordIndex)) wordIndex[w.w] = w;
  store.set("ydict.lastBook", id);
  location.hash = "book=" + id;
  $("#book-title").textContent = bookMeta.t;

  tempSession = null;
  const saved = store.get(pkey(id), null);
  if (saved && saved.order && saved.order.length === book.words.length) {
    order = saved.order; cur = Math.min(saved.cur || 0, saved.order.length - 1);
    known = new Set(saved.known || []); unknown = new Set(saved.unknown || []);
  } else {
    order = shuffle([...book.words.keys()]);
    cur = 0; known = new Set(); unknown = new Set();
    saveProgress(true);
  }
  renderBookList($("#book-filter").value);
  $("#view-study").classList.remove("hidden");
  if (currentView === "study") renderStudy();
}
function saveProgress(fresh) {
  if (!book) return;
  /* fresh=选书时的空进度初始化,不打时间戳不推送,避免覆盖其他设备的真实进度 */
  store.set(pkey(book.id), { order, cur, known: [...known], unknown: [...unknown], at: fresh ? 0 : Date.now() });
  if (!fresh) queuePush("progress", book.id);
}

/* ---------- 学习视图 ---------- */
function studyList() {
  if (tempSession) return tempSession.list;
  return order.map(i => book.words[i]);
}
function renderStudy() {
  const list = studyList();
  $("#study-progress").textContent = tempSession
    ? `${tempSession.label} · ${cur} / ${list.length}`
    : `第 ${Math.min(cur + 1, list.length)} / ${list.length} 词 · 已认识 ${known.size} · 生词 ${unknown.size}`;

  const done = cur >= list.length;
  $("#card").classList.toggle("hidden", done);
  $("#study-actions").classList.toggle("hidden", done);
  $("#study-done").classList.toggle("hidden", !done);
  if (done) return;

  const w = list[cur];
  currentDetailWord = w;
  $("#card").classList.remove("flipped");
  $("#card").querySelector(".card-front").classList.remove("hidden");
  $("#card").querySelector(".card-back").classList.add("hidden");
  $("#word-head").textContent = w.w;
  $("#word-us").textContent = w.us || "";
  $("#word-uk").textContent = w.uk || "";
  $("#btn-star").textContent = w.w in starred ? "★" : "☆";
  // 背面内容(点击时再渲染也行,这里直接渲染)
  $("#word-trans").innerHTML = (w.tr || []).map(t =>
    `<div class="tr-item"><span class="pos">${esc(t.p)}</span>${esc(t.c)}</div>`).join("") || "<div class='tr-item'>(无释义)</div>";
  $("#word-detail").innerHTML = detailSections(w);
}
function detailSections(w) {
  let html = "";
  if (w.sen && w.sen.length) {
    html += `<div class="detail-sec"><h4>例句</h4>` + w.sen.map(s =>
      `<div class="sen-item"><span class="en">${esc(s.e)}</span><span class="cn">${esc(s.c)}</span></div>`).join("") + `</div>`;
  }
  if (w.rex && w.rex.length) {
    html += `<div class="detail-sec"><h4>真题例句</h4>` + w.rex.map(s =>
      `<div class="sen-item"><span class="en">${esc(s.e)}</span><span class="cn">${s.src ? `<span class="src">` + esc(s.src) + `</span>` : ""}</span></div>`).join("") + `</div>`;
  }
  if (w.syn && w.syn.length) {
    html += `<div class="detail-sec"><h4>同近义词</h4>` + w.syn.map(s =>
      `<div class="syn-item"><span class="pos">${esc(s.p)}</span><span class="t">${esc(s.t)}</span>` +
      s.ws.map(x => `<span class="w"><a data-lookup="${esc(x)}">${esc(x)}</a></span>`).join("") + `</div>`).join("") + `</div>`;
  }
  if (w.rel && w.rel.length) {
    html += `<div class="detail-sec"><h4>同根词</h4>` + w.rel.map(r =>
      `<div class="rel-item"><span class="pos">${esc(r.p)}</span>` +
      r.ws.map(x => `<span class="w"><a data-lookup="${esc(x.w)}">${esc(x.w)}</a><span class="t">${esc(x.t)}</span></span>`).join("") + `</div>`).join("") + `</div>`;
  }
  return html;
}
function nextWord() {
  cur++;
  saveProgress();
  renderStudy();
}
function markKnown() {
  const w = studyList()[cur];
  if (!w) return;
  known.add(w.w); unknown.delete(w.w);
  nextWord();
}
function markUnknown() {
  const w = studyList()[cur];
  if (!w) return;
  unknown.add(w.w); known.delete(w.w);
  starred[w.w] = { b: book.id, t: Date.now() };
  saveStarred();
  nextWord();
}
function toggleStar() {
  const w = studyList()[cur];
  if (!w) return;
  if (w.w in starred) delete starred[w.w];
  else starred[w.w] = { b: book.id, t: Date.now() };
  $("#btn-star").textContent = w.w in starred ? "★" : "☆";
  saveStarred();
}

/* ---------- 查词 ---------- */
function doSearch() {
  const q = $("#search-input").value.trim().toLowerCase();
  const box = $("#search-results");
  if (!q) { box.innerHTML = ""; $("#search-hint").textContent = "在当前词书中搜索,结果按词头排序"; return; }
  if (!book) { $("#search-hint").textContent = "请先选择词书"; return; }
  const hits = book.words.filter(w => w.w.toLowerCase().includes(q) ||
    (w.tr || []).some(t => t.c.toLowerCase().includes(q))).slice(0, 60);
  $("#search-hint").textContent = hits.length ? `共 ${hits.length} 条结果(最多显示 60)` : "无结果";
  box.innerHTML = hits.map((w, i) => {
    const brief = (w.tr || []).map(t => t.c).join("; ");
    return `<div class="sr-item" data-i="${book.words.indexOf(w)}">
      <div class="hw">${esc(w.w)}</div><div class="brief">${esc(brief)}</div></div>`;
  }).join("");
}
function openDetail(wordObj, bookTitle) {
  currentDetailWord = wordObj;
  const w = wordObj;
  const phones = `<div class="detail-phones">
      ${w.us ? `<button class="phone-btn" data-v="2">美 ${esc(w.us)}</button>` : ""}
      ${w.uk ? `<button class="phone-btn" data-v="1">英 ${esc(w.uk)}</button>` : ""}
      ${bookTitle ? `<span style="margin-left:8px">《${esc(bookTitle)}》</span>` : ""}
    </div>`;
  const trans = (w.tr || []).map(t =>
    `<div class="tr-item"><span class="pos">${esc(t.p)}</span>${esc(t.c)}</div>`).join("");
  $("#detail-content").innerHTML =
    `<div class="detail-word">${esc(w.w)}</div>${phones}<div id="detail-trans">${trans}</div>${detailSections(w)}`;
  $("#detail-modal").classList.remove("hidden");
}
function closeDetail() { $("#detail-modal").classList.add("hidden"); }

/* ---------- 生词本 ---------- */
function renderStarred() {
  const box = $("#starred-list");
  const entries = Object.entries(starred).sort((a, b) => b[1].t - a[1].t);
  if (!entries.length) { box.innerHTML = `<div class="hint">生词本为空。学习中点"不认识"或 ☆ 即可加入。</div>`; return; }
  const bookTitles = {};
  for (const b of manifest.books) bookTitles[b.id] = b.t;
  box.innerHTML = entries.map(([w, info]) =>
    `<div class="star-row" data-w="${esc(w)}" data-b="${esc(info.b)}">
      <span class="hw">${esc(w)}</span><span class="book">《${esc(bookTitles[info.b] || info.b)}》</span>
      <button class="del" title="移除">✕</button></div>`).join("");
}
async function studyStarred() {
  const entries = Object.entries(starred).sort((a, b) => a[1].t - b[1].t);
  if (!entries.length) return;
  const list = [];
  const need = {};
  for (const [w, info] of entries) (need[info.b] = need[info.b] || []).push(w);
  for (const [bid, ws] of Object.entries(need)) {
    try {
      const r = await fetch(`data/books/${bid}.json`);
      const data = await r.json();
      for (const w of ws) {
        const obj = data.words.find(x => x.w === w) || { w, tr: [{ p: "", c: "(该词不在原书数据中)" }] };
        list.push(obj);
      }
    } catch { for (const w of ws) list.push({ w, tr: [{ p: "", c: "(数据加载失败)" }] }); }
  }
  tempSession = { list, label: "生词本" };
  cur = 0;
  switchView("study");
  renderStudy();
}

/* ---------- 账号 UI ---------- */
function renderAuthUI() {
  const btn = $("#btn-user");
  if (auth.session) {
    btn.textContent = auth.session.user.email.split("@")[0];
    btn.title = auth.session.user.email;
    $("#menu-login").classList.add("hidden");
    $("#menu-logout").classList.remove("hidden");
    $("#menu-admin").classList.toggle("hidden", !auth.isAdmin);
    $("#sync-state").classList.remove("hidden");
    setSyncState("local");
  } else {
    btn.textContent = "登录";
    btn.title = "登录/注册,多设备同步进度";
    $("#menu-login").classList.remove("hidden");
    $("#menu-logout").classList.add("hidden");
    $("#menu-admin").classList.add("hidden");
    $("#user-menu").classList.add("hidden");
    $("#sync-state").classList.add("hidden");
    $("#foot-sync").textContent = "进度保存在本设备浏览器中,登录后可多设备同步";
  }
  if (auth.session) $("#foot-sync").textContent = "已登录 " + auth.session.user.email + ",进度云端同步";
}
function openAuthModal(mode) {
  $("#user-menu").classList.add("hidden");
  $("#auth-err").textContent = "";
  $("#auth-modal").classList.remove("hidden");
  switchAuthMode(mode || "login");
}
function closeAuthModal() { $("#auth-modal").classList.add("hidden"); }
function switchAuthMode(m) {
  $("#auth-title").textContent = m === "login" ? "登录" : "注册新账号";
  $("#btn-do-login").classList.toggle("hidden", m !== "login");
  $("#btn-do-signup").classList.toggle("hidden", m !== "signup");
  $("#auth-switch").textContent = m === "login" ? "没有账号?注册一个" : "已有账号?去登录";
  $("#auth-switch").dataset.mode = m === "login" ? "signup" : "login";
}
async function submitAuth(kind) {
  const email = $("#auth-email").value.trim();
  const pw = $("#auth-pass").value;
  const err = $("#auth-err");
  err.textContent = "";
  if (!email || !pw) { err.textContent = "请输入邮箱和密码"; return; }
  try {
    $("#btn-do-login").disabled = $("#btn-do-signup").disabled = true;
    if (kind === "login") await doLogin(email, pw);
    else await doSignup(email, pw);
    await afterLogin();
  } catch (e) {
    err.textContent = String(e.message || e).replace("Email not confirmed", "邮箱未确认");
  } finally {
    $("#btn-do-login").disabled = $("#btn-do-signup").disabled = false;
  }
}

/* ---------- 管理员面板 ---------- */
async function openAdminModal() {
  $("#user-menu").classList.add("hidden");
  $("#admin-modal").classList.remove("hidden");
  $("#admin-list").innerHTML = `<div class="hint" style="padding:12px">加载中…</div>`;
  try {
    const r = await sbApi("/rest/v1/rpc/admin_list_users", { method: "POST", body: "{}" });
    const users = await r.json();
    if (!users.length) { $("#admin-list").innerHTML = `<div class="hint" style="padding:12px">暂无用户</div>`; return; }
    $("#admin-list").innerHTML =
      `<table class="admin-table"><tr><th>邮箱</th><th>注册时间</th><th>词书</th><th>生词</th><th>角色</th><th></th></tr>` +
      users.map(u => `<tr>
        <td>${esc(u.email || u.user_id)}</td>
        <td>${esc((u.created_at || "").slice(0, 10))}</td>
        <td>${u.books || 0}</td>
        <td>${u.starred_count || 0}</td>
        <td>${u.is_admin ? "管理员" : "用户"}</td>
        <td>${u.is_admin ? "" : `<button class="link-btn" data-del-user="${esc(u.user_id)}">清数据</button>`}</td>
      </tr>`).join("") + `</table>`;
  } catch (e) {
    $("#admin-list").innerHTML = `<div class="hint" style="padding:12px">加载失败:${esc(String(e.message || e))}</div>`;
  }
}
async function adminDeleteUser(uid) {
  await sbApi("/rest/v1/rpc/admin_delete_user_data", { method: "POST", body: JSON.stringify({ target: uid }) });
  openAdminModal();
}

/* ---------- 视图切换 ---------- */
let currentView = "study";
function switchView(v) {
  currentView = v;
  $$("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  $("#view-study").classList.toggle("hidden", v !== "study");
  $("#view-search").classList.toggle("hidden", v !== "search");
  $("#view-starred").classList.toggle("hidden", v !== "starred");
  if (v === "starred") renderStarred();
  if (v === "search") { $("#search-input").focus(); doSearch(); }
}

/* ---------- 事件绑定 ---------- */
document.addEventListener("click", e => {
  const t = e.target.closest("button, .sr-item, .star-row, .phone-btn, a[data-lookup], #card");
  if (!t) return;
  if (t.id === "btn-menu") return openDrawer();
  if (t.id === "btn-close-drawer" || t.id === "mask") return closeDrawer();
  if (t.id === "btn-close-detail") return closeDetail();
  if (t.id === "detail-modal") return closeDetail();
  if (t.id === "btn-close-auth" || t.id === "auth-modal") return closeAuthModal();
  if (t.id === "auth-switch") return switchAuthMode(t.dataset.mode);
  if (t.id === "btn-do-login") return submitAuth("login");
  if (t.id === "btn-do-signup") return submitAuth("signup");
  if (t.id === "btn-close-admin" || t.id === "admin-modal") return $("#admin-modal").classList.add("hidden");
  if (t.dataset.delUser) {
    if (confirm("确定删除该用户的全部云端数据?此操作不可恢复。")) adminDeleteUser(t.dataset.delUser);
    return;
  }
  if (t.id === "btn-user") {
    if (!auth.session) return openAuthModal("login");
    $("#user-menu").classList.toggle("hidden");
    return;
  }
  if (t.id === "menu-login") return openAuthModal("login");
  if (t.id === "menu-admin") return openAdminModal();
  if (t.id === "menu-logout") {
    if (confirm("退出登录?本设备的学习数据会保留,下次登录可继续同步。")) doLogout();
    $("#user-menu").classList.add("hidden");
    return;
  }
  if (t.classList.contains("book-item")) return selectBook(t.dataset.id), closeDrawer();
  if (t.closest("#book-title")) return openDrawer();
  if (t.classList.contains("phone-btn")) {
    const word = t.closest("#detail-modal") ? currentDetailWord.w : (currentDetailWord ? currentDetailWord.w : "");
    return word && speak(word, t.dataset.v);
  }
  if (t.matches("a[data-lookup]")) {
    const w = t.dataset.lookup;
    const obj = wordIndex[w];
    if (obj) openDetail(obj, bookMeta.t);
    else $("#detail-modal").classList.add("hidden");
    return;
  }
  if (t.matches(".sr-item")) {
    return openDetail(book.words[+t.dataset.i], bookMeta.t);
  }
  if (t.matches(".star-row .del")) {
    e.stopPropagation();
    const row = t.closest(".star-row");
    delete starred[row.dataset.w];
    saveStarred(); renderStarred();
    return;
  }
  if (t.matches(".star-row")) {
    const w = t.closest(".star-row");
    return selectBook(w.dataset.b).then(() => {
      const obj = wordIndex[w.dataset.w];
      if (obj) openDetail(obj, bookMeta.t);
    });
  }
  if (t.id === "btn-known") return markKnown();
  if (t.id === "btn-unknown") return markUnknown();
  if (t.id === "btn-star") return toggleStar();
  if (t.id === "btn-audio") return currentDetailWord && speak(currentDetailWord.w);
  if (t.id === "btn-restart") {
    const list = [...unknown].map(w => wordIndex[w]).filter(Boolean);
    if (!list.length) { tempSession = null; cur = 0; return renderStudy(); }
    tempSession = { list, label: "生词回顾" };
    cur = 0;
    return renderStudy();
  }
  if (t.id === "btn-reset-progress") {
    if (!book) return;
    if (!confirm(`确定重置《${bookMeta.t}》的学习进度吗?`)) return;
    store.del(pkey(book.id));
    if (auth.session) {
      sbApi("/rest/v1/user_progress?user_id=eq." + auth.session.user.id + "&book_id=eq." + book.id,
        { method: "DELETE", headers: { "Prefer": "return=minimal" } }).catch(() => {});
    }
    tempSession = null;
    order = shuffle([...book.words.keys()]);
    cur = 0; known = new Set(); unknown = new Set();
    saveProgress();
    return renderStudy();
  }
  if (t.id === "btn-clear-starred") {
    if (!Object.keys(starred).length) return;
    if (!confirm("确定清空整个生词本吗?")) return;
    starred = {}; saveStarred(); renderStarred();
    return;
  }
  if (t.id === "btn-study-starred") return studyStarred();
  if (t.id === "card") {
    const f = t.querySelector(".card-front"), b = t.querySelector(".card-back");
    f.classList.toggle("hidden"); b.classList.toggle("hidden");
    return;
  }
});
/* 点击菜单外部关闭 */
document.addEventListener("click", e => {
  if (!e.target.closest("#user-area")) $("#user-menu").classList.add("hidden");
}, true);
$$("#tabs button").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
$("#book-filter").addEventListener("input", e => renderBookList(e.target.value));
$("#search-input").addEventListener("input", doSearch);
$("#auth-pass").addEventListener("keydown", e => {
  if (e.key === "Enter") submitAuth($("#btn-do-signup").classList.contains("hidden") ? "login" : "signup");
});
$("#opt-shuffle").addEventListener("change", e => {
  if (e.target.checked) shuffle(order);
  cur = 0; saveProgress(); renderStudy();
});
$("#opt-unknown-only").addEventListener("change", e => {
  if (e.target.checked) {
    const list = [...unknown].map(w => wordIndex[w]).filter(Boolean);
    if (!list.length) { e.target.checked = false; alert("当前没有生词"); return; }
    tempSession = { list, label: "只学生词" };
    cur = 0;
  } else { tempSession = null; cur = 0; }
  renderStudy();
});
document.addEventListener("keydown", e => {
  if (currentView !== "study" || !$("#card") || $("#card").classList.contains("hidden")) {
    if (e.key === "Escape") { closeDetail(); closeDrawer(); closeAuthModal(); $("#admin-modal").classList.add("hidden"); }
    return;
  }
  if (e.key === " ") { e.preventDefault(); $("#card").click(); }
  else if (e.key === "ArrowRight" || e.key === "k") markKnown();
  else if (e.key === "ArrowLeft" || e.key === "j") markUnknown();
  else if (e.key === "Escape") closeDetail();
});
window.addEventListener("hashchange", () => {
  const m = location.hash.match(/book=([A-Za-z0-9_-]+)/);
  if (m && (!book || book.id !== m[1])) selectBook(m[1]);
});
window.addEventListener("beforeunload", saveProgress);

/* ---------- 启动 ---------- */
(async function init() {
  updateStarCount();
  await loadManifest();
  /* 恢复登录态 → 云端合并 → 再选书,保证云端进度先落地 */
  const saved = store.get("ydict.session", null);
  if (saved && saved.access_token) {
    auth.session = saved;
    try { await loadProfile(); } catch { /* token 可能过期,拉取时再刷新 */ }
  }
  renderAuthUI();
  if (auth.session) await pullMerge();
  const m = location.hash.match(/book=([A-Za-z0-9_-]+)/);
  const last = store.get("ydict.lastBook", null);
  const target = (m && m[1]) || last;
  if (target && manifest.books.some(b => b.id === target)) await selectBook(target);
  else {
    $("#book-title").textContent = "请选择词书";
    $("#view-study").classList.add("hidden");
    openDrawer();
  }
})();
