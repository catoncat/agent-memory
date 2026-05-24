const state = {
  overview: null,
  view: "home",
  source: "all",
  query: "",
  bookmarkFilter: "inbox",
  bookmarkSort: "saved_desc",
  events: [],
  dreams: [],
  bookmarks: [],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const api = async (path, options = {}) => {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const compactUrl = (url) => {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return String(url);
  }
};

const timeAgo = (iso) => {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return String(iso).slice(0, 19);
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
};

const sourceLabel = (source) =>
  ({
    codex: "Codex",
    "agent-closeout": "Closeout",
    "agent-dream": "Dream",
    "chrome-tabs": "Chrome",
    "x-bookmarks": "X",
  })[source] || source || "Memory";

const sourceClass = (source) => String(source || "").replace(/[^a-z0-9_-]/gi, "-");

const formatSize = (kb) => {
  const n = Number(kb || 0);
  if (!Number.isFinite(n) || n <= 0) return "0 KB";
  if (n >= 1024) return `${(n / 1024).toFixed(1)} MB`;
  return `${Math.round(n)} KB`;
};

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function setStatus(message) {
  $("#statusLine").textContent = message;
}

function activateView(view) {
  state.view = view;
  $$(".view").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  $$(".bottom-nav button").forEach((el) => el.classList.toggle("active", el.dataset.nav === view));
  if (view === "dream" && state.dreams.length === 0) loadDreams().catch((error) => toast(error.message));
  if (view === "bookmarks" && state.bookmarks.length === 0) loadBookmarks();
  if (view === "sources") renderSources();
}

function updateOverview() {
  const overview = state.overview || {};
  const stats = overview.stats || {};
  const metrics = overview.metrics || {};
  const dreamCount = (stats.bySource || []).find((item) => item.source === "agent-dream")?.count || 0;
  $("#eventTotal").textContent = stats.total ?? 0;
  $("#ftsTotal").textContent = stats.ftsRows ?? 0;
  $("#semanticTotal").textContent = stats.semanticRows ?? 0;
  $("#dreamTotal").textContent = dreamCount;
  $("#sizeTotal").textContent = formatSize(metrics.agent_memory_size_kb);

  const ok = overview.status?.ok;
  const finished = overview.status?.finishedAt || overview.status?.startedAt;
  const lastRun = finished ? `${timeAgo(finished)} ago` : "no run";
  setStatus(`${ok ? "ok" : "check"} · ${lastRun}`);
}

async function loadOverview() {
  state.overview = await api("/api/overview");
  updateOverview();
  renderSources();
}

function eventCard(item) {
  const rawSummary = item.summary || item.snippet || item.content || "";
  const summary = rawSummary && rawSummary !== item.url ? rawSummary : "";
  return `
    <button class="event-card" data-event-id="${escapeHtml(item.id)}">
      <div class="event-meta">
        <span class="tag ${sourceClass(item.source)}">${escapeHtml(sourceLabel(item.source))}</span>
        <span>${escapeHtml(item.kind || "")}</span>
        <span>${escapeHtml(timeAgo(item.ts))}</span>
      </div>
      <div class="event-title">${escapeHtml(item.title || "(untitled)")}</div>
      ${summary ? `<div class="event-summary">${escapeHtml(String(summary).slice(0, 280))}</div>` : ""}
      ${item.url ? `<div class="event-url">${escapeHtml(compactUrl(item.url))}</div>` : ""}
    </button>
  `;
}

function renderEvents(items = state.events) {
  const list = $("#eventList");
  if (!items.length) {
    list.innerHTML = `<div class="empty">No events</div>`;
    return;
  }
  list.innerHTML = items.map(eventCard).join("");
  list.querySelectorAll(".event-card").forEach((card, index) => {
    card.addEventListener("click", () => showEventDetail(items[index]));
  });
}

function renderContext(items) {
  const list = $("#contextList");
  if (!items.length) {
    list.innerHTML = `<div class="empty">No context</div>`;
    return;
  }
  list.innerHTML = items.map(eventCard).join("");
  list.querySelectorAll(".event-card").forEach((card, index) => {
    card.addEventListener("click", () => showEventDetail(items[index]));
  });
}

function renderDreams(items = state.dreams) {
  const list = $("#dreamList");
  if (!items.length) {
    list.innerHTML = `<div class="empty">No dream yet</div>`;
    return;
  }
  list.innerHTML = items.map(eventCard).join("");
  list.querySelectorAll(".event-card").forEach((card, index) => {
    card.addEventListener("click", () => showEventDetail(items[index]));
  });
}

async function loadEvents() {
  const params = new URLSearchParams({ limit: "56", source: state.source });
  if (state.query) params.set("q", state.query);
  const data = await api(`/api/events?${params}`);
  state.events = data.items || [];
  $("#recentMode").textContent = state.query ? data.mode || "search" : "live";
  renderEvents();
}

async function loadDreams() {
  const data = await api("/api/dream?limit=16");
  state.dreams = data.items || [];
  renderDreams();
}

async function runDream() {
  const button = $("#dreamButton");
  button.disabled = true;
  button.textContent = "Running";
  try {
    await api("/api/dream", { method: "POST", body: JSON.stringify({ sinceHours: 24, limit: 240 }) });
    await loadOverview();
    await loadDreams();
    toast("Dream updated");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Run";
  }
}

async function loadContext() {
  const q = state.query || $("#queryInput").value.trim();
  if (!q) {
    toast("Search first");
    return;
  }
  activateView("context");
  $("#contextList").innerHTML = `<div class="empty">Loading context</div>`;
  const data = await api(`/api/context?q=${encodeURIComponent(q)}&limit=8`);
  const payload = data.data || {};
  $("#contextMeta").textContent = `${payload.results?.length || 0} matches`;
  renderContext(payload.results || []);
}

function renderSources() {
  const overview = state.overview || {};
  const stats = overview.stats || {};
  const sources = stats.bySource || [];
  const grid = $("#sourceGrid");
  grid.innerHTML = sources
    .map(
      (item) => `
        <button class="source-card" data-source-open="${escapeHtml(item.source)}">
          <div>
            <h3>${escapeHtml(sourceLabel(item.source))}</h3>
            <span>${escapeHtml(item.source)}</span>
          </div>
          <b>${escapeHtml(item.count)}</b>
        </button>
      `,
    )
    .join("");
  grid.querySelectorAll("[data-source-open]").forEach((button) => {
    button.addEventListener("click", () => {
      state.source = button.dataset.sourceOpen;
      $$("#sourceStrip button").forEach((el) => el.classList.toggle("active", el.dataset.source === state.source));
      activateView("home");
      loadEvents().catch((error) => toast(error.message));
    });
  });

  const status = overview.status || {};
  $("#doctorState").textContent = status.ok ? "ok" : "check";
  $("#statusBox").textContent = JSON.stringify(
    {
      lastRun: status.finishedAt || status.startedAt,
      durationMs: status.durationMs,
      steps: status.steps,
      paths: {
        memoryRoot: overview.memoryRoot,
        eventDb: overview.eventDb,
        bookmarkDb: overview.bookmarkDb,
      },
    },
    null,
    2,
  );
}

function bookmarkCard(item) {
  const author = item.author || item.name || "unknown";
  const score = Number(item.likes || 0) + Number(item.retweets || 0) * 3 + Number(item.bookmarks || 0) * 5;
  const text = String(item.text || item.url || "").trim();
  const firstLine = text.split(/\n+/).find(Boolean) || text;
  const title = firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
  const body = text === title ? "" : text.replace(firstLine, "").trim().slice(0, 360);
  return `
    <article class="bookmark-card" data-bookmark-id="${escapeHtml(item.id)}">
      <div class="bookmark-meta">
        <span class="tag x-bookmarks">${escapeHtml(author)}</span>
        <span>${escapeHtml(timeAgo(item.created_at || item.first_seen_at))}</span>
        <span>${score ? `score ${score}` : ""}</span>
      </div>
      <div class="bookmark-title">${escapeHtml(title)}</div>
      ${body ? `<div class="bookmark-text">${escapeHtml(body)}</div>` : ""}
      <div class="event-url">${escapeHtml(compactUrl(item.url))}</div>
      <div class="bookmark-actions">
        <button data-action="read" class="${item.is_read ? "active" : ""}">Read</button>
        <button data-action="star" class="${item.starred ? "active" : ""}">Star</button>
        <button data-action="archive" class="${item.archived ? "active" : ""}">Archive</button>
        <button data-action="open">Open</button>
      </div>
    </article>
  `;
}

function renderBookmarks() {
  const list = $("#bookmarkList");
  if (!state.bookmarks.length) {
    list.innerHTML = `<div class="empty">No bookmarks</div>`;
    return;
  }
  list.innerHTML = state.bookmarks.map(bookmarkCard).join("");
  list.querySelectorAll(".bookmark-card").forEach((card, index) => {
    const item = state.bookmarks[index];
    card.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.action;
        if (action === "open") {
          window.open(item.url, "_blank", "noopener");
          return;
        }
        const next = {
          id: item.id,
          is_read: action === "read" ? !item.is_read : item.is_read,
          starred: action === "star" ? !item.starred : item.starred,
          archived: action === "archive" ? !item.archived : item.archived,
        };
        await api("/api/bookmark-state", { method: "POST", body: JSON.stringify(next) });
        Object.assign(item, next);
        renderBookmarks();
        loadOverview().catch(() => {});
      });
    });
  });
}

async function loadBookmarks() {
  const params = new URLSearchParams({
    limit: "160",
    filter: state.bookmarkFilter,
    sort: state.bookmarkSort,
  });
  if (state.query) params.set("q", state.query);
  const data = await api(`/api/bookmarks?${params}`);
  state.bookmarks = data.items || [];
  renderBookmarks();
}

function showEventDetail(item) {
  const dialog = $("#detailDialog");
  const content = $("#detailContent");
  content.className = "detail-content";
  content.innerHTML = `
    <div class="event-meta">
      <span class="tag ${sourceClass(item.source)}">${escapeHtml(sourceLabel(item.source))}</span>
      <span>${escapeHtml(item.kind || "")}</span>
      <span>${escapeHtml(new Date(item.ts).toLocaleString())}</span>
    </div>
    <h3>${escapeHtml(item.title || "(untitled)")}</h3>
    ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ""}
    ${item.url ? `<p><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.url)}</a></p>` : ""}
    ${item.cwd ? `<p>${escapeHtml(item.cwd)}</p>` : ""}
    ${item.content ? `<pre>${escapeHtml(item.content)}</pre>` : ""}
  `;
  dialog.showModal();
}

async function refreshNow() {
  const button = $("#refreshButton");
  button.style.opacity = "0.55";
  button.disabled = true;
  setStatus("refreshing");
  try {
    await api("/api/refresh", { method: "POST", body: "{}" });
    await loadOverview();
    await loadEvents();
    if (state.view === "dream") await loadDreams();
    if (state.view === "bookmarks") await loadBookmarks();
    toast("Refreshed");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.style.opacity = "1";
  }
}

function wireEvents() {
  $("#refreshButton").addEventListener("click", refreshNow);
  $("#dreamButton").addEventListener("click", () => runDream().catch((error) => toast(error.message)));
  $("#contextButton").addEventListener("click", () => loadContext().catch((error) => toast(error.message)));
  $("#closeDetail").addEventListener("click", () => $("#detailDialog").close());

  let searchTimer = null;
  $("#queryInput").addEventListener("input", (event) => {
    state.query = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      loadEvents().catch((error) => toast(error.message));
      if (state.view === "bookmarks") loadBookmarks().catch((error) => toast(error.message));
    }, 180);
  });

  $$("#sourceStrip button").forEach((button) => {
    button.addEventListener("click", () => {
      state.source = button.dataset.source;
      $$("#sourceStrip button").forEach((el) => el.classList.toggle("active", el === button));
      activateView("home");
      loadEvents().catch((error) => toast(error.message));
    });
  });

  $$(".bottom-nav button").forEach((button) => {
    button.addEventListener("click", () => activateView(button.dataset.nav));
  });

  $$("#bookmarkFilters button").forEach((button) => {
    button.addEventListener("click", () => {
      state.bookmarkFilter = button.dataset.filter;
      $$("#bookmarkFilters button").forEach((el) => el.classList.toggle("active", el === button));
      loadBookmarks().catch((error) => toast(error.message));
    });
  });

  $("#bookmarkSort")?.addEventListener("change", (event) => {
    state.bookmarkSort = event.target.value;
    loadBookmarks().catch((error) => toast(error.message));
  });
}

async function boot() {
  wireEvents();
  try {
    await loadOverview();
    await loadEvents();
    await loadDreams();
  } catch (error) {
    setStatus(error.message);
    toast(error.message);
  }
}

boot();
