const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const COMMONS_REST = "https://commons.wikimedia.org/w/rest.php";
const COMMONS_WIKI = "https://commons.wikimedia.org/wiki/";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIDATA_WIKI = "https://www.wikidata.org/wiki/";
const DEFAULT_QUERY = 'incategory:"Plain black Pinhead SVG icons" -haswbstatement:P180';
// Public client ID only. Do not put the client secret in this file.
const OAUTH_CLIENT_ID = "34ea963dd0b5585c37a81feb8dff8107";
const SEARCH_LIMIT = 25;
const SETTINGS_KEY = "pinhead-basic-settings:v1";
const AUTH_KEY = "pinhead-basic-auth:v1";
const PKCE_KEY = "pinhead-basic-pkce:v1";

const els = {
  loginStatus: document.querySelector("#login-status"),
  loginButton: document.querySelector("#login-button"),
  logoutButton: document.querySelector("#logout-button"),
  queueForm: document.querySelector("#queue-form"),
  queueQuery: document.querySelector("#queue-query"),
  queueStatus: document.querySelector("#queue-status"),
  previousButton: document.querySelector("#previous-button"),
  nextButton: document.querySelector("#next-button"),
  filePosition: document.querySelector("#file-position"),
  fileLink: document.querySelector("#file-link"),
  filePreview: document.querySelector("#file-preview"),
  currentCategories: document.querySelector("#current-categories"),
  currentDepicts: document.querySelector("#current-depicts"),
  currentSymbols: document.querySelector("#current-symbols"),
  searchTerm: document.querySelector("#search-term"),
  searchButton: document.querySelector("#search-button"),
  categoryResults: document.querySelector("#category-results"),
  manualCategory: document.querySelector("#manual-category"),
  addCategoryButton: document.querySelector("#add-category-button"),
  wikidataResults: document.querySelector("#wikidata-results"),
  manualQid: document.querySelector("#manual-qid"),
  addDepictsButton: document.querySelector("#add-depicts-button"),
  addSymbolButton: document.querySelector("#add-symbol-button"),
  status: document.querySelector("#status"),
};

const state = {
  settings: loadSettings(),
  auth: loadAuth(),
  files: [],
  totalHits: 0,
  activeIndex: -1,
  currentDetail: null,
  currentSearchTerm: "",
  csrfToken: "",
  renderToken: 0,
};

initialize().catch((error) => {
  console.error(error);
  setStatus("The page could not finish loading.");
});

async function initialize() {
  els.queueQuery.value = state.settings.query;
  renderLoginStatus();
  bindEvents();
  await finishOauthCallbackIfNeeded();

  await reloadQueue();
}

function bindEvents() {
  els.loginButton.addEventListener("click", () => {
    startOauthLogin().catch((error) => {
      console.error(error);
      setStatus("Could not start the Commons login flow.");
    });
  });

  els.logoutButton.addEventListener("click", () => {
    clearAuth();
    setStatus("Logged out.");
  });

  els.queueForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await reloadQueue();
  });

  els.previousButton.addEventListener("click", async () => {
    await moveFile(-1);
  });

  els.nextButton.addEventListener("click", async () => {
    await moveFile(1);
  });

  els.searchButton.addEventListener("click", async () => {
    await reloadHelperResults(els.searchTerm.value.trim());
  });

  els.addCategoryButton.addEventListener("click", async () => {
    await addCategory(els.manualCategory.value.trim());
  });

  els.addDepictsButton.addEventListener("click", async () => {
    await addClaim("P180", els.manualQid.value.trim());
  });

  els.addSymbolButton.addEventListener("click", async () => {
    await addClaim("P8058", els.manualQid.value.trim());
  });
}

async function reloadQueue() {
  state.settings.query = els.queueQuery.value.trim() || DEFAULT_QUERY;
  saveSettings();

  setStatus("Loading queue from Commons...");
  const data = await commonsGet({
    action: "query",
    list: "search",
    srnamespace: "6",
    srlimit: String(SEARCH_LIMIT),
    srsearch: state.settings.query,
  });

  state.files = (data.query?.search || []).map((item) => ({
    title: item.title,
    pageid: item.pageid,
  }));
  state.totalHits = data.query?.searchinfo?.totalhits || 0;
  state.activeIndex = state.files.length ? 0 : -1;
  state.currentDetail = null;
  renderQueueStatus();

  if (!state.files.length) {
    renderEmptyFile();
    setStatus("No files matched that query.");
    return;
  }

  await loadCurrentFile({ resetSearchTerm: true });
  setStatus("Queue loaded.");
}

async function moveFile(direction) {
  if (!state.files.length) {
    return;
  }

  const count = state.files.length;
  state.activeIndex = (state.activeIndex + direction + count) % count;
  await loadCurrentFile({ resetSearchTerm: true });
}

async function loadCurrentFile(options = {}) {
  const current = getCurrentFile();
  if (!current) {
    renderEmptyFile();
    return;
  }

  const { resetSearchTerm = false } = options;
  const renderToken = ++state.renderToken;

  setStatus(`Loading ${stripFilePrefix(current.title)}...`);
  renderFileLoading(current.title);

  const [pageData, mediaInfoData] = await Promise.all([
    commonsGet({
      action: "query",
      titles: current.title,
      prop: "imageinfo|categories",
      cllimit: "max",
      iiprop: "url",
    }),
    commonsGet({
      action: "wbgetentities",
      sites: "commonswiki",
      titles: current.title,
    }),
  ]);

  if (renderToken !== state.renderToken) {
    return;
  }

  const page = firstValue(pageData.query?.pages);
  const entity = firstValue(mediaInfoData.entities);
  const depictsIds = extractItemIds(entity, "P180");
  const symbolIds = extractItemIds(entity, "P8058");
  const labelMap = await wikidataEntityLabels([...depictsIds, ...symbolIds]);

  if (renderToken !== state.renderToken) {
    return;
  }

  state.currentDetail = {
    title: current.title,
    imageUrl: page?.imageinfo?.[0]?.url || "",
    categories: page?.categories || [],
    mediaInfoId: entity?.id || "",
    mediaInfoRev: entity?.lastrevid || 0,
    depicts: depictsIds.map((id) => labelMap[id] || { id, label: id }),
    symbolOf: symbolIds.map((id) => labelMap[id] || { id, label: id }),
  };

  renderCurrentFile();

  if (resetSearchTerm || !state.currentSearchTerm) {
    state.currentSearchTerm = buildSearchTerm(current.title);
    els.searchTerm.value = state.currentSearchTerm;
  }

  await reloadHelperResults(els.searchTerm.value.trim(), { silent: true, renderToken });
  setStatus(`Loaded ${stripFilePrefix(current.title)}.`);
}

async function reloadHelperResults(term, options = {}) {
  const current = getCurrentFile();
  if (!current) {
    return;
  }

  const searchTerm = term || buildSearchTerm(current.title);
  const renderToken = options.renderToken ?? state.renderToken;
  state.currentSearchTerm = searchTerm;
  els.searchTerm.value = searchTerm;

  if (!options.silent) {
    setStatus(`Searching Commons and Wikidata for “${searchTerm}”...`);
  }

  const [categoryData, wikidataData] = await Promise.all([
    commonsGet({
      action: "query",
      list: "search",
      srnamespace: "14",
      srlimit: "10",
      srsearch: searchTerm,
    }),
    wikidataGet({
      action: "wbsearchentities",
      language: "en",
      limit: "10",
      search: searchTerm,
    }),
  ]);

  if (renderToken !== state.renderToken) {
    return;
  }

  renderCategoryResults(categoryData.query?.search || []);
  renderWikidataResults(wikidataData.search || []);

  if (!options.silent) {
    setStatus(`Search updated for “${searchTerm}”.`);
  }
}

async function addCategory(rawCategory) {
  const title = normalizeCategoryTitle(rawCategory);
  if (!title) {
    setStatus("Enter a category name first.");
    return;
  }

  if (!(await ensureLoggedIn())) {
    return;
  }

  if (hasCategory(title)) {
    setStatus(`${title} is already on the file.`);
    return;
  }

  const current = getCurrentFile();
  if (!current) {
    return;
  }

  setStatus(`Adding ${title}...`);
  const pageData = await commonsGet({
    action: "query",
    titles: current.title,
    prop: "revisions",
    rvslots: "main",
    rvprop: "content|ids",
  });

  const page = firstValue(pageData.query?.pages);
  const revision = page?.revisions?.[0];
  const text = revision?.slots?.main?.["*"] || "";
  const revid = revision?.revid || 0;

  if (hasCategoryInText(text, title)) {
    setStatus(`${title} is already in the wikitext.`);
    await loadCurrentFile();
    return;
  }

  const newText = appendCategory(text, title);
  await commonsPost(
    {
      action: "edit",
      title: current.title,
      text: newText,
      summary: "Add category via Pinhead Commons Editor",
      baserevid: String(revid),
      token: await getCsrfToken(),
    },
    true
  );

  els.manualCategory.value = "";
  await loadCurrentFile();
  setStatus(`${title} added.`);
}

async function addClaim(propertyId, rawQid) {
  const qid = normalizeQid(rawQid);
  if (!qid) {
    setStatus("Enter a valid QID first.");
    return;
  }

  if (!(await ensureLoggedIn())) {
    return;
  }

  if (!state.currentDetail?.mediaInfoId) {
    setStatus("This file does not have a usable MediaInfo entity.");
    return;
  }

  const existingIds = propertyId === "P180"
    ? state.currentDetail.depicts.map((item) => item.id)
    : state.currentDetail.symbolOf.map((item) => item.id);

  if (existingIds.includes(qid)) {
    setStatus(`${qid} is already on the file.`);
    return;
  }

  const numericId = Number(qid.slice(1));
  const summary = propertyId === "P180"
    ? "Add depicts via Pinhead Commons Editor"
    : "Add symbol of via Pinhead Commons Editor";

  setStatus(`Adding ${qid}...`);
  await commonsPost(
    {
      action: "wbcreateclaim",
      entity: state.currentDetail.mediaInfoId,
      property: propertyId,
      snaktype: "value",
      value: JSON.stringify({ "entity-type": "item", "numeric-id": numericId }),
      baserevid: String(state.currentDetail.mediaInfoRev),
      summary,
      token: await getCsrfToken(),
    },
    true
  );

  els.manualQid.value = "";
  await loadCurrentFile({ resetSearchTerm: false });
  setStatus(`${qid} added.`);
}

async function ensureLoggedIn() {
  if (state.auth.accessToken) {
    return true;
  }
  setStatus("Log in to Commons first.");
  return false;
}

async function startOauthLogin() {
  const clientId = OAUTH_CLIENT_ID.trim();
  if (!clientId) {
    setStatus("This site is not configured for Wikimedia login yet.");
    return;
  }

  const verifier = randomString(64);
  const stateValue = randomString(32);
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = currentPageUrl();

  sessionStorage.setItem(PKCE_KEY, JSON.stringify({
    verifier,
    state: stateValue,
    clientId,
    redirectUri,
  }));

  const url = new URL(`${COMMONS_REST}/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", stateValue);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  window.location.href = url.toString();
}

async function finishOauthCallbackIfNeeded() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    history.replaceState({}, "", currentPageUrl());
    setStatus(`Commons login failed: ${error}.`);
    return;
  }

  if (!code) {
    return;
  }

  const stored = sessionStorage.getItem(PKCE_KEY);
  if (!stored) {
    history.replaceState({}, "", currentPageUrl());
    setStatus("Login callback arrived without saved PKCE state.");
    return;
  }

  const pkce = JSON.parse(stored);
  if (pkce.state !== returnedState) {
    history.replaceState({}, "", currentPageUrl());
    setStatus("Login callback state did not match.");
    return;
  }

  const tokenResponse = await fetch(`${COMMONS_REST}/oauth2/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: pkce.clientId,
      redirect_uri: pkce.redirectUri,
      code_verifier: pkce.verifier,
    }),
  });

  if (!tokenResponse.ok) {
    history.replaceState({}, "", currentPageUrl());
    throw new Error(`OAuth token exchange failed with ${tokenResponse.status}`);
  }

  const tokenData = await tokenResponse.json();
  state.auth = {
    accessToken: tokenData.access_token || "",
    expiresAt: Date.now() + ((tokenData.expires_in || 0) * 1000),
  };
  saveAuth();
  sessionStorage.removeItem(PKCE_KEY);
  history.replaceState({}, "", currentPageUrl());
  renderLoginStatus();
  setStatus("Logged in to Commons.");
}

function clearAuth() {
  state.auth = emptyAuth();
  state.csrfToken = "";
  saveAuth();
  renderLoginStatus();
}

async function getCsrfToken() {
  if (state.csrfToken) {
    return state.csrfToken;
  }

  const data = await commonsGet({
    action: "query",
    meta: "tokens",
    type: "csrf",
  }, true);

  const token = data.query?.tokens?.csrftoken;
  if (!token) {
    throw new Error("Could not load CSRF token");
  }

  state.csrfToken = token;
  return token;
}

function renderLoginStatus() {
  const hasClientId = Boolean(OAUTH_CLIENT_ID.trim());

  if (state.auth.accessToken) {
    els.loginStatus.textContent = "Logged in for this tab.";
  } else if (!hasClientId) {
    els.loginStatus.textContent = "Login is not configured yet. Set OAUTH_CLIENT_ID in app.js.";
  } else {
    els.loginStatus.textContent = "Not logged in.";
  }

  els.loginButton.disabled = !state.auth.accessToken && !hasClientId;
}

function renderQueueStatus() {
  if (!state.files.length) {
    els.queueStatus.textContent = "No files loaded.";
    return;
  }

  els.queueStatus.textContent = `Loaded ${state.files.length} files from ${formatNumber(state.totalHits)} total matches.`;
}

function renderFileLoading(title) {
  els.filePosition.textContent = stripFilePrefix(title);
  els.fileLink.href = buildCommonsFileUrl(title);
  els.fileLink.textContent = "Open file page";
  els.filePreview.hidden = true;
  renderList(els.currentCategories, []);
  renderList(els.currentDepicts, []);
  renderList(els.currentSymbols, []);
  renderList(els.categoryResults, []);
  renderList(els.wikidataResults, []);
}

function renderCurrentFile() {
  const current = getCurrentFile();
  if (!current || !state.currentDetail) {
    renderEmptyFile();
    return;
  }

  els.filePosition.textContent = `File ${state.activeIndex + 1} of ${state.files.length}: ${stripFilePrefix(current.title)}`;
  els.fileLink.href = buildCommonsFileUrl(current.title);
  els.fileLink.textContent = "Open file page";

  if (state.currentDetail.imageUrl) {
    els.filePreview.src = state.currentDetail.imageUrl;
    els.filePreview.alt = stripFilePrefix(current.title);
    els.filePreview.hidden = false;
  } else {
    els.filePreview.hidden = true;
  }

  renderList(
    els.currentCategories,
    state.currentDetail.categories.map((category) => ({
      label: category.title.replace(/^Category:/, ""),
      href: buildCommonsPageUrl(category.title),
    })),
    "No categories found."
  );

  renderList(
    els.currentDepicts,
    state.currentDetail.depicts.map((item) => ({
      label: `${item.label} (${item.id})`,
      href: `${WIKIDATA_WIKI}${item.id}`,
    })),
    "No depicts statements found."
  );

  renderList(
    els.currentSymbols,
    state.currentDetail.symbolOf.map((item) => ({
      label: `${item.label} (${item.id})`,
      href: `${WIKIDATA_WIKI}${item.id}`,
    })),
    "No symbol of statements found."
  );
}

function renderCategoryResults(results) {
  if (!results.length) {
    renderList(els.categoryResults, [], "No category matches found.");
    return;
  }

  els.categoryResults.innerHTML = "";
  results.forEach((result) => {
    const title = result.title;
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = buildCommonsPageUrl(title);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = title;
    item.append(link);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Add category";
    if (hasCategory(title)) {
      button.disabled = true;
      button.textContent = "Already added";
    } else {
      button.addEventListener("click", async () => {
        await addCategory(title);
      });
    }

    const actions = document.createElement("span");
    actions.className = "inline-actions";
    actions.append(button);
    item.append(" ", actions);
    els.categoryResults.append(item);
  });
}

function renderWikidataResults(results) {
  if (!results.length) {
    renderList(els.wikidataResults, [], "No Wikidata matches found.");
    return;
  }

  els.wikidataResults.innerHTML = "";
  results.forEach((result) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `${WIKIDATA_WIKI}${result.id}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `${result.label || result.id} (${result.id})`;
    item.append(link);

    if (result.description) {
      item.append(` - ${result.description}`);
    }

    const depictsButton = document.createElement("button");
    depictsButton.type = "button";
    depictsButton.textContent = hasClaim("P180", result.id) ? "Already depicts" : "Add depicts";
    depictsButton.disabled = hasClaim("P180", result.id);
    if (!depictsButton.disabled) {
      depictsButton.addEventListener("click", async () => {
        await addClaim("P180", result.id);
      });
    }

    const symbolButton = document.createElement("button");
    symbolButton.type = "button";
    symbolButton.textContent = hasClaim("P8058", result.id) ? "Already symbol of" : "Add symbol of";
    symbolButton.disabled = hasClaim("P8058", result.id);
    if (!symbolButton.disabled) {
      symbolButton.addEventListener("click", async () => {
        await addClaim("P8058", result.id);
      });
    }

    const actions = document.createElement("span");
    actions.className = "inline-actions";
    actions.append(depictsButton, symbolButton);
    item.append(" ", actions);
    els.wikidataResults.append(item);
  });
}

function renderList(container, items, emptyText = "") {
  container.innerHTML = "";

  if (!items.length) {
    if (!emptyText) {
      return;
    }
    const li = document.createElement("li");
    li.textContent = emptyText;
    container.append(li);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");
    if (item.href) {
      const link = document.createElement("a");
      link.href = item.href;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = item.label;
      li.append(link);
    } else {
      li.textContent = item.label;
    }
    container.append(li);
  });
}

function renderEmptyFile() {
  els.filePosition.textContent = "No file loaded.";
  els.fileLink.href = "#";
  els.fileLink.textContent = "Open file page";
  els.filePreview.hidden = true;
  renderList(els.currentCategories, [], "No categories loaded.");
  renderList(els.currentDepicts, [], "No depicts loaded.");
  renderList(els.currentSymbols, [], "No symbol of statements loaded.");
  renderList(els.categoryResults, [], "No category search results.");
  renderList(els.wikidataResults, [], "No Wikidata search results.");
}

function getCurrentFile() {
  return state.files[state.activeIndex] || null;
}

function hasCategory(title) {
  const normalized = normalizeCategoryTitle(title);
  return state.currentDetail?.categories?.some(
    (category) => normalizeCategoryTitle(category.title) === normalized
  ) || false;
}

function hasClaim(propertyId, qid) {
  if (!state.currentDetail) {
    return false;
  }

  const ids = propertyId === "P180"
    ? state.currentDetail.depicts.map((item) => item.id)
    : state.currentDetail.symbolOf.map((item) => item.id);
  return ids.includes(qid);
}

function setStatus(message) {
  els.status.textContent = message;
}

function buildSearchTerm(title) {
  return stripFilePrefix(title)
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\bPinhead\b/gi, "")
    .replace(/\bicons?\b/gi, "")
    .replace(/\bsvg\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCategoryTitle(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("Category:") ? trimmed : `Category:${trimmed}`;
}

function normalizeQid(value) {
  const match = value.trim().match(/Q\d+/i);
  return match ? match[0].toUpperCase() : "";
}

function stripFilePrefix(title) {
  return title.replace(/^File:/, "");
}

function appendCategory(text, title) {
  const trimmed = text.replace(/\s+$/, "");
  return `${trimmed}\n\n[[${title}]]\n`;
}

function hasCategoryInText(text, title) {
  const escaped = escapeRegExp(title.replace(/^Category:/i, "").replaceAll("_", " "));
  const pattern = new RegExp(`\\[\\[\\s*Category\\s*:\\s*${escaped.replaceAll("\\ ", "[ _]+")}(\\|[^\\]]*)?\\]\\]`, "i");
  return pattern.test(text);
}

function buildCommonsFileUrl(title) {
  return buildCommonsPageUrl(title);
}

function buildCommonsPageUrl(title) {
  return `${COMMONS_WIKI}${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

function currentPageUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

async function commonsGet(params, authenticated = false) {
  return actionGet(COMMONS_API, params, authenticated ? state.auth.accessToken : "");
}

async function wikidataGet(params) {
  return actionGet(WIKIDATA_API, params, "");
}

async function actionGet(baseUrl, params, accessToken = "") {
  const url = new URL(baseUrl);
  url.searchParams.set("format", "json");
  if (accessToken) {
    url.searchParams.set("crossorigin", "1");
  } else {
    url.searchParams.set("origin", "*");
  }

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.info || data.error.code || "API error");
  }
  return data;
}

async function commonsPost(params, authenticated = false) {
  const url = new URL(COMMONS_API);
  url.searchParams.set("format", "json");
  if (authenticated && state.auth.accessToken) {
    url.searchParams.set("crossorigin", "1");
  } else {
    url.searchParams.set("origin", "*");
  }

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
  };

  if (authenticated && state.auth.accessToken) {
    headers.Authorization = `Bearer ${state.auth.accessToken}`;
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: new URLSearchParams(params),
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    if (data.error.code === "badtoken") {
      state.csrfToken = "";
    }
    throw new Error(data.error.info || data.error.code || "API error");
  }
  return data;
}

async function wikidataEntityLabels(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) {
    return {};
  }

  const data = await wikidataGet({
    action: "wbgetentities",
    ids: uniqueIds.join("|"),
    props: "labels|descriptions",
    languages: "en",
  });

  const result = {};
  Object.entries(data.entities || {}).forEach(([id, entity]) => {
    if (!entity || entity.missing !== undefined) {
      return;
    }
    result[id] = {
      id,
      label: entity.labels?.en?.value || id,
      description: entity.descriptions?.en?.value || "",
    };
  });
  return result;
}

function extractItemIds(entity, propertyId) {
  return [...new Set(
    (entity?.statements?.[propertyId] || [])
      .map((statement) => statement?.mainsnak?.datavalue?.value?.id)
      .filter(Boolean)
  )];
}

function firstValue(object) {
  if (!object) {
    return null;
  }
  const values = Object.values(object);
  return values[0] || null;
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      query: parsed.query || DEFAULT_QUERY,
    };
  } catch (error) {
    console.error(error);
    return {
      query: DEFAULT_QUERY,
    };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function emptyAuth() {
  return {
    accessToken: "",
    expiresAt: 0,
  };
}

function loadAuth() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(AUTH_KEY) || "{}");
    if (!parsed.accessToken || (parsed.expiresAt && parsed.expiresAt < Date.now())) {
      return emptyAuth();
    }
    return {
      accessToken: parsed.accessToken || "",
      expiresAt: parsed.expiresAt || 0,
    };
  } catch (error) {
    console.error(error);
    return emptyAuth();
  }
}

function saveAuth() {
  sessionStorage.setItem(AUTH_KEY, JSON.stringify(state.auth));
}

function randomString(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => (byte % 36).toString(36)).join("");
}

async function sha256Base64Url(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
