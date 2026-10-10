"use strict";

var STORAGE_KEY = "attendance_diary_data";
var SYNC_CONFIG_KEY = "attendance_sync_config";
var DEVICE_ID_KEY = "attendance_device_id";
var INTERVAL_KEY = "attendance_poll_interval";
var GIST_FILENAME = "attendance.json";
// Sync pacing (performance): polling the Gist API every 5 s on a phone drains
// battery and repeatedly re-merges/re-renders the whole journal — the main
// cause of interface lag. New default: 30 s with an exponential backoff up to
// 60 s while the connection keeps failing. Pushes after edits are debounced
// 2.5 s so rapid tapping no longer queues several uploads in a row.
var DEFAULT_POLL_INTERVAL_MS = 60000, PUSH_DEBOUNCE_MS = 2500;
// One-time migration of previously saved intervals: devices that still carry
// the old aggressive "5 s" or "15 s" setting would keep hammering GitHub and
// re-merging/re-rendering every few seconds — the main background lag source.
// Manual mode (0) and the gentle "60 s" choice are left untouched.
function migratePollInterval(ms) { return ms === 5000 || ms === 15000 || ms === 30000 ? DEFAULT_POLL_INTERVAL_MS : ms; }
var SETTINGS_UNLOCK_KEY = "attendance_settings_unlocked";
var SETTINGS_CODE_SET_KEY = "attendance_settings_code_set";
var BACKUP_KEY = "attendance_recovery_backups";
var NEWS_DISMISS_KEY = "attendance_news_dismissed";
var AUTH_ACCOUNTS_KEY = "attendance_auth_accounts";
var AUTH_SESSION_KEY = "attendance_auth_session";
// Local deletion tombstones for account sync (so a removed account does not
// come back from another device's older Gist copy).
var AUTH_TOMBSTONES_KEY = "attendance_auth_tombstones";
var TOMBSTONE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000; // half a year
var DEFAULT_VERSION_TEXT = "версия: 3.3";
var DEFAULT_MAINTENANCE_MSG = "Журнал временно на обслуживании. Попробуйте вернуться позже.";
var STATUS_PRESENT = "present", STATUS_ABSENT = "absent", STATUS_LATE = "late", STATUS_UNMARKED = "unmarked";
var statusLabels = { present: "Присутствует", absent: "Отсутствует", late: "Онлайн", unmarked: "Не отмечено" };
var statusSymbols = { present: "✓", absent: "Н", late: "О", unmarked: "·" }; // символ «О» сохранён для совместимости с историческими отметками типа late
var settingFields = ["maintenance", "maintenanceMessage", "maintenanceBy", "news", "versionText"];
var monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
var weekdayNames = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
var state = { students: [], attendance: {}, settings: defaultSettings(), selectedMonth: getMonthString(new Date()), searchQuery: "", revision: 0, lastSyncedRevision: 0, devUnlocked: false, deviceMeta: {}, homework: [] };
var syncConfig = { enabled: false, token: "", gistId: "", isPublicGist: false, lastSync: 0, lastSyncStatus: "off", lastError: "" };
var deviceId = "", logicalTime = 0, activeModal = null, previousFocus = null, modalStack = [];
var attendanceModalState = { open: false, studentId: "", dateKey: "", currentStatus: STATUS_UNMARKED };
var dom = {};
["userList", "refreshUserListButton", "studentName", "addStudentButton", "monthPicker", "previousMonthButton", "nextMonthButton", "todayButton", "monthTitle", "tableHead", "tableBody", "emptyMessage", "searchInput", "clearSearchButton", "searchResultsInfo", "noSearchResults", "toast", "syncStatus", "syncStatusText", "toggleSyncConfigButton", "syncConfig", "githubToken", "gistId", "gistPublicCheckbox", "publicGistWarning", "saveSyncConfigButton", "testConnectionButton", "disableSyncButton", "syncNowButton", "forcePushButton", "forcePullButton", "debugButton", "refreshDebugButton", "copyDebugButton", "debugBlock", "debugPre", "intervalSelect", "newsBanner", "newsText", "newsCloseButton", "versionButton", "versionButtonText", "journalEdition", "devPanelModal", "devCloseButton", "devExitButton", "devVersionTextInput", "devSaveVersionTextButton", "devResetVersionTextButton", "devToggleMaintenanceButton", "devMaintenanceMessageInput", "devSaveMaintenanceMessageButton", "devResetMaintenanceMessageButton", "devNewsInput", "devSaveNewsButton", "devClearNewsButton", "devClearAllButton", "maintenanceOverlay", "maintenanceMessageText", "maintenanceActiveBadge", "maintenanceDevAccessButton", "attendanceModal", "attCloseButton", "attStudentName", "attDateText", "attOptions", "localSaveStatus", "exportBackupButton", "importBackupButton", "importBackupInput", "restoreBackupButton", "printButton", "summaryStudents", "summaryPresent", "summaryAbsent", "summaryLate", "coverageInfo", "journalApp", "printMonthTitle"].forEach(function (id) { dom[id] = document.getElementById(id); });
dom.studentNameInput = dom.studentName;
var storage = accessibleStorage("localStorage"), sessStorage = accessibleStorage("sessionStorage");
/* ---------- Educational institutions (учебные учреждения) ---------- */
// The registry of institutions is global and lives in plain localStorage; the
// journal itself is scoped per institution: every key this app writes goes
// through instKey(), which prefixes it with the currently active institution
// id. Switching an institution therefore swaps the ENTIRE dataset namespace —
// same page, completely different data (students, classes, attendance, sync
// config, settings unlock, backups). Legacy installs that predate institutions
// keep working untouched: while the active id is "inst-main" keys stay exactly
// as they were before.
var INSTITUTIONS_KEY = "attendance_institutions";
var ACTIVE_INSTITUTION_KEY = "attendance_active_institution";
// The active-institution pointer must be device-wide, NOT per-institution:
// it used to be namespaced by instKey(), so opening institution B from A's
// settings left the old key behind and a plain page reload bounced back to A.
var GLOBAL_ACTIVE_INSTITUTION_KEY = ACTIVE_INSTITUTION_KEY;
var INSTITUTION_NAME_KEY = "attendance_institution_name_main"; // rename of the default institution
var DEFAULT_INSTITUTION_ID = "inst-main";
function validInstId(id) { return typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id); }
function migrateInstitutions(list) {
  var out = [], seen = {};
  (Array.isArray(list) ? list : []).forEach(function (v) {
    if (!v || !validInstId(v.id) || v.id === DEFAULT_INSTITUTION_ID || seen[v.id]) return;
    seen[v.id] = true;
    var name = typeof v.name === "string" ? v.name.trim().slice(0, 200) : "";
    if (!name) return;
    out.push({ id: v.id, name: name, createdAt: Number(v.createdAt) > 0 ? Number(v.createdAt) : Date.now() });
  });
  return out;
}
function loadInstitutions() {
  if (!storage) return [];
  try { return migrateInstitutions(JSON.parse(storage.getItem(INSTITUTIONS_KEY) || "[]")); } catch (e) { return []; }
}
function saveInstitutions(list) {
  if (!storage) throw new Error("Браузер не сохраняет данные учреждений");
  storage.setItem(INSTITUTIONS_KEY, JSON.stringify(migrateInstitutions(list)));
  renderInstitutionList();
}
function getActiveInstitutionId() {
  // Fixed at load time on purpose: all module-level init constants (deviceId,
  // logicalTime, initial state) are built from the storage of the institution
  // active in the URL/tab; switching to another institution reloads the page.
  if (typeof window !== "undefined") {
    try {
      var fromUrl = new URLSearchParams(window.location.search || "").get("inst");
      if (validInstId(fromUrl)) return fromUrl;
    } catch (e) {}
  }
  if (storage) { try { var saved = storage.getItem(GLOBAL_ACTIVE_INSTITUTION_KEY); if (validInstId(saved)) return saved; } catch (e) {} }
  return DEFAULT_INSTITUTION_ID;
}
var ACTIVE_INSTITUTION_ID = getActiveInstitutionId();
// One-time cleanup: older builds namespaced the active pointer per
// institution (e.g. "inst-xxx_attendance_active_institution"), which made
// reloads jump back to the previous institution. Drop those stale keys.
try {
  if (storage) {
    var staleKeys = [];
    for (var si = 0; si < storage.length; si++) {
      var sk = storage.key(si);
      if (sk && sk !== GLOBAL_ACTIVE_INSTITUTION_KEY && sk.slice(-GLOBAL_ACTIVE_INSTITUTION_KEY.length - 1) === "_" + GLOBAL_ACTIVE_INSTITUTION_KEY) staleKeys.push(sk);
    }
    staleKeys.forEach(function (k) { try { storage.removeItem(k); } catch (e) {} });
  }
} catch (e) {}
function institutionNameById(id) {
  if (id === DEFAULT_INSTITUTION_ID) {
    try { var custom = storage && storage.getItem(INSTITUTION_NAME_KEY); if (typeof custom === "string" && custom.trim()) return custom.trim().slice(0, 200); } catch (e) {}
    return "Основное учреждение";
  }
  var found = loadInstitutions().find(function (i) { return i.id === id; });
  return found ? found.name : "Учреждение " + id;
}
// Namespace every persisted key by the active institution. Default institution
// keeps the historical un-prefixed keys so existing journals open unchanged.
function instKey(key) { return ACTIVE_INSTITUTION_ID === DEFAULT_INSTITUTION_ID ? key : ACTIVE_INSTITUTION_ID + "_" + key; }
if (ACTIVE_INSTITUTION_ID !== DEFAULT_INSTITUTION_ID) {
  STORAGE_KEY = instKey(STORAGE_KEY); SYNC_CONFIG_KEY = instKey(SYNC_CONFIG_KEY); DEVICE_ID_KEY = instKey(DEVICE_ID_KEY);
  INTERVAL_KEY = instKey(INTERVAL_KEY); SETTINGS_UNLOCK_KEY = instKey(SETTINGS_UNLOCK_KEY); SETTINGS_CODE_SET_KEY = instKey(SETTINGS_CODE_SET_KEY);
  BACKUP_KEY = instKey(BACKUP_KEY); NEWS_DISMISS_KEY = instKey(NEWS_DISMISS_KEY); AUTH_ACCOUNTS_KEY = instKey(AUTH_ACCOUNTS_KEY);
  AUTH_SESSION_KEY = instKey(AUTH_SESSION_KEY); AUTH_TOMBSTONES_KEY = instKey(AUTH_TOMBSTONES_KEY);
  // ACTIVE_INSTITUTION_KEY stays deliberately UN-namespaced (see GLOBAL_ACTIVE_INSTITUTION_KEY):
  // the "where should a plain reload land" pointer is device-wide, so opening
  // another institution survives F5 / mobile tab restores.
}
function switchToInstitution(id) {
  if (!validInstId(id)) return false;
  if (id === ACTIVE_INSTITUTION_ID) { showToast("Вы уже в этом учреждении", "info"); return false; }
  flushSaveLocal();
  try { if (storage) storage.setItem(ACTIVE_INSTITUTION_KEY, id); } catch (e) {}
  var url = new URL(window.location.href);
  if (id === DEFAULT_INSTITUTION_ID) url.searchParams.delete("inst"); else url.searchParams.set("inst", id);
  window.location.assign(url.href);
  return true;
}
function renderInstitutionList() {
  var container = dom.institutionList; if (!container) return;
  var items = loadInstitutions();
  // Must be computed BEFORE makeRow runs: it is referenced inside the row
  // builder, and used to sit after the first call — a TDZ ReferenceError that
  // silently broke the whole institutions section in settings.
  var canManage = effectivePermissions().canManageDevices;
  container.textContent = "";
  function makeRow(id, name, isDefault, canDelete) {
    var row = document.createElement("div"); row.className = "device-row institution-row";
    var info = document.createElement("div");
    var label = document.createElement("span"); label.className = "device-name"; label.textContent = name; info.appendChild(label);
    if (isDefault) { var b = document.createElement("span"); b.className = "device-badge"; b.textContent = "основное"; info.appendChild(b); }
    if (id === ACTIVE_INSTITUTION_ID) { var cur = document.createElement("span"); cur.className = "device-badge"; cur.textContent = "открыто"; info.appendChild(cur); }
    var count = null;
    try { var raw = storage && storage.getItem(instKeyFor(id, STORAGE_KEY)); if (raw) { var parsed = JSON.parse(raw); count = (parsed.students || []).filter(function (s) { return s && !s.deleted; }).length; } } catch (e) {}
    var meta = document.createElement("span"); meta.className = "device-seen";
    meta.textContent = count === null ? "Данных пока нет" : "Учеников в журнале: " + count;
    row.append(info, meta);
    // Open button: the default institution is always openable; a non-default
    // one only when it actually exists in the registry (stale ACTIVE ids from
    // removed institutions must not offer a broken "open" action).
    var openable = id === DEFAULT_INSTITUTION_ID || items.some(function (i) { return i.id === id; });
    if (id === ACTIVE_INSTITUTION_ID && !openable) openable = true; // current tab's own row stays consistent
    var open = document.createElement("button"); open.type = "button"; open.className = "secondary institution-open";
    open.dataset.institutionId = id; open.textContent = id === ACTIVE_INSTITUTION_ID ? "Текущее" : "Открыть журнал";
    open.disabled = id === ACTIVE_INSTITUTION_ID || !openable;
    row.appendChild(open);
    if (canManage && openable) {
      var ren = document.createElement("button"); ren.type = "button"; ren.className = "secondary institution-rename";
      ren.dataset.institutionId = id; ren.textContent = "Переименовать";
      ren.title = "Изменить название учреждения";
      row.appendChild(ren);
    }
    if (canDelete) {
      var del = document.createElement("button"); del.type = "button"; del.className = "danger institution-remove";
      del.dataset.institutionId = id; del.textContent = "Удалить";
      del.title = "Удалить учреждение и все его данные с этого устройства";
      row.appendChild(del);
    }
    return row;
  }
  container.appendChild(makeRow(DEFAULT_INSTITUTION_ID, institutionNameById(DEFAULT_INSTITUTION_ID), true, false));
  items.forEach(function (inst) { container.appendChild(makeRow(inst.id, inst.name, false, canManage)); });
  if (!items.length) {
    var hint = document.createElement("p"); hint.className = "help-text";
    hint.textContent = "Других учреждений пока нет — добавьте новое кнопкой выше.";
    container.appendChild(hint);
  }
}
function instKeyFor(id, key) { return id === DEFAULT_INSTITUTION_ID ? key : id + "_" + key; }
// Rename: the default institution is stored under a fixed display name, so its
// rename is persisted as a dedicated override key. Other institutions are
// renamed inside the registry list. Renaming never touches journal data keys.
function renameInstitution(id) {
  if (!effectivePermissions().canManageDevices) { showToast("Переименование доступно учителю или тех. администрации", "warning"); return; }
  var currentName = institutionNameById(id);
  var name = window.prompt("Новое название учреждения", currentName); if (name === null) return;
  name = name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 200) { showToast("Введите название до 200 символов", "warning"); return; }
  if (name.toLowerCase() === currentName.toLowerCase()) return;
  if (id === DEFAULT_INSTITUTION_ID) {
    var others = loadInstitutions();
    if (others.some(function (i) { return i.name.toLowerCase() === name.toLowerCase(); })) { showToast("Такое учреждение уже есть", "warning"); return; }
    try { storage.setItem(INSTITUTION_NAME_KEY, name); } catch (e) { showToast("Браузер не сохранил название: " + e.message, "error"); return; }
    renderInstitutionList(); updateInstitutionBanner();
    showToast("Основное учреждение переименовано в «" + name + "»", "success");
    return;
  }
  var items = loadInstitutions();
  if (institutionNameById(DEFAULT_INSTITUTION_ID).toLowerCase() === name.toLowerCase() || items.some(function (i) { return i.id !== id && i.name.toLowerCase() === name.toLowerCase(); })) { showToast("Такое учреждение уже есть", "warning"); return; }
  var found = items.find(function (i) { return i.id === id; });
  if (!found) { showToast("Учреждение не найдено — обновите список", "warning"); renderInstitutionList(); return; }
  found.name = name; saveInstitutions(items); updateInstitutionBanner();
  showToast("Учреждение переименовано в «" + name + "»", "success");
}
function updateInstitutionBanner() {
  var banner = dom.institutionBanner; if (!banner) return;
  var text = dom.institutionBannerText;
  if (ACTIVE_INSTITUTION_ID === DEFAULT_INSTITUTION_ID && !storage) { banner.hidden = true; return; }
  var name = institutionNameById(ACTIVE_INSTITUTION_ID);
  if (text) text.textContent = "Учреждение: " + name;
  banner.hidden = !(name && name !== "Основное учреждение") && !(typeof window !== "undefined" && new URLSearchParams(window.location.search || "").get("inst"));
  // Show the banner whenever an explicit non-default institution is active.
  if (ACTIVE_INSTITUTION_ID !== DEFAULT_INSTITUTION_ID) banner.hidden = false;
}
function addInstitution() {
  if (!effectivePermissions().canManageDevices) { showToast("Добавление учреждений доступно учителю или тех. администрации", "warning"); return; }
  var name = window.prompt("Название учебного учреждения"); if (name === null) return;
  name = name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 200) { showToast("Введите название до 200 символов", "warning"); return; }
  var items = loadInstitutions();
  if (institutionNameById(DEFAULT_INSTITUTION_ID).toLowerCase() === name.toLowerCase() || items.some(function (i) { return i.name.toLowerCase() === name.toLowerCase(); })) { showToast("Такое учреждение уже есть", "warning"); return; }
  var entry = { id: generateId(), name: name, createdAt: Date.now() };
  items.push(entry); saveInstitutions(items);
  showToast("Учреждение «" + name + "» добавлено. Откройте его кнопкой «Открыть журнал».", "success");
}
function removeInstitution(id) {
  if (!effectivePermissions().canManageDevices) { showToast("Удаление учреждений доступно учителю или тех. администрации", "warning"); return; }
  if (id === DEFAULT_INSTITUTION_ID || id === ACTIVE_INSTITUTION_ID) { showToast("Нельзя удалить основное или открытое сейчас учреждение", "warning"); return; }
  var items = loadInstitutions(), inst = items.find(function (i) { return i.id === id; });
  if (!inst) { showToast("Учреждение не найдено — обновите список", "warning"); renderInstitutionList(); return; }
  if (!window.confirm("Удалить учреждение «" + inst.name + "»?\nЕго журнал (ученики, отметки, настройки синхронизации) будет стёрт с ЭТОГО устройства. Данные в Gist другого устройства останутся.")) return;
  var word = window.prompt("Необратимое действие.\nДля подтверждения введите название учреждения точно:\n" + inst.name);
  if (word === null) { showToast("Удаление отменено", "info"); return; }
  if (word.trim().toLowerCase() !== inst.name.trim().toLowerCase()) { showToast("Название не совпало — удаление отменено", "info"); return; }
  var suffixes = ["_attendance_diary_data", "_attendance_sync_config", "_attendance_device_id", "_attendance_poll_interval", "_attendance_settings_unlocked", "_attendance_settings_code_set", "_attendance_recovery_backups", "_attendance_news_dismissed", "_attendance_auth_accounts", "_attendance_auth_session"];
  try { suffixes.forEach(function (s) { storage.removeItem(id + s); }); } catch (e) { showToast("Не удалось стереть данные учреждения: " + e.message, "error"); return; }
  saveInstitutions(items.filter(function (i) { return i.id !== id; }));
  // The active pointer is device-wide and never namespaced — compare against
  // the raw key, not the per-institution variant left by older builds.
  try { if (storage.getItem(GLOBAL_ACTIVE_INSTITUTION_KEY) === id) storage.removeItem(GLOBAL_ACTIVE_INSTITUTION_KEY); } catch (e) {}
  showToast("Учреждение «" + inst.name + "» удалено вместе с его данными на этом устройстве.", "success");
}

function accessibleStorage(name) {
  try { var value = window[name], key = "attendance_probe_" + Math.random(); value.setItem(key, "1"); value.removeItem(key); return value; } catch (e) { return null; }
}
function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
}
function getDeviceId() {
  if (!storage) return generateId();
  try { var id = storage.getItem(DEVICE_ID_KEY); if (!id || !validId(id)) { id = generateId(); storage.setItem(DEVICE_ID_KEY, id); } return id; }
  catch (e) { return generateId(); }
}
function getMonthString(date) { return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0"); }
function formatDateKey(date) { return getMonthString(date) + "-" + String(date.getDate()).padStart(2, "0"); }
function parseMonth(s) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s) || Number(s.slice(0, 4)) < 1000) throw new Error("Некорректный месяц");
  return new Date(Number(s.slice(0, 4)), Number(s.slice(5)) - 1, 1);
}
function parseDateKey(s) { return new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))); }
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && formatDateKey(parseDateKey(s)) === s && Number(s.slice(0, 4)) >= 1000; }
function validId(id) { return typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id); }
function getDaysInMonth(s) { var d = parseMonth(s), n = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(), arr = []; for (var i = 1; i <= n; i++) arr.push(new Date(d.getFullYear(), d.getMonth(), i)); return arr; }
function isWeekend(d) { return d.getDay() === 0 || d.getDay() === 6; }
function isToday(d) { return formatDateKey(d) === formatDateKey(new Date()); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ":" + canonical(value[key]); }).join(",") + "}";
  return JSON.stringify(value);
}
function isDataEqual(a, b) { return canonical(a) === canonical(b); }
function defaultSettings() { return { maintenance: false, maintenanceMessage: DEFAULT_MAINTENANCE_MSG, maintenanceBy: "", news: "", versionText: DEFAULT_VERSION_TEXT, updatedAt: 0, fieldMeta: {} }; }
function timestamp(value, strict) {
  var time = Number(value || 0);
  if (!Number.isFinite(time) || time < 0 || time > Date.now() + 86400000) { if (strict) throw new Error("Некорректная дата изменения записи"); return 0; }
  logicalTime = Math.max(logicalTime, time); return time;
}
function nextTimestamp() { logicalTime = Math.max(Date.now(), logicalTime + 1); return logicalTime; }
function normalizeDefaultVersion(value,meta) {
  // Unedited release labels have no causal history; changing the app version
  // is not a competing user edit. Custom labels and stamped edits are preserved.
  return (!meta || (!meta.updatedAt && !Object.keys(meta.clock || {}).length)) && /^версия: (?:2(?:\.1)?|3(?:\.[0123])?)$/i.test(value) ? DEFAULT_VERSION_TEXT : value;
}
function cloneSettings(s, strict) {
  var result = defaultSettings(); s = s || {};
  result.maintenance = s.maintenance === true;
  result.maintenanceMessage = typeof s.maintenanceMessage === "string" && s.maintenanceMessage.trim() ? s.maintenanceMessage.slice(0, 2000) : DEFAULT_MAINTENANCE_MSG;
  result.maintenanceBy = validId(s.maintenanceBy) ? s.maintenanceBy : "";
  result.news = typeof s.news === "string" ? s.news.slice(0, 4000) : "";
  result.versionText = typeof s.versionText === "string" && s.versionText.trim() ? s.versionText.trim().slice(0, 60) : DEFAULT_VERSION_TEXT;
  result.updatedAt = timestamp(s.updatedAt, strict);
  settingFields.forEach(function (field) {
    var meta = s.fieldMeta && s.fieldMeta[field];
    result.fieldMeta[field] = { updatedAt: timestamp(meta ? meta.updatedAt : s.updatedAt, strict), actor: meta && validId(meta.actor) ? meta.actor : (validId(s.actor) ? s.actor : ""), clock: cleanClock(meta && meta.clock, meta ? meta.updatedAt : s.updatedAt) };
  });
  result.versionText = normalizeDefaultVersion(result.versionText, result.fieldMeta.versionText);
  return result;
}
function normalizeStatusEntry(v, strict) {
  if (typeof v === "boolean") return { status: v ? STATUS_ABSENT : STATUS_PRESENT, updatedAt: 0, actor: "" };
  if (!v || typeof v !== "object" || Array.isArray(v)) { if (strict) throw new Error("Некорректная отметка посещаемости"); return null; }
  var status = v.status;
  if (!status && typeof v.absent === "boolean") status = v.absent ? STATUS_ABSENT : STATUS_PRESENT;
  if (!Object.prototype.hasOwnProperty.call(statusLabels, status)) { if (strict) throw new Error("Неизвестный статус посещаемости"); return null; }
  return { status: status, updatedAt: timestamp(v.updatedAt, strict), actor: validId(v.actor) ? v.actor : "", clock: cleanClock(v.clock, v.updatedAt) };
}
function migrateData(data, strict) {
  var result = { version: 5, students: [], attendance: {}, settings: defaultSettings(), deviceMeta: {} };
  if (!data || typeof data !== "object" || Array.isArray(data)) { if (strict) throw new Error("Файл не содержит журнал"); return result; }
  if (strict && (!Array.isArray(data.students) || !data.attendance || typeof data.attendance !== "object" || Array.isArray(data.attendance))) throw new Error("Неверный формат журнала");
  if (strict && data.version && (!Number.isInteger(data.version) || data.version > 5 || data.version < 1)) throw new Error("Эта версия журнала не поддерживается");
  var seen = new Set();
  if (Array.isArray(data.students)) {
    if (data.students.length > 10000) throw new Error("Слишком много учеников в файле");
    data.students.forEach(function (s) {
      if (!s || !validId(s.id) || typeof s.name !== "string" || !s.name.trim() || s.name.length > 200 || seen.has(s.id)) { if (strict) throw new Error("Некорректная или повторяющаяся запись ученика"); return; }
      seen.add(s.id); result.students.push({ id: s.id, name: s.name.trim(), updatedAt: timestamp(s.updatedAt, strict), actor: validId(s.actor) ? s.actor : "", deleted: s.deleted === true, classId: validId(s.classId) ? s.classId : "class-main", clock: cleanClock(s.clock, s.updatedAt) });
    });
  }
  if (data.attendance && typeof data.attendance === "object" && !Array.isArray(data.attendance)) {
    var keys = Object.keys(data.attendance);
    if (keys.length > 500000) throw new Error("Слишком много отметок в файле");
    keys.forEach(function (key) {
      var split = key.lastIndexOf("_"), id = key.slice(0, split), date = key.slice(split + 1);
      if (!validId(id) || !validDate(date)) { if (strict) throw new Error("Некорректный ключ посещаемости"); return; }
      var value = normalizeStatusEntry(data.attendance[key], strict); if (value) result.attendance[key] = value;
    });
  }
  result.settings = cloneSettings(data.settings, strict); result.deviceMeta = cleanDeviceMeta(data.deviceMeta); return result;
}
// Per-device metadata (human-readable name + last activity) that travels with
// every journal snapshot inside the device's own Gist file. It never affects
// journal records and is safe to merge from all devices.
function cleanDeviceMeta(meta) {
  var result = {};
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return result;
  Object.keys(meta).slice(0, 200).forEach(function (id) {
    if (!validId(id)) return;
    var entry = meta[id];
    if (!entry || typeof entry !== "object") return;
    var name = typeof entry.name === "string" ? entry.name.trim().slice(0, 40) : "";
    var seenAt = Number(entry.seenAt);
    var updatedAt = Number(entry.updatedAt);
    // Device role: teacher / student / observer (default: teacher).
    // techAdmin is a separate ADD-ON flag (granted via the settings password),
    // not a base role — it stacks on top of any role. See DEVICE_ROLES below.
    var role = DEVICE_ROLE_KEYS.indexOf(entry.role) !== -1 ? entry.role : "teacher";
    var techAdmin = entry.techAdmin === true || entry.role === "admin"; // migrate legacy "admin" role → add-on flag
    var roleExplicit = entry.roleExplicit === true;
    result[id] = { name: name, role: role, roleExplicit: roleExplicit, techAdmin: techAdmin, seenAt: Number.isFinite(seenAt) && seenAt > 0 ? seenAt : 0, updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0 };
  });
  return result;
}
function mergeDeviceMeta(local, remote) {
  var result = Object.assign({}, local || {}), remoteData = remote || {};
  Object.keys(remoteData).forEach(function (id) {
    var incoming = remoteData[id], existing = result[id];
    if (!existing) { result[id] = incoming; return; }
    var latest = (incoming.updatedAt || 0) >= (existing.updatedAt || 0) ? incoming : existing;
    var other = latest === incoming ? existing : incoming;
    result[id] = { name: (latest.name || other.name || ""), role: DEVICE_ROLE_KEYS.indexOf(latest.role) !== -1 ? latest.role : (DEVICE_ROLE_KEYS.indexOf(other.role) !== -1 ? other.role : "teacher"), roleExplicit: Boolean((latest === incoming ? incoming.roleExplicit : existing.roleExplicit) || (latest === existing ? existing.roleExplicit : incoming.roleExplicit)), techAdmin: Boolean(latest.techAdmin || other.techAdmin), seenAt: Math.max(existing.seenAt || 0, incoming.seenAt || 0), updatedAt: Math.max(existing.updatedAt || 0, incoming.updatedAt || 0) };
  });
  return result;
}
/* ---------- Device roles (teacher / student / observer) + tech-admin add-on ---------- */
// Base roles are stored in deviceMeta and travel inside the synced journal, so
// the whole fleet sees one consistent assignment. Editing roles requires a write
// connection (token); the current device always keeps its own role editable.
// "Тех. администрация" is NOT a base role: it is an add-on flag granted on a
// device after entering the settings password; it stacks next to any base role
// and unlocks every function regardless of that role.
var DEVICE_ROLES = {
  teacher: { label: "Учитель", hint: "Отметки посещаемости, добавление учеников и классов, задания (добавление/удаление), статистика." },
  student: { label: "Ученик", hint: "Только просмотр домашних заданий и своей посещаемости/пропусков." },
  observer: { label: "Наблюдатель", hint: "Полный обзор журнала, отчётов и статистики — без каких-либо изменений." }
};
var DEVICE_ROLE_KEYS = Object.keys(DEVICE_ROLES);
function deviceRole(id) {
  // Accounts created via the registration screen are students by default:
  // if this device is logged in with such an account and no role was assigned
  // explicitly yet, treat it as «Ученик».
  var session = currentAuthSession();
  if (id === deviceId && session && session.accountId && !session.roleExplicit) {
    var entry0 = (state.deviceMeta || {})[id];
    if (!entry0 || !entry0.roleExplicit) return "student";
  }
  var entry = (state.deviceMeta || {})[id];
  return entry && DEVICE_ROLE_KEYS.indexOf(entry.role) !== -1 ? entry.role : "teacher";
}
// Tech-admin add-on: true if this device was granted it via the settings password.
function deviceTechAdmin(id) {
  var entry = (state.deviceMeta || {})[id];
  return Boolean(entry && entry.techAdmin);
}
function setDeviceTechAdmin(id, enabled) {
  var meta = state.deviceMeta || (state.deviceMeta = {});
  var entry = meta[id] || (meta[id] = { seenAt: 0 });
  if (Boolean(entry.techAdmin) === Boolean(enabled)) return false;
  if (id !== deviceId && !(effectivePermissions().canManageDevices && syncWritable())) { showToast("Выдать статус «Тех. администрация» другому устройству может учитель/тех. админ с токеном", "warning"); return false; }
  entry.techAdmin = Boolean(enabled);
  if (id === deviceId) { var sessT = currentAuthSession(); if (sessT) { sessT.roleExplicit = true; saveAuthSession(sessT); } } // tech-admin add-on also confirms the role explicitly
  entry.updatedAt = nextTimestamp();
  saveLocal(); scheduleSync(); renderDeviceList(); applyRoleRestrictions();
  showToast((enabled ? "Статус «Тех. администрация» выдан устройству " : "Статус «Тех. администрация» снят с устройства ") + (entry.name || id.slice(0, 4)), enabled ? "success" : "info");
  return true;
}
function setDeviceRole(id, role) {
  if (DEVICE_ROLE_KEYS.indexOf(role) === -1) return false;
  if (id !== deviceId && !(effectivePermissions().canManageDevices && syncWritable())) { showToast("Смена ролей других устройств требует прав учителя/тех. админа и токен для отправки", "warning"); return false; }
  var meta = state.deviceMeta || (state.deviceMeta = {});
  var entry = meta[id] || (meta[id] = { seenAt: 0 });
  entry.role = role;
  entry.roleExplicit = true; // manual assignment overrides the "registered account → student" default
  entry.updatedAt = nextTimestamp();
  entry.seenAt = Math.max(entry.seenAt || 0, id === deviceId ? Date.now() : 0);
  saveLocal(); scheduleSync(); renderDeviceList(); applyRoleRestrictions();
  showToast("Роль «" + DEVICE_ROLES[role].label + "» назначена устройству " + (entry.name || id.slice(0, 4)), "success");
  return true;
}
// Effective permissions for the current device. The tech-admin add-on overrides
// every restriction: full access to all functions regardless of the base role.
function effectivePermissions() {
  var role = deviceRole(deviceId);
  var techAdmin = deviceTechAdmin(deviceId) || state.devUnlocked; // dev-unlocked implies tech admin on this device
  return {
    role: role,
    techAdmin: techAdmin,
    canEditJournal: techAdmin || role === "teacher",   // attendance marks, students, classes, lessons
    canManageHomework: techAdmin || role === "teacher", // add/delete homework
    canViewStats: true,                                 // everyone can view reports/statistics
    canManageDevices: techAdmin || role === "teacher"   // rename devices, assign roles
  };
}
// Enforce the current device's role on the interface: read-only roles lock all
// mutating controls. The tech-admin add-on lifts every lock immediately.
function applyRoleRestrictions() {
  var perms = effectivePermissions();
  var readOnly = !perms.canEditJournal; // student & observer (without add-on) are read-only
  document.body.classList.toggle("role-readonly", readOnly);
  document.body.setAttribute("data-role", perms.role);
  document.body.toggleAttribute("data-tech-admin", perms.techAdmin);
  var banner = dom.roleBanner;
  if (banner) {
    if (readOnly) {
      banner.hidden = false;
      banner.textContent = perms.role === "student"
        ? "Режим «Ученик»: только домашние задания и своя посещаемость"
        : "Режим «Наблюдатель»: полный обзор без права редактирования";
    } else if (perms.techAdmin && perms.role !== "teacher") {
      banner.hidden = false;
      banner.textContent = "Тех. администрация: доступ ко всем функциям (роль — «" + DEVICE_ROLES[perms.role].label + "»)";
    } else banner.hidden = true;
  }
  // Disable every control that writes data when this device is read-only.
  var selector = "#addStudentButton, #studentName, #toggleStudentEntryButton, #hwAddButton, #hwPinButton, #hwClearButton, #hwText, #createLessonButton, #lessonCreate, #addClassButton, #addSubjectButton, [data-action='lesson-edit'], [data-action='rename'], [data-action='remove'], .lesson-roster-row select, .icon-button.hw-delete, #studentCardRename, #studentCardDelete, #studentClassMove, #exportBackupButton, #importBackupButton, #restoreBackupButton";
  Array.prototype.forEach.call(document.querySelectorAll(selector), function (el) { el.disabled = readOnly; });
  Array.prototype.forEach.call(document.querySelectorAll(".device-input, .device-role"), function (el) {
    if (el.dataset.deviceId === deviceId && perms.canManageDevices) return; // own row stays editable for those who manage devices
    el.disabled = !perms.canManageDevices || el.dataset.deviceId !== deviceId ? (!perms.canManageDevices || !syncWritable()) : false;
  });
  Array.prototype.forEach.call(document.querySelectorAll(".device-tech-flag"), function (el) {
    el.disabled = el.dataset.deviceId !== deviceId && !(perms.canManageDevices && syncWritable());
  });
  // User list in settings: deleting accounts follows the device-management rights.
  Array.prototype.forEach.call(document.querySelectorAll(".user-remove"), function (el) {
    el.disabled = !perms.canManageDevices;
  });
}
function newer(a, b) {
  if (!a) return b; if (!b) return a;
  var ca = cleanClock(a.clock, a.updatedAt), cb = cleanClock(b.clock, b.updatedAt);
  if (isDataEqual(recordValue(a), recordValue(b))) { var same = (a.updatedAt || 0) > (b.updatedAt || 0) ? a : (a.updatedAt || 0) < (b.updatedAt || 0) ? b : canonical(a) >= canonical(b) ? a : b; return Object.assign({}, same, { clock: unionClocks(ca, cb) }); }
  if (clockDominates(ca, cb)) return a; if (clockDominates(cb, ca)) return b;
  var difference = (a.updatedAt || 0) - (b.updatedAt || 0);
  if (difference) return difference > 0 ? a : b;
  var actorA = String(a.actor || ""), actorB = String(b.actor || "");
  if (actorA !== actorB) return actorA > actorB ? a : b;
  return canonical(a) >= canonical(b) ? a : b;
}
function mergeStudents(local, remote) {
  var byId = Object.create(null); (local || []).concat(remote || []).forEach(function (s) { if (s && validId(s.id)) byId[s.id] = newer(byId[s.id], s); });
  return Object.keys(byId).sort().map(function (id) { return copy(byId[id]); });
}
function mergeAttendance(local, remote) {
  var result = {}; local = local || {}; remote = remote || {};
  new Set(Object.keys(local).concat(Object.keys(remote))).forEach(function (key) { var value = newer(normalizeStatusEntry(local[key]), normalizeStatusEntry(remote[key])); if (value) result[key] = copy(value); }); return result;
}
function mergeSettings(local, remote) {
  var l = cloneSettings(local), r = cloneSettings(remote), result = defaultSettings();
  settingFields.forEach(function (field) {
    var left = Object.assign({ value: l[field] }, l.fieldMeta[field]), right = Object.assign({ value: r[field] }, r.fieldMeta[field]), chosen = newer(left, right);
    result[field] = chosen.value; result.fieldMeta[field] = { updatedAt: chosen.updatedAt, actor: chosen.actor, clock: chosen.clock }; result.updatedAt = Math.max(result.updatedAt, chosen.updatedAt);
  }); return result;
}
function mergeData(local, remote) { return { version: 5, students: mergeStudents(local.students, remote.students), attendance: mergeAttendance(local.attendance, remote.attendance), settings: mergeSettings(local.settings, remote.settings) }; }
function buildPayload() { return copy({ version: 5, students: state.students, attendance: state.attendance, settings: state.settings }); }
function applyMergedToState(data) { state.students = copy(data.students); state.attendance = copy(data.attendance); state.settings = cloneSettings(data.settings); if (Array.isArray(data.homework)) state.homework = data.homework.map(function (v) { return Object.assign({}, v); }); }
function markChanged() { state.revision++; syncRuntime.hasPendingChanges = true; }
// Coalesce rapid localStorage writes (e.g. tapping several cells quickly).
// The leading-edge timer fires within 150ms so data is never at risk for long,
// and beforeunload flushes anything pending synchronously.
var saveLocalTimer = null;
function scheduleSaveLocal() {
  if (saveLocalTimer) return;
  // 600 ms instead of 150: saving serializes the WHOLE journal (JSON.stringify)
  // and re-reads it from localStorage on every call. Tapping cells in quick
  // succession used to fire this cycle many times per second — the main cause
  // of input lag on phones. Data is still flushed synchronously when the tab
  // is hidden or closed, so nothing is lost.
  saveLocalTimer = setTimeout(function () { saveLocalTimer = null; saveLocal(); }, 600);
}
function flushSaveLocal() { if (saveLocalTimer) { clearTimeout(saveLocalTimer); saveLocalTimer = null; saveLocal(); } }
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flushSaveLocal(); });
  window.addEventListener("pagehide", flushSaveLocal);
}
function updateLocalStatus(text, failed) { if (dom.localSaveStatus) { dom.localSaveStatus.textContent = text; dom.localSaveStatus.classList.toggle("save-error", !!failed); } }
var lastLocalRaw;
function saveLocal(replace) {
  if (!storage) { updateLocalStatus("Только в этой вкладке", true); showToast("Браузер не сохраняет журнал. Скачайте резервную копию перед закрытием.", "warning"); return false; }
  try {
    var raw = storage.getItem(STORAGE_KEY);
    if (raw && raw !== lastLocalRaw) {
      var parsed = JSON.parse(raw); mergeOffline(parsed._offline, replace);
      if (!replace) { var disk = migrateData(parsed, true); reconcileLocalConflicts(disk); applyMergedToState(mergeData(buildPayload(), disk)); }
    }
    var payload = buildPayload(); payload._offline = copy(offline); payload.pendingChanges = syncRuntime.hasPendingChanges; payload.updatedAt = Date.now();
    var serialized = JSON.stringify(payload); storage.setItem(STORAGE_KEY, serialized); lastLocalRaw = serialized; updateLocalStatus("Сохранено на устройстве", false); return true;
  } catch (e) { console.error(e); updateLocalStatus("Не удалось сохранить", true); showToast("Не удалось сохранить журнал: " + e.message + ". Скачайте резервную копию.", "error"); return false; }
}
function loadLocal() {
  if (!storage) return false;
  try { var raw = storage.getItem(STORAGE_KEY); if (!raw || raw === lastLocalRaw) return true; var parsed = JSON.parse(raw); mergeOffline(parsed._offline); var disk = migrateData(parsed, true); migrateLegacyQueue(parsed,disk); reconcileLocalConflicts(disk); applyMergedToState(mergeData(buildPayload(), disk)); if (parsed.pendingChanges) syncRuntime.hasPendingChanges = true; lastLocalRaw = raw; return true; }
  catch (e) { updateLocalStatus("Ошибка чтения сохранения", true); showToast("Сохранённый журнал повреждён. Восстановите резервную копию.", "error"); return false; }
}
function saveRecoveryBackup() {
  if (!storage) throw new Error("Нет доступа к хранилищу резервных копий");
  var entries = [], raw = storage.getItem(BACKUP_KEY); if (raw) { try { entries = JSON.parse(raw); if (!Array.isArray(entries)) entries = []; } catch (e) { entries = []; } }
  entries.unshift({ savedAt: Date.now(), data: buildPayload() }); storage.setItem(BACKUP_KEY, JSON.stringify(entries.slice(0, 3))); return true;
}
function showToast(msg, type) { dom.toast.textContent = msg; dom.toast.className = "toast show " + (type || ""); clearTimeout(showToast.timer); showToast.timer = setTimeout(function () { dom.toast.className = "toast"; }, 4500); }

/* ---------- Authentication gate (register / login with 2FA) ---------- */
// On the very first opening of a device the journal is locked behind a full
// screen requiring registration (first name, last name, password) or login.
// Login additionally requires two-factor confirmation: either an SMS-style
// code sent to the registered phone number or a secret word (second password).
// Accounts are stored locally on the device with PBKDF2-hashed passwords via
// WebCrypto (SHA-256, 150k iterations, per-account random salt). Without a
// real SMS provider the 6-digit code is generated locally and shown as a
// demo hint — the verification flow itself is fully enforced.
var authGateState = { pending: null, smsCode: "", smsExpiresAt: 0 };

function authNormalizeName(value) { return String(value || "").trim().replace(/\s+/g, " ").toLowerCase(); }
function loadAuthAccounts() {
  try { var raw = storage && storage.getItem(AUTH_ACCOUNTS_KEY); var list = raw ? JSON.parse(raw) : []; return Array.isArray(list) ? list : []; }
  catch (error) { return []; }
}
function saveAuthAccounts(list) {
  if (!storage) throw new Error("Хранилище недоступно — не удалось сохранить аккаунт");
  storage.setItem(AUTH_ACCOUNTS_KEY, JSON.stringify(list));
}
/* ---------- Account sync between devices ---------- */
// The account list (logins + PBKDF2 password hashes) now travels with the
// regular Gist synchronization: every device keeps its own "accounts.device.
// <id>.json" file inside the same Gist as the journal files, and the lists
// are merged by lastKnownAt timestamps (a newer value always wins; equal
// values merge their deletion tombstones). Passwords never leave the device
// in clear text — only salted PBKDF2 hashes are uploaded, so a login works on
// any connected device without transmitting the secret itself. Deletions are
// remembered via tombstones so a removed account does not resurrect from an
// older copy sitting in another device's file.
function cleanSyncAccount(account) {
  if (!account || typeof account !== "object") return null;
  var fullName = String(account.fullName || "").trim().slice(0, 140);
  if (!fullName) return null;
  var id = validId(account.id) ? account.id : generateId();
  var hash = typeof account.hash === "string" ? account.hash.slice(0, 200) : "";
  var salt = typeof account.salt === "string" ? account.salt.slice(0, 64) : "";
  var result = {
    id: id,
    fullName: fullName,
    firstName: String(account.firstName || "").trim().slice(0, 60),
    lastName: String(account.lastName || "").trim().slice(0, 60),
    hash: hash, salt: salt,
    createdAt: Number(account.createdAt) || Date.now(),
    lastKnownAt: Number(account.lastKnownAt) || Number(account.createdAt) || 0,
    updatedAt: Number(account.updatedAt) || Number(account.lastKnownAt) || 0,
    deleted: account.deleted === true
  };
  // Phone / secret word support the 2FA step of the login flow; keep them
  // only when present so old local accounts stay byte-compatible. The local
  // login flow stores the enrolled secret under "secretHash", but the sync
  // layer historically read/wrote "secretWordHash": a hash saved under one
  // name and verified under another never matched, so logging in with the
  // secret-word second factor on ANOTHER device always failed ("Неверное
  // секретное слово") even with the correct password. Accept both spellings
  // on the way in and publish both on the way out for compatibility.
  if (typeof account.phone === "string" && account.phone.trim()) result.phone = account.phone.trim().slice(0, 30);
  var syncedSecret = "";
  if (typeof account.secretHash === "string" && account.secretHash) syncedSecret = account.secretHash;
  else if (typeof account.secretWordHash === "string" && account.secretWordHash) syncedSecret = account.secretWordHash;
  if (syncedSecret) { result.secretHash = syncedSecret.slice(0, 200); result.secretWordHash = result.secretHash; }
  return result;
}
function normalizeSyncAccounts(raw) {
  var source = raw && typeof raw === "object" && Array.isArray(raw.accounts) ? raw.accounts : (Array.isArray(raw) ? raw : []);
  var byName = Object.create(null);
  source.forEach(function (item) {
    var account = cleanSyncAccount(item);
    if (!account) return;
    var key = authNormalizeName(account.fullName);
    var previous = byName[key];
    if (!previous) { byName[key] = account; return; }
    // Same person on two devices: the fresher record wins, but a deletion
    // flag survives unless the winning side explicitly re-created it later.
    var winner = (account.lastKnownAt || 0) >= (previous.lastKnownAt || 0) ? account : previous;
    var loser = winner === account ? previous : account;
    if (loser.deleted && !(winner.deleted) && (loser.lastKnownAt || 0) > (winner.updatedAt || 0)) winner.deleted = true;
    byName[key] = winner;
  });
  return Object.keys(byName).sort().map(function (key) { return byName[key]; });
}
function loadAccountTombstones() {
  try { var raw = storage && storage.getItem(AUTH_TOMBSTONES_KEY); var list = raw ? JSON.parse(raw) : []; return Array.isArray(list) ? list : []; }
  catch (error) { return []; }
}
function saveAccountTombstones(list) {
  if (!storage) return;
  // Keep the file small: only recent tombstones are relevant for merging.
  var cutoff = Date.now() - TOMBSTONE_RETENTION_MS;
  var pruned = list.filter(function (t) { return t && t.fullName && Number(t.deletedAt) > cutoff; }).slice(-200);
  try { storage.setItem(AUTH_TOMBSTONES_KEY, JSON.stringify(pruned)); } catch (error) {}
}
function rememberAccountDeletion(account) {
  if (!account || !account.fullName) return;
  var list = loadAccountTombstones();
  var key = authNormalizeName(account.fullName);
  var entry = { fullName: String(account.fullName).trim().slice(0, 140), deletedAt: Date.now(), id: validId(account.id) ? account.id : "" };
  for (var i = 0; i < list.length; i++) {
    if (list[i] && authNormalizeName(list[i].fullName) === key) { list[i] = entry; saveAccountTombstones(list); return; }
  }
  list.push(entry);
  saveAccountTombstones(list);
}
function loadLocalSyncAccounts() {
  var items = loadAuthAccounts().map(function (account) {
    var item = cleanSyncAccount(account) || account;
    if (!item.lastKnownAt) item.lastKnownAt = item.createdAt || 0;
    if (!item.updatedAt) item.updatedAt = item.lastKnownAt;
    return item;
  });
  // Deleted accounts travel as tombstones so other devices remove them too.
  loadAccountTombstones().forEach(function (tombstone) {
    if (!tombstone || !tombstone.fullName) return;
    var alive = items.some(function (item) { return authNormalizeName(item.fullName) === authNormalizeName(tombstone.fullName); });
    if (alive) return;
    var stamped = Number(tombstone.deletedAt) || Date.now();
    items.push({ id: validId(tombstone.id) ? tombstone.id : generateId(), fullName: String(tombstone.fullName).trim().slice(0, 140), firstName: "", lastName: "", hash: "", salt: "", createdAt: stamped, lastKnownAt: stamped, updatedAt: stamped, deleted: true });
  });
  return normalizeSyncAccounts(items);
}
function mergeSyncAccountLists(localList, remoteList) {
  var byName = Object.create(null);
  [].concat(localList || [], remoteList || []).forEach(function (account) {
    var item = cleanSyncAccount(account);
    if (!item) return;
    var key = authNormalizeName(item.fullName);
    var previous = byName[key];
    if (!previous) { byName[key] = item; return; }
    var winner = (item.lastKnownAt || 0) >= (previous.lastKnownAt || 0) ? item : previous;
    var loser = winner === item ? previous : item;
    // Tombstone propagation: an account deleted elsewhere stays deleted even
    // if our copy still shows it as alive (deletion is the newest update).
    if (loser.deleted && !winner.deleted && (loser.lastKnownAt || 0) > (winner.updatedAt || 0)) winner.deleted = true;
    byName[key] = winner;
  });
  return Object.keys(byName).sort().map(function (key) { return byName[key]; });
}
// Write the merged list back into this device's local storage. Accounts that
// exist locally keep their records untouched (they may carry extra fields);
// genuinely new accounts become loggable here, deleted ones disappear.
function applySyncedAccounts(mergedList) {
  var local = loadAuthAccounts();
  var byName = Object.create(null);
  local.forEach(function (account) { byName[authNormalizeName(account.fullName)] = account; });
  var added = 0, removed = 0;
  (mergedList || []).forEach(function (synced) {
    var key = authNormalizeName(synced.fullName);
    if (synced.deleted) {
      if (byName[key]) { removed++; delete byName[key]; }
      return;
    }
    if (!byName[key]) {
      var fresh = cleanSyncAccount(synced);
      if (!fresh) return;
      byName[key] = { id: fresh.id, fullName: fresh.fullName, firstName: fresh.firstName, lastName: fresh.lastName, salt: fresh.salt, hash: fresh.hash, createdAt: fresh.createdAt };
      if (fresh.phone) byName[key].phone = fresh.phone;
      // The login flow verifies the secret word via account.secretHash; store
      // the synced hash under that name (secretWordHash kept as a mirror for
      // older builds reading this device's file).
      if (fresh.secretHash || fresh.secretWordHash) byName[key].secretHash = fresh.secretHash || fresh.secretWordHash;
      added++;
    }
  });
  var next = Object.keys(byName).map(function (key) { return byName[key]; });
  if (added || removed) {
    try { saveAuthAccounts(next); } catch (error) { return { added: 0, removed: 0, error: error.message }; }
  }
  return { added: added, removed: removed };
}
async function fetchGistFiles(config) {
  var headers = githubHeaders(config);
  var response = await syncFetch("https://api.github.com/gists/" + encodeURIComponent(config.gistId), { method: "GET", headers: headers }, config);
  if (!response.ok) throw syncHTTPError(response);
  var gist = await response.json();
  syncCheckGeneration(config);
  if (!gist || typeof gist !== "object" || !gist.files || typeof gist.files !== "object" || Array.isArray(gist.files)) throw new Error("Некорректная структура ответа Gist");
  if (gist.truncated) throw new Error("Gist содержит слишком много файлов: GitHub вернул неполный список.");
  return gist.files;
}
async function fetchAccountsFromGist(config) {
  var names = [];
  if (!config.token) {
    // Read-only path: anonymous API calls are blocked by CORS, so scrape the
    // public Gist page like the journal reader does.
    var anonFiles = await fetchPublicGistFiles(config, { filePattern: /^accounts\.device\.[a-zA-Z0-9_.-]+\.json$/ });
    names = Object.keys(anonFiles).filter(function (name) { return /^accounts\.device\.[a-zA-Z0-9_.-]+\.json$/.test(name); }).sort();
    if (!names.length) {
      // The embed page only links the first files of a Gist, so account lists
      // can be missing from the enumeration. Probe known device ids directly;
      // never fail the whole sync because of auxiliary files.
      try {
        var journalFiles = await fetchPublicGistFiles(config, { filePattern: new RegExp("^(" + GIST_FILENAME + "|attendance\\.device\\.[a-zA-Z0-9_.-]+\\.json)$") });
        var fallbackFiles = await fetchPublicAccountFilesFallback(config, config.gistId, Object.keys(journalFiles));
        names = Object.keys(fallbackFiles).sort();
        anonFiles = fallbackFiles;
      } catch (error) { if (error.stale) throw error; names = []; }
    }
    var anonResult = [];
    for (var i = 0; i < names.length; i++) {
      var parsedAnon = null;
      try { parsedAnon = JSON.parse(String(anonFiles[names[i]].content || "")); } catch (error) { continue; }
      anonResult.push(parsedAnon);
    }
    return anonResult;
  }
  var files = await fetchGistFiles(config);
  names = Object.keys(files).filter(function (name) { return /^accounts\.device\.[a-zA-Z0-9_.-]+\.json$/.test(name); }).sort();
  var sources = [];
  for (var index = 0; index < names.length; index++) {
    var name = names[index], file = files[name];
    var text = file.content;
    if (file.truncated) {
      var rawUrl;
      try { rawUrl = new URL(file.raw_url); } catch (error) { continue; }
      if (rawUrl.protocol !== "https:" || rawUrl.hostname !== "gist.githubusercontent.com" || rawUrl.username || rawUrl.password) continue;
      var raw = await syncFetch(rawUrl.href, { method: "GET", redirect: "error" }, config);
      if (!raw.ok) throw syncHTTPError(raw);
      text = await raw.text();
      syncCheckGeneration(config);
    }
    if (typeof text !== "string" || !text.trim()) continue;
    var parsed;
    try { parsed = JSON.parse(text); } catch (error) { continue; }
    sources.push(parsed);
  }
  return sources;
}
function accountsFilename() {
  var writer = String(deviceId || getDeviceId()).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!(navigator.locks && typeof navigator.locks.request === "function")) writer += ".tab." + syncRuntime.tabWriterId;
  return "accounts.device." + writer + ".json";
}
async function pushAccountsToGist(accounts, config) {
  if (!config.token) throw new Error("Нет токена GitHub: аккаунты можно только загружать из публичного Gist.");
  var content = JSON.stringify({ version: 1, updatedAt: Date.now(), deviceId: deviceId, accounts: accounts });
  if (new TextEncoder().encode(content).byteLength > 8 * 1024 * 1024) throw new Error("Список аккаунтов превышает безопасный предел файла Gist.");
  var files = {}; files[accountsFilename()] = { content: content };
  var response = await syncFetch("https://api.github.com/gists/" + encodeURIComponent(config.gistId), {
    method: "PATCH", headers: Object.assign({ "Content-Type": "application/json" }, githubHeaders(config)), body: JSON.stringify({ files: files })
  }, config);
  if (!response.ok) throw syncHTTPError(response);
  syncCheckGeneration(config);
}
// Full round trip: upload this device's accounts, download every device file
// from the same Gist, merge by timestamps and write the result locally.
async function syncAccountsOnce(options) {
  options = options || {};
  var config;
  if (options.token !== undefined || options.gistId !== undefined) {
    // Explicit token/gist (e.g. typed into the login-menu sync window before
    // the settings were saved) override the stored connection for this run.
    config = syncOperationConfig(
      options.token !== undefined ? options.token : syncConfig.token,
      options.gistId !== undefined ? options.gistId : syncConfig.gistId
    );
  } else {
    config = syncOperationConfig();
    if (!syncConfigured()) { var missing = new Error("Синхронизация не подключена"); missing.noUpload = true; throw missing; }
  }
  var mergedList = null, uploaded = false, uploadError = null;
  if (config.token && !options.pullOnly) {
    try { await pushAccountsToGist(loadLocalSyncAccounts(), config); uploaded = true; }
    catch (error) { if (error.stale) throw error; uploadError = error; }
  }
  var sources = await fetchAccountsFromGist(config);
  syncCheckGeneration(config);
  mergedList = sources.reduce(function (acc, raw) { return mergeSyncAccountLists(acc, normalizeSyncAccounts(raw)); }, loadLocalSyncAccounts());
  var applied = applySyncedAccounts(mergedList);
  // Push the merged view so other devices immediately see accounts that only
  // existed locally (e.g. registered right after the last sync).
  if (uploaded && config.token) {
    try { await pushAccountsToGist(mergedList, config); } catch (error) { if (error.stale) throw error; }
  }
  if (uploadError) throw uploadError;
  return { added: applied.added, removed: applied.removed, uploaded: uploaded, total: mergedList.filter(function (a) { return !a.deleted; }).length };
}
// Fire-and-forget helper used by the journal sync cycle and account edits.
function scheduleAccountSync(reason) {
  if (!syncConfigured() || accountSyncRuntime.isRunning) return;
  if (reason === "auto" && !syncAutomatic()) return;
  accountSyncRuntime.isRunning = true;
  var config = syncOperationConfig();
  syncAccountsOnce().then(function (result) {
    if (config.generation === syncRuntime.generation) accountSyncRuntime.lastRun = Date.now();
    var announced = Boolean((result.added || result.removed) && reason !== "silent");
    if (announced) showToast("Аккаунты синхронизированы: новых " + result.added + ", удалённых " + result.removed + ".", "success");
  }).catch(function (error) {
    if (error.stale || reason === "silent" || reason === "auto") return;
    showToast("Не удалось синхронизировать аккаунты: " + (error.message || "ошибка"), "warning");
  }).finally(function () { accountSyncRuntime.isRunning = false; });
}
var accountSyncRuntime = { isRunning: false, lastRun: 0 };
function currentAuthSession() {
  try { var raw = storage && storage.getItem(AUTH_SESSION_KEY); var s = raw ? JSON.parse(raw) : null; return s && typeof s.fullName === "string" ? s : null; }
  catch (error) { return null; }
}
function saveAuthSession(session) { try { if (storage) storage.setItem(AUTH_SESSION_KEY, JSON.stringify(session)); } catch (error) {} }
function clearAuthSession() { try { if (storage) storage.removeItem(AUTH_SESSION_KEY); } catch (error) {} }
function isDeviceAuthenticated() { return Boolean(currentAuthSession()); }
function authRandomHex(bytes) {
  var arr = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(arr);
  else for (var i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.prototype.map.call(arr, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}
function authToHex(buffer) {
  return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}
function authDerive(password, saltHex) {
  // PBKDF2-SHA256 when WebCrypto is available; deterministic fallback keeps
  // the app usable in rare contexts without crypto.subtle (e.g. file:// in
  // some browsers). The fallback is clearly marked so it can be upgraded.
  var salt = [];
  for (var i = 0; i < saltHex.length; i += 2) salt.push(parseInt(saltHex.substr(i, 2), 16));
  if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
    var enc = new TextEncoder();
    return crypto.subtle.importKey("raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"])
      .then(function (key) { return crypto.subtle.deriveBits({ name: "PBKDF2", salt: new Uint8Array(salt), iterations: 150000, hash: "SHA-256" }, key, 256); })
      .then(function (bits) { return "pbkdf2$" + authToHex(bits); });
  }
  return Promise.resolve("simple$" + authSimpleHash(String(password) + "$" + saltHex));
}
function authSimpleHash(text) {
  // FNV-1a chained rounds — only used when WebCrypto is unavailable.
  var h1 = 0x811c9dc5, h2 = 0x01000193;
  for (var round = 0; round < 2000; round++) {
    for (var i = 0; i < text.length; i++) {
      h1 ^= text.charCodeAt(i) + round; h1 = Math.imul(h1, 0x01000193);
      h2 = Math.imul(h2 ^ (text.charCodeAt(i) ^ round), 0x85ebca6b);
    }
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}
function authGenerateSmsCode() {
  var n = 0;
  if (typeof crypto !== "undefined" && crypto.getRandomValues) { var a = new Uint32Array(1); crypto.getRandomValues(a); n = a[0]; }
  else n = Math.floor(Math.random() * 0xffffffff);
  return String(100000 + (n % 900000));
}
function wireAuthGate() {
  var d = dom;
  if (!d.authGate) return;
  d.authTabRegister.addEventListener("click", function () { switchAuthTab("register"); });
  d.authTabLogin.addEventListener("click", function () { switchAuthTab("login"); });
  d.authRegisterForm.addEventListener("submit", function (event) { event.preventDefault(); handleAuthRegister(); });
  d.authLoginForm.addEventListener("submit", function (event) { event.preventDefault(); handleAuthLogin(event); });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="auth2faMethod"]'), function (radio) {
    radio.addEventListener("change", updateAuth2faStep);
  });
  [d.authRegFirst, d.authRegLast, d.authRegPass1, d.authRegPass2].forEach(function (el) { el.addEventListener("input", function () { d.authRegisterError.textContent = ""; }); });
  [d.authLoginName, d.authLoginPass, d.authPhone, d.authSmsCode, d.authSecretWord].forEach(function (el) { el.addEventListener("input", function () { d.authLoginError.textContent = ""; }); });
  wireAuthSyncWindow();
}
// ---------- Sync window inside the login menu ----------
// The auth gate carries its own compact synchronization dialog so a brand-new
// device can attach to the same Gist before the first login. It reuses the
// regular sync engine (fetchFromGist / saveSyncConfig / fullSync): "Проверить
// связь" validates the connection without saving it, "Сохранить подключение"
// persists the settings and immediately pulls the journal from the cloud.
function wireAuthSyncWindow() {
  var d = dom;
  if (!d.authSyncOpenButton || !d.authSyncPanel) return;
  d.authSyncOpenButton.addEventListener("click", openAuthSyncWindow);
  d.authSyncCloseButton.addEventListener("click", closeAuthSyncWindow);
  d.authSyncPublic.addEventListener("change", function () { d.authSyncWarning.hidden = !d.authSyncPublic.checked; });
  [d.authSyncToken, d.authSyncGist].forEach(function (el) { el.addEventListener("input", function () { d.authSyncError.textContent = ""; }); });
  d.authSyncTestButton.addEventListener("click", handleAuthSyncTest);
  d.authSyncSaveButton.addEventListener("click", handleAuthSyncSave);
}
function authSyncInputConfig() {
  var token = dom.authSyncToken.value.trim(), gistId = extractGistId(dom.authSyncGist.value);
  if (!/^[a-f0-9]{5,64}$/i.test(gistId) || /[\r\n]/.test(token)) throw new Error("Введите правильный ID Gist (ссылку на публичный Gist тоже можно вставить целиком).");
  return syncOperationConfig(token, gistId);
}
function setAuthSyncBusy(busy) {
  dom.authSyncTestButton.disabled = busy; dom.authSyncSaveButton.disabled = busy;
  dom.authSyncSaveButton.textContent = busy ? "Подключаем…" : "Сохранить подключение";
}
async function handleAuthSyncTest() {
  dom.authSyncError.textContent = ""; dom.authSyncStatus.textContent = "";
  var proposed;
  try { proposed = authSyncInputConfig(); } catch (error) { dom.authSyncError.textContent = error.message; return; }
  setAuthSyncBusy(true);
  try {
    var result = await fetchFromGist(proposed, { unconditional: true, noCache: true });
    syncCheckGeneration(proposed);
    dom.authSyncStatus.textContent = "Связь установлена. " + (result.gistPublic ? "Gist публичный" : "Gist непубличный") + ", формат журнала проверен." + (proposed.token ? "" : " Доступ только для чтения.");
  } catch (error) { if (!error.stale) dom.authSyncError.textContent = error.message || "Не удалось связаться с Gist."; }
  finally { setAuthSyncBusy(false); }
}
async function handleAuthSyncSave() {
  dom.authSyncError.textContent = ""; dom.authSyncStatus.textContent = "";
  var proposed;
  try { proposed = authSyncInputConfig(); } catch (error) { dom.authSyncError.textContent = error.message; return; }
  if (!proposed.token && !dom.authSyncPublic.checked) {
    dom.authSyncError.textContent = "Для работы без токена Gist должен быть публичным: отметьте «Публичный Gist». Для отправки изменений в непубличный Gist укажите токен.";
    return;
  }
  setAuthSyncBusy(true);
  try {
    var result = await fetchFromGist(proposed, { unconditional: true, noCache: true });
    syncCheckGeneration(proposed);
    syncInvalidate();
    syncConfig.token = proposed.token; syncConfig.gistId = proposed.gistId; syncConfig.enabled = true;
    syncConfig.isPublicGist = Boolean(result.gistPublic);
    syncConfig.lastSync = 0; syncConfig.lastSyncStatus = "off"; syncConfig.lastError = "";
    syncRuntime.hasPendingChanges = true;
    saveSyncConfig(); updateSyncUI();
    startPolling();
    // Pull the journal right away so a fresh device already shows the data
    // while the user is still on the login screen.
    try { await fullSync("manual"); } catch (error) {}
    // ...and pull the account lists from the other devices too, so an account
    // registered on the first device can log in here immediately. Run with
    // the values from this window (they may differ from anything saved
    // before) and ignore failures — the regular sync cycles retry silently.
    var accountsPulled = 0;
    try {
      var accountResult = await syncAccountsOnce({ token: proposed.token, gistId: proposed.gistId, pullOnly: !proposed.token });
      accountsPulled = accountResult.added || 0;
    } catch (error) {}
    dom.authSyncStatus.textContent = "Подключение сохранено. Журнал и " + accountsPulled + " аккаунт(ов) загружены с другого устройства — войдите, чтобы продолжить.";
    if (accountsPulled) switchAuthTab("login");
    showToast("Синхронизация подключена из окна входа.", "success");
  } catch (error) { if (!error.stale) dom.authSyncError.textContent = error.message || "Не удалось сохранить подключение."; }
  finally { setAuthSyncBusy(false); }
}
function openAuthSyncWindow() {
  dom.authSyncPanel.hidden = false;
  dom.authSyncOpenButton.hidden = true;
  dom.authSyncError.textContent = ""; dom.authSyncStatus.textContent = "";
  dom.authSyncToken.value = syncConfig.token; dom.authSyncGist.value = syncConfig.gistId;
  dom.authSyncPublic.checked = Boolean(syncConfig.isPublicGist);
  dom.authSyncWarning.hidden = !dom.authSyncPublic.checked;
  (syncConfig.gistId ? dom.authSyncToken : dom.authSyncGist).focus();
}
function closeAuthSyncWindow() {
  dom.authSyncPanel.hidden = true;
  dom.authSyncOpenButton.hidden = false;
  dom.authSyncOpenButton.focus();
}
function switchAuthTab(tab) {
  var register = tab === "register";
  dom.authTabRegister.classList.toggle("is-active", register);
  dom.authTabLogin.classList.toggle("is-active", !register);
  dom.authTabRegister.setAttribute("aria-selected", String(register));
  dom.authTabLogin.setAttribute("aria-selected", String(!register));
  dom.authRegisterForm.hidden = !register;
  dom.authLoginForm.hidden = register;
  dom.authRegisterError.textContent = ""; dom.authLoginError.textContent = "";
  var first = register ? dom.authRegFirst : dom.authLoginName; if (first) first.focus();
}
function openAuthGate(preferredTab) {
  if (!dom.authGate) return;
  dom.authGate.hidden = false;
  if (dom.journalApp) dom.journalApp.inert = true;
  document.body.style.overflow = "hidden";
  dom.authFootnote.textContent = "";
  // Always start with the sync window closed; it opens only on demand.
  if (dom.authSyncPanel) { dom.authSyncPanel.hidden = true; dom.authSyncOpenButton.hidden = false; }
  switchAuthTab(preferredTab || (loadAuthAccounts().length ? "login" : "register"));
}
function closeAuthGate() {
  if (!dom.authGate) return;
  dom.authGate.hidden = true;
  if (dom.journalApp) dom.journalApp.inert = !!activeModal || shouldShowMaintenance();
  document.body.style.overflow = activeModal ? "hidden" : "";
  authGateState.pending = null; authGateState.smsCode = ""; authGateState.smsExpiresAt = 0;
}
async function handleAuthRegister() {
  var d = dom;
  var first = d.authRegFirst.value.trim(), last = d.authRegLast.value.trim();
  var pass1 = d.authRegPass1.value, pass2 = d.authRegPass2.value;
  if (!first || !last) { d.authRegisterError.textContent = "Укажите имя и фамилию."; return; }
  if (first.length > 60 || last.length > 60) { d.authRegisterError.textContent = "Имя или фамилия слишком длинные."; return; }
  if (pass1.length < 6) { d.authRegisterError.textContent = "Пароль должен быть не короче 6 символов."; return; }
  if (pass1 !== pass2) { d.authRegisterError.textContent = "Пароли не совпадают."; return; }
  var accounts = loadAuthAccounts();
  var fullName = first + " " + last;
  if (accounts.some(function (a) { return authNormalizeName(a.fullName) === authNormalizeName(fullName); })) {
    d.authRegisterError.textContent = "Аккаунт с таким именем и фамилией уже есть — войдите вместо регистрации.";
    switchAuthTab("login"); d.authLoginName.value = fullName; return;
  }
  d.authRegisterSubmit.disabled = true; d.authRegisterSubmit.textContent = "Проверяем…";
  try {
    var salt = authRandomHex(16);
    var derived = await authDerive(pass1, salt);
    accounts.push({ id: generateId(), fullName: fullName, firstName: first, lastName: last, salt: salt, hash: derived, createdAt: Date.now() });
    saveAuthAccounts(accounts);
    // Push the fresh account list to the Gist immediately (fire-and-forget):
    // other connected devices receive it on their next sync cycle.
    scheduleAccountSync("silent");
    saveAuthSession({ accountId: accounts[accounts.length - 1].id, fullName: fullName, method: "register", at: Date.now() });
    d.authRegisterForm.reset();
    closeAuthGate(); lastFlushDaysSig = null; lastHomeworkSig = null; lastAccountSig = null; render(); applyRoleRestrictions(); renderDeviceList();
    showToast("Аккаунт создан. Добро пожаловать, " + first + "! Роль по умолчанию — «Ученик».", "success");
  } catch (error) {
    d.authRegisterError.textContent = error.message || "Не удалось создать аккаунт.";
  } finally {
    d.authRegisterSubmit.disabled = false; d.authRegisterSubmit.textContent = "Зарегистрироваться";
  }
}
async function handleAuthLogin(event) {
  var d = dom;
  var name = d.authLoginName.value.trim(), pass = d.authLoginPass.value;
  if (!name || !pass) { d.authLoginError.textContent = "Введите имя с фамилией и пароль."; return; }
  var methodEl = document.querySelector('input[name="auth2faMethod"]:checked');
  var method = methodEl ? methodEl.value : "code";
  var accounts = loadAuthAccounts();
  var account = null;
  for (var i = 0; i < accounts.length; i++) { if (authNormalizeName(accounts[i].fullName) === authNormalizeName(name)) { account = accounts[i]; break; } }
  if (!account && syncConfigured()) {
    // The list on this device may simply be outdated: give the account sync
    // one immediate chance before telling the user the account is missing.
    try {
      var pullResult = await syncAccountsOnce({ pullOnly: !syncConfig.token });
      if (pullResult.added || pullResult.removed) {
        accounts = loadAuthAccounts();
        for (var k = 0; k < accounts.length; k++) { if (authNormalizeName(accounts[k].fullName) === authNormalizeName(name)) { account = accounts[k]; break; } }
      }
    } catch (error) { /* offline or bad connection — fall through to the message below */ }
  }
  if (!account) { d.authLoginError.textContent = "Аккаунт не найден на этом устройстве. Подключите синхронизацию ниже («Синхронизировать с другим устройством») или зарегистрируйтесь."; switchAuthTab("register"); d.authRegLast.value = name.split(" ").slice(1).join(" "); d.authRegFirst.value = name.split(" ")[0] || ""; return; }
  // Step 1: verify the main password.
  var resumingTwoFactor = authGateState.pending && authGateState.pending.accountId === account.id && authGateState.pending.step === "2fa";
  if (!resumingTwoFactor) {
    d.authLoginSubmit.disabled = true; d.authLoginSubmit.textContent = "Проверяем…";
    try {
      var derived = await authDerive(pass, account.salt);
      if (derived !== account.hash) { d.authLoginError.textContent = "Неверный пароль."; d.authLoginPass.value = ""; d.authLoginPass.focus(); return; }
    } catch (error) { d.authLoginError.textContent = error.message || "Ошибка проверки пароля."; return; }
    finally { d.authLoginSubmit.disabled = false; d.authLoginSubmit.textContent = "Войти"; }
    // Password OK → move to the second factor. Remember salt/hash so step 2
    // can confirm the account was not replaced by a sync in the meantime.
    authGateState.pending = { accountId: account.id, fullName: account.fullName, step: "2fa", method: null, salt: account.salt, hash: account.hash };
    if (method === "code") {
      var code = authGenerateSmsCode();
      authGateState.smsCode = code; authGateState.smsExpiresAt = Date.now() + 5 * 60 * 1000;
      d.authSmsHint.textContent = "Демо-режим без SMS-провайдера: код для телефона " + (d.authPhone.value.trim() || "не указан") + " — " + code + " (действует 5 минут).";
      d.authSmsRow.hidden = false; d.authSmsCode.value = ""; d.authSmsCode.focus();
      d.authLoginError.textContent = "Пароль принят. Подтвердите вход кодом из сообщения.";
    } else {
      d.authSecretWord.value = ""; d.authSecretWord.focus();
      d.authLoginError.textContent = "Пароль принят. Введите секретное слово.";
    }
    return;
  }
  // Second attempt while already in the 2FA step: the password was verified on
  // the first click. Re-deriving PBKDF2 (150k iterations) here would add a
  // multi-second freeze on low-end devices, so skip it — but only for the
  // exact pending account while its salt/hash are unchanged (a background
  // sync could have replaced the record in between).
  if (authGateState.pending.salt !== account.salt || authGateState.pending.hash !== account.hash) {
    authGateState.pending = null;
    d.authLoginError.textContent = "Данные аккаунта обновились. Нажмите «Войти» заново.";
    return;
  }
  // Step 2: verify the second factor.
  if (method === "code") {
    var entered = d.authSmsCode.value.trim();
    if (!/^\d{6}$/.test(entered)) { d.authLoginError.textContent = "Код состоит из 6 цифр."; return; }
    if (Date.now() > authGateState.smsExpiresAt) { d.authLoginError.textContent = "Код истёк. Нажмите «Войти» ещё раз, чтобы получить новый."; authGateState.pending = null; return; }
    if (entered !== authGateState.smsCode) { d.authLoginError.textContent = "Неверный код подтверждения."; d.authSmsCode.value = ""; return; }
  } else {
    var secret = d.authSecretWord.value;
    if (!secret) { d.authLoginError.textContent = "Введите секретное слово."; return; }
    var secretDerived = await authDerive(secret, account.salt);
    if (account.secretHash && secretDerived !== account.secretHash) { d.authLoginError.textContent = "Неверное секретное слово."; d.authSecretWord.value = ""; return; }
    if (!account.secretHash) {
      // First login with secret-word 2FA: enrol the secret now (after the main
      // password was already verified above).
      account.secretHash = secretDerived;
      var list = loadAuthAccounts();
      for (var j = 0; j < list.length; j++) { if (list[j].id === account.id) list[j] = account; }
      saveAuthAccounts(list);
    }
  }
  saveAuthSession({ accountId: account.id, fullName: account.fullName, method: method, at: Date.now() });
  authGateState.pending = null;
  // The secret word / phone entered during login belong to this account: keep
  // them locally BEFORE resetting the form and pushing the updated list, so
  // the OTHER connected devices can use the same second factor. Previously the
  // hash was saved under a field name the sync layer ignored (and the form was
  // reset first), so cross-device logins always failed or lost the phone.
  if (method === "secret" || d.authPhone.value.trim()) {
    var liveAccount = null, accountList = loadAuthAccounts();
    for (var li = 0; li < accountList.length; li++) { if (accountList[li].id === account.id) { liveAccount = accountList[li]; break; } }
    if (liveAccount) {
      var touched = false;
      if (d.authPhone.value.trim() && liveAccount.phone !== d.authPhone.value.trim()) { liveAccount.phone = d.authPhone.value.trim(); touched = true; }
      if (method === "secret" && !liveAccount.secretHash) { liveAccount.secretHash = secretDerived; touched = true; }
      if (touched) { saveAuthAccounts(accountList); scheduleAccountSync("silent"); }
    }
  }
  d.authLoginForm.reset(); updateAuth2faStep();
  closeAuthGate(); lastFlushDaysSig = null; lastHomeworkSig = null; lastAccountSig = null; render(); applyRoleRestrictions();
  showToast("С возвращением, " + account.fullName + "! Вход подтверждён.", "success");
}
function updateAuth2faStep() {
  var el = document.querySelector('input[name="auth2faMethod"]:checked');
  var method = el ? el.value : "code";
  Array.prototype.forEach.call(document.querySelectorAll(".auth-2fa-step"), function (step) {
    step.hidden = step.dataset.method !== method;
  });
  if (method !== "code") { dom.authSmsRow.hidden = true; authGateState.pending = null; }
  else if (!authGateState.pending || authGateState.pending.step !== "2fa") dom.authSmsRow.hidden = true;
}

function updateSettings(patch) {
  var time = nextTimestamp(); settingFields.forEach(function (field) { if (Object.prototype.hasOwnProperty.call(patch, field)) { state.settings[field] = patch[field]; state.settings.fieldMeta[field] = { updatedAt: time, actor: deviceId }; } });
  state.settings.updatedAt = time; markChanged(Object.keys(patch).map(function(f){return "settings/"+f;})); scheduleSaveLocal(); render(); scheduleSync();
}
function getVisibleStudents() { return state.students.filter(function (s) { return !s.deleted && (s.classId || "class-main") === (state.selectedClass || "class-main"); }).sort(function (a, b) { return a.name.localeCompare(b.name, "ru") || a.id.localeCompare(b.id); }); }
function getStudentById(id) { return state.students.find(function (s) { return s.id === id; }) || null; }
function getFilteredStudents() { var q = state.searchQuery.trim().toLocaleLowerCase("ru"); return getVisibleStudents().filter(function (s) { return !q || s.name.toLocaleLowerCase("ru").includes(q); }); }
var studentAddMode = "new"; // "new" | "registered"
function setStudentAddMode(mode) {
  studentAddMode = mode === "registered" ? "registered" : "new";
  var btnNew = document.getElementById("studentModeNew"), btnReg = document.getElementById("studentModeRegistered");
  var wrapNew = document.getElementById("studentAddNewWrap"), wrapReg = document.getElementById("studentAddRegisteredWrap");
  if (btnNew) { btnNew.classList.toggle("is-active", studentAddMode === "new"); btnNew.setAttribute("aria-pressed", String(studentAddMode === "new")); }
  if (btnReg) { btnReg.classList.toggle("is-active", studentAddMode === "registered"); btnReg.setAttribute("aria-pressed", String(studentAddMode === "registered")); }
  if (wrapNew) wrapNew.hidden = studentAddMode !== "new";
  if (wrapReg) wrapReg.hidden = studentAddMode !== "registered";
  if (studentAddMode === "registered") populateStudentAccountSelect();
  else if (dom.studentNameInput) dom.studentNameInput.focus();
}
function populateStudentAccountSelect() {
  var sel = document.getElementById("studentAccountSelect"); if (!sel) return;
  var accounts = loadAuthAccounts().slice().sort(function (a, b) { return String(a.fullName || "").localeCompare(String(b.fullName || ""), "ru"); });
  var existingNames = {}; getVisibleStudents().concat(state.students.filter(function(s){return !s.deleted;})).forEach(function (s) { existingNames[authNormalizeName(s.name)] = true; });
  var available = accounts.filter(function (a) { return !existingNames[authNormalizeName(a.fullName)]; });
  sel.innerHTML = "";
  if (!available.length) {
    var opt = document.createElement("option"); opt.value = ""; opt.textContent = accounts.length ? "Все аккаунты уже в журнале" : "Нет зарегистрированных аккаунтов"; sel.appendChild(opt);
  } else {
    available.forEach(function (a) { var opt = document.createElement("option"); opt.value = a.id; opt.textContent = a.fullName; sel.appendChild(opt); });
  }
  var hint = document.getElementById("studentAccountHint");
  if (hint) hint.textContent = accounts.length ? ("Всего аккаунтов на устройстве: " + accounts.length + ". Доступных для добавления: " + available.length + ".") : "Аккаунты создаются на экране входа/регистрации этого устройства.";
}
function addStudent() {
  if (!effectivePermissions().canEditJournal) { showToast("Роль «" + DEVICE_ROLES[deviceRole(deviceId)].label + "»: добавление учеников недоступно", "warning"); return; }
  var name, linkedAccountId = null;
  if (studentAddMode === "registered") {
    var sel = document.getElementById("studentAccountSelect");
    var accId = sel && sel.value;
    if (!accId) { showToast("Сначала выберите зарегистрированный аккаунт", "warning"); populateStudentAccountSelect(); return; }
    var account = loadAuthAccounts().find(function (a) { return a.id === accId; });
    if (!account) { showToast("Аккаунт не найден — обновите список", "warning"); populateStudentAccountSelect(); return; }
    name = String(account.fullName || "").trim().replace(/\s+/g, " ");
    if (getVisibleStudents().some(function (s) { return authNormalizeName(s.name) === authNormalizeName(name); })) { showToast("Этот аккаунт уже добавлен в журнал", "warning"); populateStudentAccountSelect(); return; }
    linkedAccountId = account.id;
  } else {
    name = dom.studentNameInput.value.trim().replace(/\s+/g, " ");
    if (!name) { dom.studentNameInput.focus(); showToast("Введите имя ученика", "warning"); return; }
  }
  if (name.length > 200) { showToast("Имя должно быть короче 200 символов", "warning"); return; }
  var student = { id: generateId(), name: name, updatedAt: nextTimestamp(), actor: deviceId, deleted: false, classId: state.selectedClass || "class-main" };
  if (linkedAccountId) student.accountId = linkedAccountId;
  state.students.push(student);
  if (dom.studentNameInput) dom.studentNameInput.value = "";
  markChanged(["students/"+student.id]); scheduleSaveLocal(); render(); scheduleSync();
  if (studentAddMode === "registered") populateStudentAccountSelect(); else dom.studentNameInput.focus();
  showToast(linkedAccountId ? "Зарегистрированный ученик добавлен" : "Ученик добавлен", "success");
}
function renameStudent(id) {
  if (!effectivePermissions().canEditJournal) return;
  var student = getStudentById(id); if (!student || student.deleted) return;
  var name = window.prompt("Имя ученика", student.name); if (name === null) return; name = name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 200) { showToast("Введите имя длиной до 200 символов", "warning"); return; }
  if (name === student.name) return; student.name = name; student.updatedAt = nextTimestamp(); student.actor = deviceId;
  markChanged(["students/"+id]); scheduleSaveLocal(); render(); scheduleSync();
}
function removeStudent(id) {
  if (!effectivePermissions().canEditJournal) return;
  var student = getStudentById(id); if (!student || student.deleted) return;
  if (!window.confirm("Удалить ученика «" + student.name + "» из журнала? Перед удалением будет сохранена резервная копия.")) return;
  try { saveRecoveryBackup(); } catch (e) { showToast("Удаление отменено: " + e.message, "error"); return; }
  student.deleted = true; student.updatedAt = nextTimestamp(); student.actor = deviceId;
  markChanged(["students/"+id]); scheduleSaveLocal(); render(); scheduleSync(); showToast("Ученик удалён. Доступно восстановление из копии.", "success");
}
function modalFocusables() { return activeModal ? Array.from(activeModal.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex='0']")).filter(function (el) { return el.getClientRects().length; }) : []; }
function updateInert() { if (dom.journalApp) dom.journalApp.inert = !!activeModal || shouldShowMaintenance(); if (dom.maintenanceOverlay) dom.maintenanceOverlay.inert = !!activeModal; }
function openModal(modal, focus) {
  if (activeModal === modal) return;
  if (activeModal) { modalStack.push({ modal: activeModal, previousFocus: previousFocus }); activeModal.classList.remove("open"); }
  previousFocus = document.activeElement; activeModal = modal; modal.classList.add("open"); document.body.style.overflow = "hidden"; updateInert();
  var target = focus || modalFocusables()[0]; if (target) target.focus();
}
function closeModal() {
  if (!activeModal) return; activeModal.classList.remove("open");
  var target = previousFocus;
  var parent = modalStack.pop(); activeModal = parent ? parent.modal : null; previousFocus = parent ? parent.previousFocus : null;
  if (activeModal) activeModal.classList.add("open"); document.body.style.overflow = activeModal ? "hidden" : ""; updateInert();
  if (target && !target.isConnected && target.dataset) {
    if (target.dataset.cardDate) target = dom.studentCardDays.querySelector('[data-card-date="' + target.dataset.cardDate + '"]');
    else if (target.dataset.dateKey) target = document.querySelector('.attendance-button[data-student-id="' + target.dataset.studentId + '"][data-date-key="' + target.dataset.dateKey + '"]');
    else if (target.dataset.action === "card") target = dom.tableBody.querySelector('[data-action="card"][data-student-id="' + target.dataset.studentId + '"]');
  }
  if (target && target.isConnected && target.getClientRects().length && !target.closest("[inert]")) target.focus();
  else if (activeModal && modalFocusables()[0]) modalFocusables()[0].focus();
  else if (!shouldShowMaintenance() && dom.versionButton) dom.versionButton.focus();
}
function openAttendanceModal(studentId, dateKey) {
  var student = getStudentById(studentId); if (!student || student.deleted || !validDate(dateKey)) return;
  var entry = normalizeStatusEntry(state.attendance[studentId + "_" + dateKey]);
  Object.assign(attendanceModalState, { open: true, studentId: studentId, dateKey: dateKey, currentStatus: entry ? entry.status : STATUS_UNMARKED });
  dom.attStudentName.textContent = student.name;
  dom.attDateText.textContent = parseDateKey(dateKey).toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  updateAttendanceModalOptions(); openModal(dom.attendanceModal, dom.attOptions.querySelector('[data-status="' + attendanceModalState.currentStatus + '"]'));
}
function updateAttendanceModalOptions() { dom.attOptions.querySelectorAll(".att-option").forEach(function (btn) { var current = btn.dataset.status === attendanceModalState.currentStatus; btn.classList.toggle("current", current); btn.setAttribute("aria-pressed", String(current)); }); }
function closeAttendanceModal() { attendanceModalState.open = false; closeModal(); }
function setAttendanceStatus(status) {
  if (!effectivePermissions().canEditJournal) { showToast("Роль «" + DEVICE_ROLES[deviceRole(deviceId)].label + "»: отметки недоступны", "warning"); return; }
  if (!attendanceModalState.open || !Object.prototype.hasOwnProperty.call(statusLabels, status)) return;
  var student = getStudentById(attendanceModalState.studentId); if (!student || student.deleted) { closeAttendanceModal(); return; }
  var key = student.id + "_" + attendanceModalState.dateKey;
  state.attendance[key] = { status: status, updatedAt: nextTimestamp(), actor: deviceId };
  markChanged(["attendance/"+key]); scheduleSaveLocal(); renderNow(); scheduleSync(); closeAttendanceModal();
}
function changeMonth(offset) { var d = parseMonth(state.selectedMonth); d.setMonth(d.getMonth() + offset); if (d.getFullYear() < 1000 || d.getFullYear() > 9999) return; state.selectedMonth = getMonthString(d); state.selectedDate = formatDateKey(d); render(); }
function element(tag, className, text) { var el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function renderHeader(days) {
  var row = element("tr"), first = element("th", "student-column", "Ученик"); first.scope = "col"; row.appendChild(first);
  days.forEach(function (day) { var th = element("th", (isWeekend(day) ? "weekend " : "") + (isToday(day) ? "today-column" : "")); th.scope = "col"; th.dataset.dateKey = formatDateKey(day); th.appendChild(element("span", "date-number", day.getDate())); th.appendChild(element("span", "weekday", weekdayNames[day.getDay()])); th.setAttribute("aria-label", day.toLocaleDateString("ru-RU")); row.appendChild(th); });
  var actions = element("th", "actions-column", "Действия"); actions.scope = "col"; row.appendChild(actions); dom.tableHead.replaceChildren(row);
}
/* ---------- Journal table incremental update (performance) ---------- */
// Previously every attendance mark rebuilt the whole table (~30 students x
// ~31 days = 900+ buttons), which froze low-end phones for seconds. Now the
// table state is cached by signature; unchanged renders are skipped entirely
// and status-only changes patch individual cells in place.
var lastTableSignature = null;
function buildTableData(days) {
  var visible = getVisibleStudents(), filtered = getFilteredStudents();
  return {
    visible: visible, filtered: filtered,
    statuses: filtered.map(function (s) {
      return days.map(function (d) {
        var v = normalizeStatusEntry(state.attendance[s.id + "_" + formatDateKey(d)]);
        return v ? v.status : STATUS_UNMARKED;
      });
    })
  };
}
function tableSignature(data, days) {
  var parts = [state.viewMode, data.visible.length, data.filtered.length, days.length];
  data.filtered.forEach(function (s, i) { parts.push(s.id + ":" + s.name + ":" + data.statuses[i].join(",")); });
  return parts.join("|");
}
function setCellStatus(btn, student, day, status) {
  btn.className = "attendance-button " + status;
  if (state.viewMode === "day") {
    var labels = { present: "\u0411\u044b\u043b", absent: "\u041d\u0435\u0442", late: "\u041e\u043d\u043b\u0430\u0439\u043d", unmarked: "\u041e\u0442\u043c\u0435\u0442\u0438\u0442\u044c" };
    btn.replaceChildren(element("span", "day-status-icon", statusSymbols[status]), element("span", "day-status-label", labels[status]));
  } else {
    btn.textContent = statusSymbols[status];
  }
  btn.title = statusLabels[status];
  btn.setAttribute("aria-label", student.name + ", " + day.toLocaleDateString("ru-RU") + ": " + statusLabels[status]);
}
function patchTableCells(data, days) {
  var rows = dom.tableBody.rows;
  for (var r = 0; r < data.filtered.length && r < rows.length; r++) {
    var student = data.filtered[r], sts = data.statuses[r], cells = rows[r].cells;
    for (var c = 0; c < days.length; c++) {
      var btn = cells[c + 1] && cells[c + 1].firstChild;
      if (!btn || !btn.classList) continue;
      if (btn.className !== "attendance-button " + sts[c]) setCellStatus(btn, student, days[c], sts[c]);
    }
  }
}
function renderBody(days) {
  var data = buildTableData(days);
  dom.emptyMessage.style.display = data.visible.length ? "none" : "block";
  dom.noSearchResults.style.display = data.visible.length && !data.filtered.length ? "block" : "none";
  var sig = tableSignature(data, days);
  if (sig === lastTableSignature && dom.tableBody.rows.length === data.filtered.length) return;
  var prevSig = lastTableSignature;
  lastTableSignature = sig;
  // Fast path: same structure, only statuses changed -> patch cells in place.
  if (prevSig) {
    var prev = prevSig.split("|");
    if (prev[0] === state.viewMode && Number(prev[2]) === data.filtered.length && Number(prev[3]) === days.length) { patchTableCells(data, days); return; }
  }
  var fragment = document.createDocumentFragment();
  data.filtered.forEach(function (student, index) {
    var row = element("tr"), name = element("th", "student-name-cell"); name.scope = "row";
    var flex = element("div", "student-name-flex"); flex.appendChild(element("span", "student-number", data.visible.indexOf(student) + 1));
    var text = element("button", "student-name-text student-card-trigger", student.name); text.type = "button"; text.title = "\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0443: " + student.name; text.dataset.action = "card"; text.dataset.studentId = student.id; text.setAttribute("aria-label", "\u041a\u0430\u0440\u0442\u043e\u0447\u043a\u0430 \u0443\u0447\u0435\u043d\u0438\u043a\u0430: " + student.name); text.setAttribute("aria-haspopup", "dialog"); flex.appendChild(text); name.appendChild(flex); row.appendChild(name);
    days.forEach(function (day, di) {
      var status = data.statuses[index][di];
      var cell = element("td", (isWeekend(day) ? "weekend " : "") + (isToday(day) ? "today-column" : "")), btn = element("button", "attendance-button " + status);
      btn.type = "button"; btn.dataset.studentId = student.id; btn.dataset.dateKey = formatDateKey(day);
      setCellStatus(btn, student, day, status); cell.appendChild(btn); row.appendChild(cell);
    });
    var actions = element("td", "actions-column"), edit = element("button", "secondary row-edit", "\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c"), remove = element("button", "row-remove", "\u0423\u0434\u0430\u043b\u0438\u0442\u044c");
    edit.type = remove.type = "button"; edit.dataset.action = "rename"; remove.dataset.action = "remove"; edit.dataset.studentId = remove.dataset.studentId = student.id;
    edit.setAttribute("aria-label", "\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u0438\u043c\u044f: " + student.name); remove.setAttribute("aria-label", "\u0423\u0434\u0430\u043b\u0438\u0442\u044c: " + student.name); actions.append(edit, remove); row.appendChild(actions); fragment.appendChild(row);
  });
  dom.tableBody.replaceChildren(fragment);
}
function renderSummary(days) {
  var students = getVisibleStudents(), ids = new Set(students.map(function (s) { return s.id; })), count = { present: 0, absent: 0, late: 0 };
  var dates = new Set(days.map(formatDateKey));
  Object.keys(state.attendance).forEach(function (key) { var split = key.lastIndexOf("_"); if (!ids.has(key.slice(0, split)) || !dates.has(key.slice(split + 1))) return; var value = normalizeStatusEntry(state.attendance[key]); if (value && Object.prototype.hasOwnProperty.call(count, value.status)) count[value.status]++; });
  dom.summaryStudents.textContent = students.length; dom.summaryPresent.textContent = count.present; dom.summaryAbsent.textContent = count.absent; dom.summaryLate.textContent = count.late;
  var period = state.viewMode === "day" ? "день" : state.viewMode === "week" ? "неделю" : "месяц";
  document.querySelectorAll(".summary-card:not(:first-child) .summary-note").forEach(function (note) { note.textContent = "Отметки за " + period; });
  dom.coverageInfo.textContent = "За " + period + ": " + (count.present + count.absent + count.late) + " отметок. Пустые дни не считаются присутствием.";
}
function shouldShowMaintenance() { return state.settings.maintenance && state.settings.maintenanceBy !== deviceId && !state.devUnlocked; }
function renderMaintenance() { var open = shouldShowMaintenance(), wasOpen = dom.maintenanceOverlay.classList.contains("open"); dom.maintenanceOverlay.classList.toggle("open", open); dom.maintenanceMessageText.textContent = state.settings.maintenanceMessage; dom.maintenanceActiveBadge.style.display = state.settings.maintenance ? "inline-flex" : "none"; updateInert(); if (open && !wasOpen && !activeModal) dom.maintenanceDevAccessButton.focus(); }
function renderNews() {
  var news = state.settings.news.trim(), dismissed = null; try { dismissed = storage && storage.getItem(NEWS_DISMISS_KEY); } catch (e) {}
  dom.newsText.textContent = news; dom.newsBanner.classList.toggle("visible", !!news && news !== dismissed);
}
/* ---------- Render scheduling (performance) ---------- */
// A single click used to trigger several full re-renders in a row
// (markChanged -> render, saveLocal -> ... -> render, scheduleSync ->
// updateSyncUI -> renderOffline). On phones this produced visible jank.
// All callers now go through requestAnimationFrame coalescing: no matter how
// many times render()/renderOffline() are requested within one frame, the
// heavy work runs exactly once per frame.
var renderScheduled = false, renderOfflineScheduled = false;
// Skip re-rendering panels whose inputs (state signature) have not changed.
// On low-end phones the full pipeline per click rebuilt homework/offline/
// account DOM every frame even when nothing in them had changed.
var lastFlushDaysSig = null, lastHomeworkSig = null, lastAccountSig = null;
function flushRender() {
  renderScheduled = false;
  var focused = document.activeElement, days = getDisplayedDays();
  var daysSig = state.viewMode + "|" + state.selectedDate + "|" + state.selectedMonth + "|" + state.selectedClass + "|" + state.searchQuery;
  if (daysSig !== lastFlushDaysSig || !dom.tableBody.rows.length) {
    lastFlushDaysSig = daysSig;
    renderViewControls(days); dom.printMonthTitle.textContent = dom.monthTitle.textContent;
    renderHeader(days); renderBody(days); renderSummary(days); renderStudentCard(); renderProject();
    dom.searchResultsInfo.textContent = state.searchQuery.trim() ? "Найдено " + getFilteredStudents().length + " из " + getVisibleStudents().length : "Всего " + getVisibleStudents().length;
    dom.clearSearchButton.hidden = !state.searchQuery;
    if (studentAddMode === "registered") populateStudentAccountSelect();
  }
  dom.versionButtonText.textContent = state.settings.versionText; dom.versionButton.setAttribute("aria-label", state.settings.versionText + ". Открыть настройки по коду"); if (dom.journalEdition) dom.journalEdition.textContent = settingsVersionText();
  renderNews(); renderMaintenance();
  // Homework panel: rebuild only when its data actually changed.
  var hwSigReal = (state.homework || []).map(function (h) { return h.id + ":" + (h.deleted ? 1 : 0) + ":" + String(h.text || "") + ":" + (h.dueDate || "") + ":" + (h.classId || ""); }).join("#") + "|" + state.selectedClass + "|" + syncReadOnly();
  if (hwSigReal !== lastHomeworkSig) { lastHomeworkSig = hwSigReal; renderHomework(); }
  renderOfflineNow();
  // Account panel is hidden most of the time — build its HTML only while open.
  var accSig = (accountNavActive ? "1" : "0");
  if (accSig === "1") {
    var s = currentAuthSession(), m = (state.deviceMeta || {})[deviceId] || {}, p = effectivePermissions();
    var sig2 = JSON.stringify([p.role, p.techAdmin, p.canManageDevices, s && s.accountId, s && s.fullName, s && s.method, s && s.at, m.name, m.techAdmin]);
    if (sig2 !== lastAccountSig) { lastAccountSig = sig2; renderAccountPanel(); }
  } else if (lastAccountSig !== null) { lastAccountSig = null; }
  if (!activeModal && focused && focused.dataset && focused.dataset.dateKey && !focused.isConnected) { var replacement = document.querySelector('.attendance-button[data-student-id="' + focused.dataset.studentId + '"][data-date-key="' + focused.dataset.dateKey + '"]'); if (replacement) replacement.focus(); }
}

/* ---------- Account panel (sidebar «Аккаунт») ---------- */
var accountNavActive = false; // true while the user is on the account screen
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
  });
}
function formatAuthDate(ts) {
  if (!(ts > 0)) return "—";
  var d = new Date(ts);
  var pad = function (n) { return String(n).length < 2 ? "0" + n : String(n); };
  return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear() + ", " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function findAuthAccountById(id) {
  if (!id) return null;
  var accounts = loadAuthAccounts();
  for (var i = 0; i < accounts.length; i++) { if (accounts[i].id === id) return accounts[i]; }
  return null;
}
/* ---------- User (account) management in the settings panel ---------- */
// Accounts live only on this device (AUTH_ACCOUNTS_KEY). The settings panel
// lists them and allows deleting: the credential is removed forever, the
// current session ends if it belonged to the deleted account, and a recovery
// backup of the journal is saved beforehand. Linked journal students are NOT
// deleted — their profile simply becomes unlinked («Не привязан»).
function renderUserList() {
  var container = dom.userList;
  if (!container) return;
  var accounts = loadAuthAccounts().slice().sort(function (a, b) { return String(a.fullName || "").localeCompare(String(b.fullName || ""), "ru"); });
  var session = currentAuthSession();
  if (!accounts.length) {
    container.innerHTML = '<p class="help-text">Пока нет ни одного аккаунта — пользователи создаются на экране входа.</p>';
    return;
  }
  var canManage = effectivePermissions().canManageDevices;
  container.textContent = "";
  accounts.forEach(function (account) {
    var row = document.createElement("div"); row.className = "device-row user-row";
    var info = document.createElement("div");
    var name = document.createElement("span"); name.className = "device-name";
    name.textContent = account.fullName || (account.firstName + " " + account.lastName);
    info.appendChild(name);
    if (session && session.accountId === account.id) { var badge = document.createElement("span"); badge.className = "device-badge"; badge.textContent = "текущий вход"; info.appendChild(badge); }
    var created = document.createElement("span"); created.className = "device-id";
    created.textContent = "Создан: " + formatAuthDate(account.createdAt);
    info.appendChild(document.createElement("br")); info.appendChild(created);
    row.appendChild(info);
    var meta = document.createElement("span"); meta.className = "device-seen";
    var linked = (state.students || []).find(function (s) { return s && !s.deleted && (s.accountId === account.id || authNormalizeName(s.name || "") === authNormalizeName(account.fullName || "")); });
    meta.textContent = linked ? "В журнале: " + linked.name : "В журнале: не привязан";
    row.appendChild(meta);
    var rename = document.createElement("button"); rename.type = "button"; rename.className = "secondary user-rename";
    rename.dataset.accountId = account.id;
    rename.textContent = "Переименовать";
    rename.disabled = !canManage;
    rename.title = canManage ? "Изменить имя пользователя (синхронно с записью в журнале)" : "Переименовывать пользователей могут только учитель или тех. администрация";
    row.appendChild(rename);
    var remove = document.createElement("button"); remove.type = "button"; remove.className = "danger user-remove";
    remove.dataset.accountId = account.id;
    remove.textContent = "Удалить";
    remove.disabled = !canManage;
    remove.title = canManage ? "Удалить этот аккаунт с устройства" : "Удалять аккаунты могут только учитель или тех. администрация";
    row.appendChild(remove);
    container.appendChild(row);
  });
}
function removeAuthAccount(id) {
  var perms = effectivePermissions();
  if (!perms.canManageDevices) { showToast("Удаление пользователей доступно учителю или тех. администрации", "warning"); return false; }
  var accounts = loadAuthAccounts();
  var account = null;
  for (var i = 0; i < accounts.length; i++) { if (accounts[i].id === id) { account = accounts[i]; break; } }
  if (!account) { showToast("Аккаунт не найден — обновите список", "warning"); renderUserList(); return false; }
  var session = currentAuthSession();
  var isCurrent = Boolean(session && session.accountId === id);
  var warning = "Удалить пользователя «" + (account.fullName || "без имени") + "» с этого устройства?\nВход по этому аккаунту станет невозможен, секретное слово будет утеряно." +
    (isCurrent ? "\nЭто текущая учётная запись — после удаления потребуется новый вход." : "");
  if (!window.confirm(warning)) return false;
  // Second confirmation typed manually — deletion is irreversible.
  var word = window.prompt("Необратимое действие. Для подтверждения введите имя пользователя точно:\n" + (account.fullName || ""));
  if (word === null) { showToast("Удаление отменено", "info"); return false; }
  if (authNormalizeName(word) !== authNormalizeName(account.fullName || "")) { showToast("Имя не совпало — удаление отменено", "info"); return false; }
  try { saveRecoveryBackup(); } catch (e) { showToast("Удаление отменено: " + e.message, "error"); return false; }
  var remaining = loadAuthAccounts().filter(function (a) { return a.id !== id; });
  try { saveAuthAccounts(remaining); } catch (e) { showToast("Не удалось сохранить список аккаунтов: " + e.message, "error"); return false; }
  // Remember the deletion so it propagates to other devices instead of the
  // account resurrecting from their older Gist copies.
  rememberAccountDeletion(account);
  scheduleAccountSync("silent");
  if (isCurrent) {
    clearAuthSession(); state.devUnlocked = false;
    try { if (storage) storage.removeItem(SETTINGS_UNLOCK_KEY); } catch (e) {}
    closeModal(); renderMaintenance(); openAuthGate(remaining.length ? "login" : "register");
    lastFlushDaysSig = null; lastHomeworkSig = null; lastAccountSig = null;
    render(); applyRoleRestrictions(); renderDeviceList();
    showToast("Пользователь удалён. Требуется вход.", "success");
  } else {
    refreshDevPanel();
    showToast("Пользователь «" + (account.fullName || "") + "» удалён с этого устройства", "success");
  }
  return true;
}
// Linked journal student for the signed-in account (added via «Зарегистрированный»).
function linkedStudentForSession(session) {
  if (!session || !session.accountId) return null;
  var students = getVisibleStudents().concat(state.students || []);
  var seen = {};
  for (var i = 0; i < students.length; i++) {
    var s = students[i];
    if (!s || s.deleted || seen[s.id]) continue;
    seen[s.id] = true;
    if (s.accountId === session.accountId) return s;
    if (session.fullName && authNormalizeName(s.name || "") === authNormalizeName(session.fullName)) return s;
  }
  return null;
}
// The account screen can be opened without a signed-in session (e.g. the
// teacher uses «Журнал» and taps «Аккаунт»): in that case we show the device
// identity plus a call-to-action instead of an empty panel.
function renderAccountPanel() {
  lastAccountSig = null; // explicit callers must always get fresh content
  var body = dom.accountCardBody;
  if (!body) return;
  var perms = effectivePermissions();
  var session = currentAuthSession();
  var account = session ? findAuthAccountById(session.accountId) : null;
  var meta = (state.deviceMeta || {})[deviceId] || {};
  var rows = [];
  rows.push(["Пользователь", session ? session.fullName : "Не авторизован"]);
  rows.push(["Роль устройства", DEVICE_ROLES[perms.role].label]);
  rows.push(["Тех. администрация", perms.techAdmin ? "Выдана (полный доступ)" : "Нет"]);
  rows.push(["Имя устройства", meta.name || deviceId.slice(0, 8)]);
  if (account) rows.push(["Аккаунт создан", formatAuthDate(account.createdAt)]);
  if (session) rows.push(["Текущий вход", (session.method === "register" ? "регистрация" : session.method === "secret" ? "секретное слово" : "код из SMS") + " · " + formatAuthDate(session.at)]);
  var linked = session ? linkedStudentForSession(session) : null;
  rows.push(["Профиль в журнале", linked ? linked.name : "Не привязан"]);
  var html = '<dl class="account-list">';
  rows.forEach(function (r) { html += "<div><dt>" + escapeHtml(r[0]) + "</dt><dd>" + escapeHtml(r[1]) + "</dd></div>"; });
  html += "</dl>";
  if (!session) {
    html += '<p class="help-text">На этом устройстве нет активной учётной записи. Чтобы создать её, используйте кнопку ниже — после этого откроется экран регистрации или входа.</p>' +
      '<div class="account-actions"><button id="accountSignInButton" type="button">Войти или зарегистрироваться</button></div>';
  }
  if (perms.role === "student") html += '<p class="help-text">Роль «Ученик»: доступны только домашние задания и своя посещаемость.</p>';
  else if (perms.role === "observer") html += '<p class="help-text">Роль «Наблюдатель»: полный обзор без права редактирования.</p>';
  else html += '<p class="help-text">Роль «Учитель»: полный доступ к журналу, ученикам и домашним заданиям.</p>';
  body.innerHTML = html;
  var signInBtn = document.getElementById("accountSignInButton");
  if (signInBtn) signInBtn.addEventListener("click", function () { closeAccountView(); openAuthGate(loadAuthAccounts().length ? "login" : "register"); });
  if (dom.accountChangeRoleButton) {
    var canManage = perms.canManageDevices;
    dom.accountChangeRoleButton.disabled = !canManage;
    dom.accountChangeRoleButton.title = canManage ? "Сменить роль этого устройства" : "Смену роли может выполнить учитель или тех. администрация";
  }
  if (dom.accountLogoutButton) dom.accountLogoutButton.disabled = !session;
}
// The account screen hides the journal content via a CSS class instead of
// setting `hidden` on every child element — blanket `hidden` broke panels that
// rely on custom display rules (details/summary, [open] sections), which made
// the action buttons of the account panel disappear.
function openAccountView() {
  accountNavActive = true;
  renderAccountPanel();
  var app = document.getElementById("journalApp");
  if (app) app.classList.add("account-view");
  if (dom.accountPanel) dom.accountPanel.hidden = false;
  window.scrollTo({ top: 0, behavior: "auto" });
}
function closeAccountView() {
  accountNavActive = false;
  var app = document.getElementById("journalApp");
  if (app) app.classList.remove("account-view");
  if (dom.accountPanel) dom.accountPanel.hidden = true;
  if (typeof renderMaintenance === "function") renderMaintenance();
}
function changeOwnDeviceRole() {
  var perms = effectivePermissions();
  if (!perms.canManageDevices) { showToast("Смена роли доступна учителю или тех. администрации", "warning"); return; }
  var current = deviceRole(deviceId);
  var lines = DEVICE_ROLE_KEYS.map(function (key) {
    return (key === current ? "▶ " : "• ") + DEVICE_ROLES[key].label + " — " + DEVICE_ROLES[key].hint;
  }).join("\n");
  var answer = window.prompt("Выберите роль этого устройства.\n\n" + lines + "\n\nВведите номер роли (1–3):", String(DEVICE_ROLE_KEYS.indexOf(current) + 1));
  if (answer === null) return;
  var index = parseInt(answer.trim(), 10) - 1;
  if (!(index >= 0 && index < DEVICE_ROLE_KEYS.length)) { showToast("Нужно число от 1 до " + DEVICE_ROLE_KEYS.length, "warning"); return; }
  setDeviceRole(deviceId, DEVICE_ROLE_KEYS[index]);
  renderAccountPanel();
}
function render() {
  if (renderScheduled) return;
  renderScheduled = true;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flushRender);
  else flushRender();
}
// Immediate variant for flows that read the DOM right after rendering
// (focus restoration, modal close chains, initialization).
function renderNow() { renderScheduled = false; flushRender(); }
// Search input is debounced: typing used to rebuild the whole table on every
// keystroke, which lagged badly on month view with many students.
var searchRenderTimer = null;
function scheduleSearchRender() {
  clearTimeout(searchRenderTimer);
  searchRenderTimer = setTimeout(function () { searchRenderTimer = null; render(); }, 120);
}
function refreshDevPanel() {
  dom.devVersionTextInput.value = state.settings.versionText; dom.devMaintenanceMessageInput.value = state.settings.maintenanceMessage; dom.devNewsInput.value = state.settings.news;
  dom.devToggleMaintenanceButton.textContent = state.settings.maintenance ? "Завершить обслуживание" : "Включить экран обслуживания";
  dom.devToggleMaintenanceButton.className = state.settings.maintenance ? "danger" : "secondary";
  renderDeviceList();
  renderUserList();
  renderClassList();
  renderInstitutionList();
  // Account section: show who is logged in on this device.
  var session = currentAuthSession();
  if (dom.authAccountInfo) dom.authAccountInfo.textContent = session
    ? "Вошёл: " + session.fullName + " · вход через «" + (session.method === "register" ? "регистрацию" : session.method === "secret" ? "секретное слово" : "код из SMS") + "». Данные аккаунта хранятся только на этом устройстве."
    : "Устройство не авторизовано.";
  if (dom.authLogoutButton) dom.authLogoutButton.disabled = !session;
}
function openDevPanel() { if (!state.devUnlocked) { openPasswordModal(); return; } refreshDevPanel(); renderMaintenance(); openModal(dom.devPanelModal, dom.devVersionTextInput); }
function collapseDevPanel() { closeModal(); renderMaintenance(); }
function exitDevSettings() { state.devUnlocked = false; try { if (storage) storage.removeItem(SETTINGS_UNLOCK_KEY); } catch (error) {} setDeviceTechAdmin(deviceId, false); closeModal(); renderMaintenance(); if (dom.journalEdition) dom.journalEdition.textContent = settingsVersionText(); showToast("Вы вышли из настроек. Статус «Тех. администрация» снят, для возврата потребуется код доступа.", "info"); }
// The small gray label above the site title follows the access code: while a
// personal code is set on this device, the edition shows its installation date.
function settingsCodeInstalled() {
  try { if (storage && storage.getItem(SETTINGS_CODE_SET_KEY)) return true; } catch (error) {}
  return SETTINGS_ACCESS_CODE !== DEFAULT_SETTINGS_ACCESS_CODE;
}
function settingsEditionText() {
  var stamp = null;
  try { stamp = Number(storage && storage.getItem(SETTINGS_CODE_SET_KEY)) || null; } catch (error) {}
  if (!(stamp > 0)) return "v" + APP_VERSION;
  var d = new Date(stamp);
  var pad = function (n) { return String(n).length < 2 ? "0" + n : String(n); };
  return "v" + d.getFullYear() + "." + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
// The header label is the version text edited in settings ("Текст кнопки
// версии"), with the leading word "версия" replaced by "Версия журнала".
// Matching is case-insensitive and tolerant of a missing space after the
// colon (e.g. "версия:3.3") so the prefix is never duplicated or left in
// lowercase.
function settingsVersionText() {
  var text = String(state.settings.versionText || DEFAULT_VERSION_TEXT).trim();
  return text.replace(/^версия\s*:?\s*/i, "Версия журнала: ");
}
function renderDebug() { dom.debugPre.textContent = JSON.stringify({ version: 5, deviceId: deviceId, revision: state.revision, pending: syncRuntime.hasPendingChanges, syncing: syncRuntime.isSyncing, lastError: syncConfig.lastError, students: getVisibleStudents().length, attendance: Object.keys(state.attendance).length, gistId: syncConfig.gistId || null }, null, 2); }
function exportBackup() {
  var payload = buildPayload(); payload.exportedAt = new Date().toISOString();
  var url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })), a = document.createElement("a");
  a.href = url; a.download = "Журнал_" + formatDateKey(new Date()) + ".json"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 10000); showToast("Резервная копия скачана", "success");
}
function restoreData(data) {
  var current = buildPayload(), time = nextTimestamp(), ids = new Set(data.students.map(function (s) { return s.id; }));
  data.students.forEach(function (s) { s.updatedAt = time; s.actor = deviceId; });
  current.students.forEach(function (s) { if (!ids.has(s.id)) data.students.push(Object.assign({}, s, { deleted: true, updatedAt: time, actor: deviceId })); });
  Object.keys(current.attendance).forEach(function (key) { if (!Object.prototype.hasOwnProperty.call(data.attendance, key)) data.attendance[key] = { status: STATUS_UNMARKED, updatedAt: time, actor: deviceId }; });
  Object.keys(data.attendance).forEach(function (key) { data.attendance[key].updatedAt = time; data.attendance[key].actor = deviceId; });
  settingFields.forEach(function (field) { data.settings.fieldMeta[field] = { updatedAt: time, actor: deviceId }; }); data.settings.updatedAt = time;
  var previousTracked = trackedPayload; restoreProjectData(data, current, time); applyMergedToState(data); trackedPayload = previousTracked; markChanged(); saveLocal(true); render(); if (activeModal === dom.devPanelModal) refreshDevPanel(); scheduleSync();
}
// Full wipe: removes every student, all attendance marks/absences, homework and lessons
// across ALL classes. Classes and subjects are kept so the journal stays usable.
// A recovery backup is saved first — "Восстановить последнюю" undoes the wipe.
function clearAllJournalData() {
  var perms = effectivePermissions();
  if (!perms.canEditJournal || !perms.canManageDevices) { showToast("Полная очистка доступна учителю или тех. администрации", "warning"); return; }
  var liveStudents = state.students.filter(function (s) { return !s.deleted; }).length;
  var liveLessons = (state.lessons || []).filter(function (l) { return !l.deleted; }).length;
  var liveHw = (state.homework || []).filter(function (h) { return !h.deleted; }).length;
  if (!liveStudents && !liveLessons && !liveHw && !Object.keys(state.attendance || {}).length) { showToast("Журнал уже пуст — очищать нечего", "info"); return; }
  if (!window.confirm("Полная очистка: удалить ВСЕХ учеников (" + liveStudents + "), все отметки и пропуски, домашние задания (" + liveHw + ") и занятия (" + liveLessons + ") во всех классах?\nКлассы и предметы останутся. Перед удалением будет сохранена резервная копия.")) return;
  // Second confirmation must be synchronous (prompt right after confirm).
  var word = window.prompt("Это необратимое действие (отменить можно только восстановлением копии).\nДля подтверждения введите слово ОЧИСТИТЬ:");
  if (word === null) return;
  if (String(word).trim().toUpperCase() !== "ОЧИСТИТЬ") { showToast("Очистка отменена: код подтверждения не совпал", "info"); return; }
  runFullClear();
}
function restoreBackup() {
  if (!effectivePermissions().canManageDevices) { showToast("Восстановление копий доступно учителю или тех. администрации", "warning"); return; }
  try { var backups = storage && JSON.parse(storage.getItem(BACKUP_KEY) || "[]"); if (!backups || !backups.length) { showToast("Пока нет автоматических резервных копий", "warning"); return; }
    var last = backups[0], data = migrateData(last.data, true); if (!window.confirm("Восстановить журнал из копии от " + new Date(last.savedAt).toLocaleString("ru-RU") + "? Текущая версия тоже будет сохранена.")) return; saveRecoveryBackup(); restoreData(data); showToast("Журнал восстановлен", "success");
  } catch (e) { showToast("Не удалось восстановить: " + e.message, "error"); }
}
function wireCoreEvents() {
  dom.addStudentButton.addEventListener("click", addStudent);
  dom.studentNameInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addStudent(); } });
  var studentModeNewBtn = document.getElementById("studentModeNew"), studentModeRegBtn = document.getElementById("studentModeRegistered");
  if (studentModeNewBtn) studentModeNewBtn.addEventListener("click", function () { setStudentAddMode("new"); });
  if (studentModeRegBtn) studentModeRegBtn.addEventListener("click", function () { setStudentAddMode("registered"); });
  dom.monthPicker.addEventListener("change", function (e) { try { var d = parseMonth(e.target.value); state.selectedMonth = e.target.value; state.selectedDate = formatDateKey(d); render(); } catch (error) { e.target.value = state.selectedMonth; } });
  dom.previousMonthButton.addEventListener("click", function () { changePeriod(-1); }); dom.nextMonthButton.addEventListener("click", function () { changePeriod(1); }); dom.todayButton.addEventListener("click", goToToday);
  dom.searchInput.addEventListener("input", function (e) { state.searchQuery = e.target.value; scheduleSearchRender(); });
  dom.clearSearchButton.addEventListener("click", function () { state.searchQuery = ""; dom.searchInput.value = ""; renderNow(); dom.searchInput.focus(); });
  dom.tableBody.addEventListener("click", function (e) { var btn = e.target.closest("button"); if (!btn || !dom.tableBody.contains(btn)) return; if (btn.dataset.dateKey) openAttendanceModal(btn.dataset.studentId, btn.dataset.dateKey); else if (btn.dataset.action === "card") openStudentCard(btn.dataset.studentId); else if (btn.dataset.action === "rename") renameStudent(btn.dataset.studentId); else if (btn.dataset.action === "remove") removeStudent(btn.dataset.studentId); });
  dom.attCloseButton.addEventListener("click", closeAttendanceModal);
  dom.attOptions.addEventListener("click", function (e) { var btn = e.target.closest("[data-status]"); if (btn) setAttendanceStatus(btn.dataset.status); });
  dom.attendanceModal.addEventListener("click", function (e) { if (e.target === dom.attendanceModal) closeAttendanceModal(); });
  dom.versionButton.addEventListener("click", openDevPanel); dom.maintenanceDevAccessButton.addEventListener("click", openDevPanel); dom.devCloseButton.addEventListener("click", collapseDevPanel); dom.devExitButton.addEventListener("click", exitDevSettings);
  dom.devPanelModal.addEventListener("click", function (e) { if (e.target === dom.devPanelModal) collapseDevPanel(); });
  dom.devSaveVersionTextButton.addEventListener("click", function () { var text = dom.devVersionTextInput.value.trim(); if (!text) return showToast("Введите подпись журнала", "warning"); updateSettings({ versionText: text.slice(0, 60) }); showToast("Подпись сохранена", "success"); });
  dom.devResetVersionTextButton.addEventListener("click", function () { updateSettings({ versionText: DEFAULT_VERSION_TEXT }); refreshDevPanel(); });
  dom.devToggleMaintenanceButton.addEventListener("click", function () { var enabled = !state.settings.maintenance; updateSettings({ maintenance: enabled, maintenanceBy: enabled ? deviceId : "" }); refreshDevPanel(); });
  dom.devSaveMaintenanceMessageButton.addEventListener("click", function () { var text = dom.devMaintenanceMessageInput.value.trim(); if (!text) return showToast("Введите сообщение", "warning"); updateSettings({ maintenanceMessage: text.slice(0, 2000) }); showToast("Сообщение сохранено", "success"); });
  dom.devResetMaintenanceMessageButton.addEventListener("click", function () { updateSettings({ maintenanceMessage: DEFAULT_MAINTENANCE_MSG }); refreshDevPanel(); });
  dom.devSaveNewsButton.addEventListener("click", function () { updateSettings({ news: dom.devNewsInput.value.trim().slice(0, 4000) }); try { if (storage) storage.removeItem(NEWS_DISMISS_KEY); } catch (e) {} renderNews(); showToast("Объявление сохранено", "success"); });
  dom.devClearNewsButton.addEventListener("click", function () { updateSettings({ news: "" }); refreshDevPanel(); });
  if (dom.devClearAllButton) dom.devClearAllButton.addEventListener("click", clearAllJournalData);
  if (dom.refreshUserListButton) dom.refreshUserListButton.addEventListener("click", function () { renderUserList(); showToast("Список пользователей обновлён", "info"); });
  if (dom.userList) dom.userList.addEventListener("click", function (e) {
    var btn = e.target.closest(".user-remove");
    if (!btn || !dom.userList.contains(btn)) return;
    removeAuthAccount(btn.dataset.accountId);
  });
  if (dom.refreshClassListButton) dom.refreshClassListButton.addEventListener("click", function () { renderClassList(); showToast("Список классов обновлён", "info"); });
  if (dom.classList) dom.classList.addEventListener("click", function (e) {
    var btn = e.target.closest(".class-remove");
    if (!btn || !dom.classList.contains(btn)) return;
    removeClass(btn.dataset.classId);
  });
  if (dom.classList) dom.classList.addEventListener("click", function (e) {
    var btn = e.target.closest(".class-rename");
    if (!btn || !dom.classList.contains(btn)) return;
    renameClass(btn.dataset.classId);
  });
  /* Institutions: open / rename / delete rows in the settings panel */
  if (dom.institutionList) dom.institutionList.addEventListener("click", function (e) {
    var container = dom.institutionList;
    var openBtn = e.target.closest(".institution-open");
    if (openBtn && container.contains(openBtn)) { switchToInstitution(openBtn.dataset.institutionId); return; }
    var renBtn = e.target.closest(".institution-rename");
    if (renBtn && container.contains(renBtn)) { renameInstitution(renBtn.dataset.institutionId); return; }
    var delBtn = e.target.closest(".institution-remove");
    if (delBtn && container.contains(delBtn)) { removeInstitution(delBtn.dataset.institutionId); return; }
  });
  if (dom.addInstitutionButton) dom.addInstitutionButton.addEventListener("click", addInstitution);
  if (dom.refreshInstitutionListButton) dom.refreshInstitutionListButton.addEventListener("click", function () { renderInstitutionList(); showToast("Список учреждений обновлён", "info"); });
  dom.newsCloseButton.addEventListener("click", function () { try { if (storage) storage.setItem(NEWS_DISMISS_KEY, state.settings.news.trim()); } catch (e) {} dom.newsBanner.classList.remove("visible"); });
  dom.exportBackupButton.addEventListener("click", exportBackup); dom.importBackupButton.addEventListener("click", function () { dom.importBackupInput.click(); }); dom.restoreBackupButton.addEventListener("click", restoreBackup); dom.printButton.addEventListener("click", function () { window.print(); });
  dom.importBackupInput.addEventListener("change", async function (e) {
    var file = e.target.files[0]; if (!file) return;
    if (!effectivePermissions().canManageDevices) { showToast("Импорт копий доступен учителю или тех. администрации", "warning"); e.target.value = ""; return; }
    try { if (file.size > 20 * 1024 * 1024) throw new Error("Файл больше 20 МБ"); var data = migrateData(JSON.parse(await file.text()), true); if (!window.confirm("Заменить журнал выбранной резервной копией? Текущая версия будет сохранена для восстановления.")) return; saveRecoveryBackup(); restoreData(data); showToast("Резервная копия загружена", "success"); }
    catch (error) { showToast("Импорт отменён: " + error.message, "error"); } finally { e.target.value = ""; }
  });
  dom.debugButton.addEventListener("click", function () { dom.debugBlock.classList.toggle("open"); renderDebug(); }); dom.refreshDebugButton.addEventListener("click", renderDebug);
  dom.copyDebugButton.addEventListener("click", async function () { try { await navigator.clipboard.writeText(dom.debugPre.textContent); showToast("Диагностика скопирована", "success"); } catch (e) { showToast("Не удалось скопировать. Выделите текст вручную.", "warning"); } });
  document.addEventListener("keydown", function (e) {
    if (activeModal && e.key === "Tab") { var items = modalFocusables(), first = items[0], last = items[items.length - 1]; if (!items.length) return e.preventDefault(); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    if (e.key === "Escape" && activeModal) { e.preventDefault(); if (attendanceModalState.open) closeAttendanceModal(); else if (activeModal === dom.settingsPasswordModal) closePasswordModal(); else if (activeModal === dom.studentCardModal) closeStudentCard(); else if (activeModal === dom.devPanelModal) collapseDevPanel(); else closeModal(); }
    if (attendanceModalState.open && !e.ctrlKey && !e.metaKey && !e.altKey) { var statuses = { "1": STATUS_PRESENT, "2": STATUS_ABSENT, "3": STATUS_LATE, "0": STATUS_UNMARKED }; if (statuses[e.key]) { e.preventDefault(); setAttendanceStatus(statuses[e.key]); } }
  });
  window.addEventListener("storage", function (e) {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      var before = buildPayload(); if (!loadLocal()) return;
      var after = buildPayload(); renderOffline();
      if (!isDataEqual(before, after)) {
        state.revision++; render(); announceIncoming(before, after, "Из другой вкладки");
        if (syncRuntime.hasPendingChanges) scheduleSync();
      }
    }
    catch (error) { console.error("Ошибка чтения другой вкладки", error); }
  });
}
function init() {
  deviceId = getDeviceId(); var loaded = loadLocal(); loadSyncConfig(); loadInterval();
  try { if (dom.githubToken) dom.githubToken.value = syncConfig.token; if (dom.gistId) dom.gistId.value = syncConfig.gistId; if (dom.gistPublicCheckbox) dom.gistPublicCheckbox.checked = Boolean(syncConfig.isPublicGist); } catch (error) {}
  if (loaded && storage) { saveLocal(); }
  // The settings unlock flag is restored from localStorage below; only the
  // obsolete per-session flag from earlier builds is cleaned up here.
  try { if (sessStorage) sessStorage.removeItem("attendance_dev_unlocked"); } catch (error) {}
  try { if (!state.devUnlocked && storage && storage.getItem(SETTINGS_UNLOCK_KEY) === "1") state.devUnlocked = true; } catch (error) {}
  if (!storage) updateLocalStatus("Только в этой вкладке", true);
  loadViewPreference(); dom.intervalSelect.value = String(syncRuntime.pollIntervalMs); wireCoreEvents(); wireViewEvents(); wireProjectEvents(); wireAppUpdates(); updateSyncUI(); render(); applyRoleRestrictions();
  // Authentication gate: the very first opening of a device must show the
  // forced register/login screen. Only after a successful login (with 2FA)
  // or registration does the journal unlock for this device.
  wireAuthGate();
  ["authLogoutButton", "authAccountInfo"].forEach(function (id) { dom[id] = document.getElementById(id); });
  ["accountPanel", "accountCardBody", "accountChangeRoleButton", "accountLogoutButton", "accountBackButton"].forEach(function (id) { dom[id] = document.getElementById(id); });
  if (dom.accountBackButton) dom.accountBackButton.addEventListener("click", function () {
    closeAccountView();
    var nav = document.getElementById("glassNavigation");
    if (nav) nav.querySelectorAll("[data-nav]").forEach(function (item) {
      var on = item.dataset.nav === "journal";
      item.classList.toggle("is-active", on);
      if (on) item.setAttribute("aria-current", "location"); else item.removeAttribute("aria-current");
    });
  });
  if (dom.accountChangeRoleButton) dom.accountChangeRoleButton.addEventListener("click", changeOwnDeviceRole);
  if (dom.accountLogoutButton) dom.accountLogoutButton.addEventListener("click", function () {
    if (!confirm("Выйти из аккаунта на этом устройстве? Журнал снова потребует входа или регистрации.")) return;
    clearAuthSession(); state.devUnlocked = false;
    try { if (storage) storage.removeItem(SETTINGS_UNLOCK_KEY); } catch (error) {}
    setDeviceTechAdmin(deviceId, false); closeAccountView(); closeModal(); renderMaintenance(); openAuthGate(loadAuthAccounts().length ? "login" : "register");
    showToast("Вы вышли из аккаунта. Для продолжения нужен вход.", "info");
  });
  if (dom.authLogoutButton) dom.authLogoutButton.addEventListener("click", function () {
    if (!confirm("Выйти из аккаунта на этом устройстве? Журнал снова потребует входа или регистрации.")) return;
    clearAuthSession(); state.devUnlocked = false;
    try { if (storage) storage.removeItem(SETTINGS_UNLOCK_KEY); } catch (error) {}
    setDeviceTechAdmin(deviceId, false); closeModal(); renderMaintenance(); openAuthGate(loadAuthAccounts().length ? "login" : "register");
    showToast("Вы вышли из аккаунта. Для продолжения нужен вход.", "info");
  });
  if (!isDeviceAuthenticated()) { openAuthGate(loadAuthAccounts().length ? "login" : "register"); return; }
  // Read-only connection: a Gist ID without a token still downloads a public journal.
  if (syncReadOnly()) { fullSync("auto"); }
  if (syncWritable() && syncRuntime.pollIntervalMs > 0) { fullSync("auto"); startPolling(); }
}

// Presentation preferences remain local and are excluded from the synced diary.
var VIEW_PREFERENCE_KEY = "attendance_view_mode";
var DEFAULT_SETTINGS_ACCESS_CODE = "020912";
var SETTINGS_ACCESS_CODE = DEFAULT_SETTINGS_ACCESS_CODE;
var studentCardState = { studentId: "", month: "" };
state.selectedDate = formatDateKey(new Date());
state.viewMode = "month";
["viewSwitcher", "datePicker", "attendanceTableCard", "attendanceTableWrapper", "settingsPasswordModal", "settingsPasswordForm", "settingsPasswordInput", "settingsPasswordCancel", "settingsPasswordError", "studentCardModal", "studentCardName", "studentCardMonth", "studentCardPrev", "studentCardNext", "studentCardStats", "studentCardDays", "studentCardClose", "studentCardRename", "studentCardDelete"].forEach(function (id) { dom[id] = document.getElementById(id); });

function loadViewPreference() {
  var preferred = null;
  try { preferred = storage && storage.getItem(VIEW_PREFERENCE_KEY); } catch (error) {}
  state.viewMode = ["day", "week", "month"].includes(preferred) ? preferred : (window.matchMedia && window.matchMedia("(max-width: 700px)").matches ? "day" : "week");
}
function selectedDate() {
  if (!validDate(state.selectedDate) || state.selectedDate.slice(0, 7) !== state.selectedMonth) state.selectedDate = state.selectedMonth + "-01";
  return parseDateKey(state.selectedDate);
}
function setSelectedDate(date) {
  if (date.getFullYear() < 1000 || date.getFullYear() > 9999) return false;
  state.selectedDate = formatDateKey(date); state.selectedMonth = getMonthString(date); return true;
}
function getDisplayedDays() {
  var date = selectedDate();
  if (state.viewMode === "day") return [date];
  if (state.viewMode === "week") {
    date.setDate(date.getDate() - (date.getDay() + 6) % 7);
    var days = [];
    for (var i = 0; i < 7; i++) { var day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + i); if (day.getFullYear() >= 1000 && day.getFullYear() <= 9999) days.push(day); }
    return days;
  }
  return getDaysInMonth(state.selectedMonth);
}
function periodTitle(days) {
  if (state.viewMode === "month") { var date = parseMonth(state.selectedMonth); return monthNames[date.getMonth()] + " " + date.getFullYear(); }
  if (state.viewMode === "day") return days[0].toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  var first = days[0], last = days[days.length - 1];
  if (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear()) return first.getDate() + "–" + last.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  return first.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: first.getFullYear() !== last.getFullYear() ? "numeric" : undefined }) + " — " + last.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}
function renderViewControls(days) {
  dom.monthTitle.textContent = periodTitle(days);
  dom.monthPicker.value = state.selectedMonth; dom.datePicker.value = state.selectedDate;
  dom.monthPicker.hidden = state.viewMode !== "month"; dom.datePicker.hidden = state.viewMode === "month";
  dom.attendanceTableCard.dataset.view = state.viewMode;
  dom.journalApp.dataset.view = state.viewMode;
  dom.viewSwitcher.querySelectorAll("[data-view]").forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.view === state.viewMode)); });
  var previous = { day: "Предыдущий день", week: "Предыдущая неделя", month: "Предыдущий месяц" }, next = { day: "Следующий день", week: "Следующая неделя", month: "Следующий месяц" };
  dom.previousMonthButton.setAttribute("aria-label", previous[state.viewMode]); dom.nextMonthButton.setAttribute("aria-label", next[state.viewMode]);
  dom.attendanceTableWrapper.setAttribute("aria-label", "Таблица посещаемости. " + dom.monthTitle.textContent + (state.viewMode === "month" ? ". Прокрутите вправо, чтобы увидеть конец месяца." : ""));
}
function setViewMode(mode) {
  if (!["day", "week", "month"].includes(mode)) return;
  state.viewMode = mode; try { if (storage) storage.setItem(VIEW_PREFERENCE_KEY, mode); } catch (error) {}
  renderNow(); dom.attendanceTableWrapper.scrollLeft = 0;
}
function changePeriod(offset) {
  if (state.viewMode === "month") { changeMonth(offset); return; }
  var date = selectedDate(); date.setDate(date.getDate() + offset * (state.viewMode === "week" ? 7 : 1));
  if (setSelectedDate(date)) renderNow();
}
function goToToday() {
  setSelectedDate(new Date()); renderNow();
  var wrapper = dom.attendanceTableWrapper;
  if (state.viewMode !== "month") { wrapper.scrollLeft = 0; return; }
  requestAnimationFrame(function () {
    var today = dom.tableHead.querySelector('[data-date-key="' + state.selectedDate + '"]'), first = dom.tableHead.querySelector(".student-column");
    if (!today || !first) return;
    var left = today.getBoundingClientRect().left - wrapper.getBoundingClientRect().left + wrapper.scrollLeft - first.getBoundingClientRect().width - (wrapper.clientWidth - first.getBoundingClientRect().width - today.offsetWidth) / 2;
    wrapper.scrollTo({ left: Math.max(0, left), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
}

function openPasswordModal() {
  dom.settingsPasswordForm.reset(); dom.settingsPasswordError.textContent = ""; dom.settingsPasswordInput.removeAttribute("aria-invalid");
  openModal(dom.settingsPasswordModal, dom.settingsPasswordInput);
}
function closePasswordModal() { dom.settingsPasswordInput.value = ""; dom.settingsPasswordError.textContent = ""; closeModal(); }
function submitSettingsCode(event) {
  event.preventDefault();
  if (dom.settingsPasswordInput.value !== SETTINGS_ACCESS_CODE) { dom.settingsPasswordError.textContent = "Неверный код. Попробуйте ещё раз."; dom.settingsPasswordInput.setAttribute("aria-invalid", "true"); dom.settingsPasswordInput.value = ""; dom.settingsPasswordInput.focus(); return; }
  closePasswordModal(); state.devUnlocked = true;
  // The unlock survives tab closures until "Выйти из настроек" is pressed.
  try { if (storage) { storage.setItem(SETTINGS_UNLOCK_KEY, "1"); storage.setItem(SETTINGS_CODE_SET_KEY, String(Date.now())); } } catch (error) {}
  // Entering the settings password grants this device the tech-admin add-on:
  // full access to every function regardless of the assigned base role.
  var wasReadOnly = !effectivePermissions().canEditJournal;
  setDeviceTechAdmin(deviceId, true);
  // A device that was locked out (student/observer) automatically becomes a
  // teacher on unlock — the password proves an adult is holding the device.
  if (wasReadOnly) setDeviceRole(deviceId, "teacher");
  if (dom.journalEdition) dom.journalEdition.textContent = settingsVersionText();
  openDevPanel();
}

function openStudentCard(studentId) {
  var student = getStudentById(studentId); if (!student || student.deleted) return;
  studentCardState.studentId = studentId; studentCardState.month = getMonthString(selectedDate());
  renderStudentCard(); openModal(dom.studentCardModal, dom.studentCardClose);
}
function closeStudentCard() { closeModal(); studentCardState.studentId = ""; }
function changeStudentCardMonth(offset) {
  var date = parseMonth(studentCardState.month); date.setMonth(date.getMonth() + offset);
  if (date.getFullYear() < 1000 || date.getFullYear() > 9999) return;
  studentCardState.month = getMonthString(date); renderStudentCard();
}
function renderStudentCard() {
  if (!studentCardState.studentId) return;
  var student = getStudentById(studentCardState.studentId);
  if (!student || student.deleted) { dom.studentCardName.textContent = "Ученик удалён"; dom.studentCardDays.replaceChildren(); dom.studentCardStats.replaceChildren(); return; }
  var days = getDaysInMonth(studentCardState.month), date = days[0], counts = { present: 0, absent: 0, late: 0, unmarked: 0 };
  dom.studentCardName.textContent = student.name; dom.studentCardMonth.textContent = monthNames[date.getMonth()] + " " + date.getFullYear();
  var fragment = document.createDocumentFragment(), offset = (date.getDay() + 6) % 7;
  for (var i = 0; i < offset; i++) { var empty = element("span", "student-card-spacer"); empty.setAttribute("aria-hidden", "true"); fragment.appendChild(empty); }
  days.forEach(function (day) {
    var key = formatDateKey(day), entry = normalizeStatusEntry(state.attendance[student.id + "_" + key]), status = entry ? entry.status : STATUS_UNMARKED; counts[status]++;
    var button = element("button", "student-card-day " + status + (isToday(day) ? " is-today" : "")); button.type = "button"; button.dataset.cardDate = key;
    button.setAttribute("aria-label", day.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) + ": " + statusLabels[status]); if (isToday(day)) button.setAttribute("aria-current", "date");
    button.appendChild(element("span", "card-day-number", day.getDate())); button.appendChild(element("span", "card-day-status", statusSymbols[status])); fragment.appendChild(button);
  });
  dom.studentCardDays.replaceChildren(fragment);
  var stats = document.createDocumentFragment(); [["present", "Присутствия"], ["absent", "Пропуски"], ["late", "Онлайн"]].forEach(function (item) { var card = element("div", "card-stat " + item[0]); card.appendChild(element("strong", "", counts[item[0]])); card.appendChild(element("span", "", item[1])); stats.appendChild(card); }); dom.studentCardStats.replaceChildren(stats);
}
function wireViewEvents() {
  var navigation=document.getElementById("glassNavigation");
  if(navigation)navigation.addEventListener("click",function(event){
    var button=event.target.closest("[data-nav]");if(!button)return;
    var destination=button.dataset.nav;
    if(!["reports","settings"].includes(destination))navigation.querySelectorAll("[data-nav]").forEach(function(item){item.classList.toggle("is-active",item===button);if(item===button)item.setAttribute("aria-current","location");else item.removeAttribute("aria-current");});
    if(destination==="reports"){dom.reportsButton.click();return;}
    if(destination==="settings"){closeAccountView();dom.versionButton.click();return;}
    if(destination==="account"){openAccountView();return;}
    closeAccountView();
    var target=destination==="homework"?dom.hwPanel:document.getElementById("journalControls");
    if(destination==="homework")dom.hwPanel.open=true;
    if(target)target.scrollIntoView({behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"});
    if(destination==="students"){setStudentEntryOpen(true);dom.studentNameInput.focus({preventScroll:true});}
  });
  var addToggle=document.getElementById("toggleStudentEntryButton");
  if(addToggle)addToggle.addEventListener("click",function(){var open=addToggle.getAttribute("aria-expanded")!=="true";setStudentEntryOpen(open);if(open)dom.studentNameInput.focus();});
  dom.viewSwitcher.addEventListener("click", function (event) { var button = event.target.closest("[data-view]"); if (button) setViewMode(button.dataset.view); });
  dom.datePicker.addEventListener("change", function (event) { if (validDate(event.target.value)) { setSelectedDate(parseDateKey(event.target.value)); render(); } else event.target.value = state.selectedDate; });
  dom.settingsPasswordForm.addEventListener("submit", submitSettingsCode);
  dom.settingsPasswordCancel.addEventListener("click", closePasswordModal);
  dom.settingsPasswordInput.addEventListener("input", function () { dom.settingsPasswordError.textContent = ""; dom.settingsPasswordInput.removeAttribute("aria-invalid"); });
  dom.settingsPasswordModal.addEventListener("click", function (event) { if (event.target === dom.settingsPasswordModal) closePasswordModal(); });
  dom.studentCardClose.addEventListener("click", closeStudentCard);
  dom.studentCardModal.addEventListener("click", function (event) { if (event.target === dom.studentCardModal) closeStudentCard(); });
  dom.studentCardPrev.addEventListener("click", function () { changeStudentCardMonth(-1); }); dom.studentCardNext.addEventListener("click", function () { changeStudentCardMonth(1); });
  dom.studentCardDays.addEventListener("click", function (event) { var button = event.target.closest("[data-card-date]"); if (button) openAttendanceModal(studentCardState.studentId, button.dataset.cardDate); });
  dom.studentCardRename.addEventListener("click", function () { renameStudent(studentCardState.studentId); renderStudentCard(); });
  dom.studentCardDelete.addEventListener("click", function () { var id = studentCardState.studentId; removeStudent(id); var student = getStudentById(id); if (!student || student.deleted) closeStudentCard(); });
}

function setStudentEntryOpen(open){
  var form=document.getElementById("studentEntry"),button=document.getElementById("toggleStudentEntryButton");
  if(form)form.classList.toggle("is-expanded",open);
  if(button){button.setAttribute("aria-expanded",String(open));button.textContent=open?"Закрыть":"+ Ученик";}
}

/* Schema 5: lesson rosters are snapshots; daily legacy marks stay independent. */
var projectLists = ['classes', 'subjects', 'lessons'];
var homeworkListKey = 'homework'; // separate synced list: unlimited homework entries per class
var projectDomIds = ['classList','refreshClassListButton','classPicker','addClassButton','reportsButton','lessonsPanel','lessonDate','lessonSubject','lessonEnd','lessonStatus','lessonCreate','addSubjectButton','lessonList','lessonModal','lessonTitle','lessonRoster','lessonClose','lessonState','lessonDelete','studentClassPicker','studentClassMove'];
projectDomIds.forEach(function(id) { dom[id] = document.getElementById(id); });
['institutionList','addInstitutionButton','refreshInstitutionListButton','institutionBanner','institutionBannerText'].forEach(function(id){ dom[id]=document.getElementById(id); });
updateInstitutionBanner();
state.settings = cloneSettings(state.settings);
state.classes = [{ id: 'class-main', name: 'Основной класс', updatedAt: 0, actor: '', deleted: false }];
state.subjects = []; state.lessons = []; state.homework = []; state.lessonMarks = {}; state.selectedClass = 'class-main';
var activeLessonId = '';
function cleanClock(clock, time) {
  var result = {};
  if (clock && typeof clock === 'object' && !Array.isArray(clock)) Object.keys(clock).slice(0, 500).forEach(function(k) { var n=Number(clock[k]); if (validId(k) && Number.isFinite(n) && n>=0 && n<=Date.now()+86400000) result[k]=n; });
  if (!Object.keys(result).length && Number(time)>0) result.legacy = Number(time);
  return result;
}
function unionClocks(a,b) { var r=Object.assign({},a); Object.keys(b||{}).forEach(function(k){r[k]=Math.max(r[k]||0,b[k]);}); return r; }
function clockDominates(a,b) { var keys=new Set(Object.keys(a).concat(Object.keys(b))), greater=false, lesser=false; keys.forEach(function(k){if((a[k]||0)>(b[k]||0))greater=true;if((a[k]||0)<(b[k]||0))lesser=true;});return greater&&!lesser; }
var migrateBase = migrateData;
migrateData = function(data,strict) {
  var r=migrateBase(data,strict);
  projectLists.forEach(function(type) {
    var list=data && data[type];
    if (list!==undefined && !Array.isArray(list)) { if(strict)throw Error('Неверный список: '+type); list=[]; }
    if ((list||[]).length>100000)throw Error('Слишком много записей занятий');
    var seen=new Set();
    r[type]=(list||[]).map(function(v){
      if(!v||!validId(v.id)||seen.has(v.id))throw Error('Некорректная или повторная запись: '+type);
      seen.add(v.id);
      var x={id:v.id,updatedAt:timestamp(v.updatedAt,strict),actor:validId(v.actor)?v.actor:'',deleted:v.deleted===true,clock:cleanClock(v.clock,v.updatedAt)};
      if(type==='lessons'){
        if(!validId(v.classId)||!validId(v.subjectId)||!validDate(v.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.endTime)||!['planned','held','cancelled'].includes(v.status)||!Array.isArray(v.studentIds)||v.studentIds.length>10000||v.studentIds.some(function(id){return !validId(id);})||new Set(v.studentIds).size!==v.studentIds.length)throw Error('Некорректное занятие');
        Object.assign(x,{classId:v.classId,subjectId:v.subjectId,date:v.date,endTime:v.endTime,status:v.status,studentIds:v.studentIds.slice().sort()});
      } else {if(typeof v.name!=='string'||!v.name.trim()||v.name.length>200)throw Error('Некорректное название');x.name=v.name.trim();}
      return x;
    });
  });
  if(!r.classes.some(function(v){return v.id==='class-main';}))r.classes.push({id:'class-main',name:'Основной класс',updatedAt:0,actor:'',deleted:false,clock:{}});
  r.homework=[]; var hws=data&&data.homework;
  if(hws!==undefined&&!Array.isArray(hws)){if(strict)throw Error('Неверный список домашних заданий');hws=[];}
  if((hws||[]).length>100000)throw Error('Слишком много домашних заданий');
  var hwSeen=new Set();
  (hws||[]).forEach(function(v){
    if(!v||!validId(v.id)||hwSeen.has(v.id))throw Error('Некорректная или повторная запись: homework');
    hwSeen.add(v.id);
    if(!validId(v.classId)||!validDate(v.dueDate||v.date)||typeof v.text!=='string'||!v.text.trim()||v.text.length>4000)throw Error('Некорректное домашнее задание');
    r.homework.push({id:v.id,classId:v.classId,dueDate:validDate(v.dueDate)?v.dueDate:(validDate(v.date)?v.date:''),text:v.text,updatedAt:timestamp(v.updatedAt,strict),actor:validId(v.actor)?v.actor:'',deleted:v.deleted===true,clock:cleanClock(v.clock,v.updatedAt)});
  });
  r.lessonMarks={}; var marks=data&&data.lessonMarks||{};
  if(typeof marks!=='object'||Array.isArray(marks)||Object.keys(marks).length>500000)throw Error('Неверный список отметок занятий');
  Object.keys(marks).forEach(function(key){var parts=key.split('~');if(parts.length!==2||parts.some(function(k){return !validId(k);}))throw Error('Некорректный ключ отметки занятия');var v=normalizeStatusEntry(marks[key],strict);if(v)r.lessonMarks[key]=v;});
  return r;
};
var mergeBase=mergeData;
mergeData=function(a,b){var r=mergeBase(a,b);projectLists.concat([homeworkListKey]).forEach(function(k){r[k]=mergeStudents(a[k]||[],b[k]||[]);});r.lessonMarks=mergeAttendance(a.lessonMarks,b.lessonMarks);r.deviceMeta=mergeDeviceMeta(a.deviceMeta,b.deviceMeta);return r;};
var buildBase=buildPayload;
buildPayload=function(){var r=buildBase();projectLists.concat([homeworkListKey]).forEach(function(k){r[k]=copy(state[k]||[]);});r.lessonMarks=copy(state.lessonMarks||{});r.deviceMeta=copy(state.deviceMeta||{});return r;};
var applyBase=applyMergedToState;
applyMergedToState=function(data){applyBase(data);projectLists.concat([homeworkListKey]).forEach(function(k){state[k]=copy(data[k]||[]);});state.lessonMarks=copy(data.lessonMarks||{});state.deviceMeta=cleanDeviceMeta(data.deviceMeta);if(!state.classes.length)state.classes=migrateData({students:[],attendance:{}}).classes;trackedPayload=buildPayload();};
function restoreProjectData(data,current,time){
  projectLists.concat([homeworkListKey]).forEach(function(k){data[k]=data[k]||[];var ids=new Set(data[k].map(function(v){return v.id;}));(current[k]||[]).forEach(function(v){if(!ids.has(v.id))data[k].push(Object.assign({},v,{deleted:true}));});data[k].forEach(function(v){v.updatedAt=time;v.actor=deviceId;});});
  Object.keys(current.lessonMarks||{}).forEach(function(k){if(!data.lessonMarks[k])data.lessonMarks[k]={status:'unmarked'};});Object.values(data.lessonMarks).forEach(function(v){v.updatedAt=time;v.actor=deviceId;});
}
function named(type,id){var v=(state[type]||[]).find(function(x){return x.id===id;});return v?v.name:id;}
function el(tag,text,cls){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function fillSelect(node,items,all){var value=node.value;node.replaceChildren();if(all)node.appendChild(new Option(all,''));items.filter(function(x){return !x.deleted;}).forEach(function(x){node.appendChild(new Option(x.name,x.id));});if(Array.from(node.options).some(function(o){return o.value===value;}))node.value=value;}
function commitProject(keys){if(!effectivePermissions().canEditJournal){showToast('Роль «'+DEVICE_ROLES[deviceRole(deviceId)].label+'»: изменения недоступны','warning');return;}markChanged(keys);scheduleSaveLocal();render();scheduleSync();}
function createNamed(type){if(!effectivePermissions().canEditJournal)return showToast('Роль «'+DEVICE_ROLES[deviceRole(deviceId)].label+'»: добавление недоступно','warning');var name=window.prompt(type==='classes'?'Название класса':'Название предмета');if(name===null)return;name=name.trim();if(!name||name.length>200)return showToast('Введите название до 200 символов','warning');var existing=state[type].find(function(x){return !x.deleted&&x.name.toLowerCase()===name.toLowerCase();});if(existing)return showToast('Такое название уже есть','warning');var item={id:generateId(),name:name,updatedAt:nextTimestamp(),actor:deviceId,deleted:false};state[type].push(item);if(type==='classes')state.selectedClass=item.id;commitProject([type+'/'+item.id]);if(type==='subjects'&&dom.lessonSubject)dom.lessonSubject.value=item.id;}
/* ---------- Class management in the settings panel ---------- */
// Deleting a class soft-deletes it (tombstone) so the change merges across all
// synced devices like any other record. Its students, lessons and homework are
// removed together with the class; attendance history stays inside the recovery
// backup saved right before the deletion. Allowed for teacher and tech admin
// (effectivePermissions().canEditJournal). The default 'class-main' cannot be
// deleted — it always exists as a fallback container for records.
function liveClassStats(id){
  var students=(state.students||[]).filter(function(s){return !s.deleted&&(s.classId||'class-main')===id;}).length;
  var lessons=(state.lessons||[]).filter(function(l){return !l.deleted&&l.classId===id;}).length;
  var hw=(state.homework||[]).filter(function(h){return !h.deleted&&h.classId===id;}).length;
  return {students:students,lessons:lessons,hw:hw};
}
function renderClassList(){
  var container=dom.classList; if(!container)return;
  var classes=(state.classes||[]).filter(function(c){return !c.deleted;}).sort(function(a,b){return a.name.localeCompare(b.name,'ru');});
  var canManage=effectivePermissions().canEditJournal;
  if(!classes.length){container.innerHTML='<p class="help-text">Список классов пуст.</p>';return;}
  container.textContent='';
  classes.forEach(function(cls){
    var row=document.createElement('div'); row.className='device-row class-row';
    var info=document.createElement('div');
    var name=document.createElement('span'); name.className='device-name'; name.textContent=cls.name; info.appendChild(name);
    if(cls.id==='class-main'){var badge=document.createElement('span');badge.className='device-badge';badge.textContent='базовый';info.appendChild(badge);}
    if((state.selectedClass||'class-main')===cls.id){var cur=document.createElement('span');cur.className='device-badge';cur.textContent='открыт';info.appendChild(cur);}
    var stats=liveClassStats(cls.id);
    var meta=document.createElement('span'); meta.className='device-seen';
    meta.textContent='Учеников: '+stats.students+' · занятий: '+stats.lessons+' · заданий: '+stats.hw;
    row.appendChild(info); row.appendChild(meta);
    var remove=document.createElement('button'); remove.type='button'; remove.className='danger class-remove';
    remove.dataset.classId=cls.id; remove.textContent='Удалить класс';
    remove.disabled=!canManage||cls.id==='class-main';
    remove.title=cls.id==='class-main'?'Базовый класс «'+cls.name+'» нельзя удалить':(canManage?'Удалить класс вместе с учениками, занятиями и заданиями':'Удалять классы могут только учитель или тех. администрация');
    row.appendChild(remove);
    var rename=document.createElement('button'); rename.type='button'; rename.className='secondary class-rename';
    rename.dataset.classId=cls.id; rename.textContent='Переименовать';
    rename.disabled=!canManage;
    rename.title=canManage?'Изменить название класса (синхронизируется на всех устройствах)':'Переименовывать классы могут только учитель или тех. администрация';
    row.appendChild(rename);
    container.appendChild(row);
  });
}
// Rename a class in place (works for the base 'class-main' too). The name is a
// normal synced record field, so the new name merges to every connected device.
function renameClass(id){
  if(!effectivePermissions().canEditJournal){showToast('Переименование классов доступно учителю или тех. администрации','warning');return false;}
  var cls=(state.classes||[]).find(function(c){return c.id===id&&!c.deleted;});
  if(!cls){showToast('Класс не найден — обновите список','warning');renderClassList();return false;}
  var name=window.prompt('Название класса',cls.name); if(name===null)return false;
  name=name.trim().replace(/\s+/g,' ');
  if(!name||name.length>200){showToast('Введите название до 200 символов','warning');return false;}
  if(name.toLowerCase()===cls.name.trim().toLowerCase())return false;
  var dup=(state.classes||[]).some(function(c){return !c.deleted&&c.id!==id&&c.name.trim().toLowerCase()===name.toLowerCase();});
  if(dup){showToast('Класс с таким названием уже есть','warning');return false;}
  cls.name=name;cls.updatedAt=nextTimestamp();cls.actor=deviceId;
  commitProject(['classes/'+cls.id]);
  if(activeModal===dom.devPanelModal)renderClassList();
  showToast('Класс переименован в «'+name+'»','success');
  return true;
}
function removeClass(id){
  var perms=effectivePermissions();
  if(!perms.canEditJournal){showToast('Удаление классов доступно учителю или тех. администрации','warning');return false;}
  if(id==='class-main'){showToast('Базовый класс «Основной класс» удалить нельзя','warning');return false;}
  var cls=(state.classes||[]).find(function(c){return c.id===id;});
  if(!cls||cls.deleted){showToast('Класс не найден — обновите список','warning');renderClassList();return false;}
  var stats=liveClassStats(id);
  var warning='Удалить класс «'+cls.name+'»?\nВместе с классом будут удалены: ученики ('+stats.students+'), занятия ('+stats.lessons+'), домашние задания ('+stats.hw+').\nПеред удалением будет сохранена резервная копия.';
  if(!window.confirm(warning))return false;
  // Second confirmation typed manually — deletion affects many records.
  var word=window.prompt('Необратимое действие (отменить можно только восстановлением копии).\nДля подтверждения введите название класса точно:\n'+cls.name);
  if(word===null){showToast('Удаление отменено','info');return false;}
  if(word.trim().toLowerCase()!==cls.name.trim().toLowerCase()){showToast('Название не совпало — удаление отменено','info');return false;}
  try{saveRecoveryBackup();}catch(e){showToast('Удаление отменено: '+e.message,'error');return false;}
  var time=nextTimestamp(),keys=[];
  cls.deleted=true;cls.updatedAt=time;cls.actor=deviceId;keys.push('classes/'+cls.id);
  (state.students||[]).forEach(function(st){if(!st.deleted&&(st.classId||'class-main')===id){st.deleted=true;st.updatedAt=time;st.actor=deviceId;keys.push('students/'+st.id);}});
  (state.lessons||[]).forEach(function(l){if(!l.deleted&&l.classId===id){l.deleted=true;l.updatedAt=time;l.actor=deviceId;keys.push('lessons/'+l.id);}});
  (state.homework||[]).forEach(function(h){if(!h.deleted&&h.classId===id){h.deleted=true;h.updatedAt=time;h.actor=deviceId;keys.push(homeworkListKey+'/'+h.id);}});
  if(state.selectedClass===id)state.selectedClass='class-main';
  commitProject(keys);
  if(activeModal===dom.devPanelModal)renderClassList();
  showToast('Класс «'+cls.name+'» удалён. Доступно восстановление из копии.','success');
  return true;
}
function createLesson(){
  if(!effectivePermissions().canEditJournal)return showToast('Роль «'+DEVICE_ROLES[deviceRole(deviceId)].label+'»: занятия недоступны','warning');
  var date=dom.lessonDate.value,subject=dom.lessonSubject.value,end=dom.lessonEnd.value,status=dom.lessonStatus.value;
  if(!validDate(date)||!subject||!/^([01]\d|2[0-3]):[0-5]\d$/.test(end))return showToast('Укажите дату, предмет и время окончания','warning');
  var roster=getVisibleStudents().map(function(s){return s.id;}).sort();if(!roster.length)return showToast('Сначала добавьте учеников в выбранный класс','warning');
  var lesson={id:generateId(),classId:state.selectedClass,subjectId:subject,date:date,endTime:end,status:status,studentIds:roster,updatedAt:nextTimestamp(),actor:deviceId,deleted:false};state.lessons.push(lesson);commitProject(["lessons/"+lesson.id]);openLesson(lesson.id);
}
function openLesson(id){activeLessonId=id;renderLesson();openModal(dom.lessonModal,dom.lessonState);}
function renderLesson(){
  var focus=document.activeElement,focusedStudent=focus&&focus.dataset&&focus.dataset.lessonStudent;
  var lesson=state.lessons.find(function(l){return l.id===activeLessonId;});if(!lesson||lesson.deleted){if(activeModal===dom.lessonModal)closeModal();return;}
  dom.lessonTitle.textContent=named('subjects',lesson.subjectId)+' · '+lesson.date+' · '+lesson.endTime;dom.lessonState.value=lesson.status;dom.lessonRoster.replaceChildren();
  lesson.studentIds.slice().sort(function(a,b){return named('students',a).localeCompare(named('students',b),'ru');}).forEach(function(id){var student=getStudentById(id),row=el('label',undefined,'lesson-roster-row'),name=el('span',student?student.name:'Удалённый ученик'),select=el('select');Object.keys(statusLabels).forEach(function(s){select.appendChild(new Option(statusLabels[s],s));});select.value=(state.lessonMarks[lesson.id+'~'+id]||{}).status||'unmarked';select.dataset.lessonStudent=id;select.setAttribute('aria-label',(student?student.name:id)+': отметка');select.addEventListener('change',function(){state.lessonMarks[lesson.id+'~'+id]={status:select.value,updatedAt:nextTimestamp(),actor:deviceId};commitProject(['lessonMarks/'+lesson.id+'~'+id]);});row.append(name,select);dom.lessonRoster.appendChild(row);});
  if(focusedStudent){var replacement=dom.lessonRoster.querySelector('[data-lesson-student="'+focusedStudent+'"]');if(replacement)replacement.focus({preventScroll:true});}
}
function renderProject(){
  if(dom.classPicker){
    fillSelect(dom.classPicker,state.classes);dom.classPicker.value=state.selectedClass;
  }
  if(dom.lessonSubject)fillSelect(dom.lessonSubject,state.subjects);
  if(dom.studentClassPicker){
    fillSelect(dom.studentClassPicker,state.classes);
    var card=getStudentById(typeof studentCardState!=='undefined'?studentCardState.studentId:'');if(card)dom.studentClassPicker.value=card.classId||'class-main';
  }
  if(dom.lessonCreate)dom.lessonCreate.disabled=!state.subjects.some(function(s){return !s.deleted;});
  if(dom.lessonList&&dom.lessonDate){
    dom.lessonList.replaceChildren();var lessons=state.lessons.filter(function(l){return !l.deleted&&l.classId===state.selectedClass&&l.date===dom.lessonDate.value;}).sort(function(a,b){return a.endTime.localeCompare(b.endTime);});
    if(!lessons.length)dom.lessonList.appendChild(el('p','На выбранную дату занятий нет.','help-text'));
    lessons.forEach(function(l){var b=el('button',named('subjects',l.subjectId)+' · до '+l.endTime+' · '+({planned:'Запланировано',held:'Проведено',cancelled:'Отменено'}[l.status]),'secondary lesson-list-item');b.type='button';b.addEventListener('click',function(){openLesson(l.id);});dom.lessonList.appendChild(b);});
  }
  if(activeModal===dom.reportsModal)renderReports();
  if(activeModal===dom.lessonModal)renderLesson();
}
function wireProjectEvents(){
  // The lesson-creation UI (lessonDate/lessonEnd/lessonsPanel) was removed from
  // the markup, so every project control must be guarded against missing nodes.
  if(dom.lessonDate)dom.lessonDate.value=formatDateKey(new Date());
  if(dom.lessonEnd)dom.lessonEnd.value='14:00';
  if(dom.classPicker)dom.classPicker.addEventListener('change',function(){state.selectedClass=dom.classPicker.value;render();});
  if(dom.addClassButton)dom.addClassButton.addEventListener('click',function(){createNamed('classes');});
  if(dom.addSubjectButton)dom.addSubjectButton.addEventListener('click',function(){createNamed('subjects');});
  if(dom.lessonDate)dom.lessonDate.addEventListener('change',renderProject);
  if(dom.lessonCreate)dom.lessonCreate.addEventListener('click',createLesson);
  if(dom.lessonClose)dom.lessonClose.addEventListener('click',closeModal);
  if(dom.lessonState)dom.lessonState.addEventListener('change',function(){var l=state.lessons.find(function(x){return x.id===activeLessonId;});if(l){l.status=dom.lessonState.value;l.updatedAt=nextTimestamp();l.actor=deviceId;commitProject(["lessons/"+l.id]);}});
  if(dom.lessonDelete)dom.lessonDelete.addEventListener('click',function(){var l=state.lessons.find(function(x){return x.id===activeLessonId;});if(l&&confirm('Удалить это занятие?')){try{saveRecoveryBackup();}catch(e){return showToast(e.message,'error');}l.deleted=true;l.updatedAt=nextTimestamp();l.actor=deviceId;closeModal();commitProject(["lessons/"+l.id]);}});
  if(dom.studentClassMove&&dom.studentClassPicker)dom.studentClassMove.addEventListener('click',function(){var s=getStudentById(studentCardState.studentId);if(s&&s.classId!==dom.studentClassPicker.value){s.classId=dom.studentClassPicker.value;s.updatedAt=nextTimestamp();s.actor=deviceId;commitProject(['students/'+s.id]);showToast('Класс изменён. История занятий сохранена.','success');}});
  if(dom.hwAddButton)dom.hwAddButton.addEventListener('click',addHomeworkEntry);
  // Enter adds the entry like a form submit; Shift+Enter inserts a line break.
  if(dom.hwText)dom.hwText.addEventListener('keydown',function(event){
    if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();addHomeworkEntry();}
  });
  if(dom.hwPinButton)dom.hwPinButton.addEventListener('click',addHomeworkEntry); // same action, kept for compatibility
  if(dom.hwClearButton)dom.hwClearButton.addEventListener('click',clearClassHomework);
  if(dom.refreshDeviceListButton)dom.refreshDeviceListButton.addEventListener('click',function(){refreshDeviceList();});
  if(dom.syncDeviceList)dom.syncDeviceList.addEventListener('change',function(event){
    var roleSelect=event.target.closest('.device-role');
    if(roleSelect&&roleSelect.dataset.deviceId){setDeviceRole(roleSelect.dataset.deviceId,roleSelect.value);return;}
    var techFlag=event.target.closest('.device-tech-flag');
    if(techFlag&&techFlag.dataset.deviceId){setDeviceTechAdmin(techFlag.dataset.deviceId,!deviceTechAdmin(techFlag.dataset.deviceId));return;}
    var input=event.target.closest('.device-input');if(!input||!input.dataset.deviceId)return;
    var id=input.dataset.deviceId,name=(input.value||'').trim().slice(0,40);
    var meta=state.deviceMeta||(state.deviceMeta={});var entry=meta[id]||(meta[id]={seenAt:0});
    if(id!==deviceId&&!syncWritable())return showToast('Переименование других устройств требует токен для отправки','warning');
    entry.name=name;entry.seenAt=Math.max(entry.seenAt||0,id===deviceId?Date.now():0);
    saveLocal();scheduleSync();renderDeviceList();showToast(name?'Имя устройства сохранено':'Имя устройства очищено','success');
  });
  wireReportEvents();wireOfflineEvents();
}

["hwPanel","hwDueDate","hwClassName","hwText","hwPinButton","hwClearButton","hwAddButton","hwHistory","syncDeviceList","refreshDeviceListButton","roleBanner"].forEach(function(id){dom[id]=document.getElementById(id);});
["authGate","authTitle","authSubtitle","authTabRegister","authTabLogin","authRegisterForm","authLoginForm","authRegFirst","authRegLast","authRegPass1","authRegPass2","authRegisterError","authRegisterSubmit","authLoginName","authLoginPass","authPhone","authSmsRow","authSmsCode","authSmsHint","authSecretWord","authLoginError","authLoginSubmit","authFootnote","authSyncPanel","authSyncOpenButton","authSyncCloseButton","authSyncToken","authSyncGist","authSyncPublic","authSyncWarning","authSyncError","authSyncStatus","authSyncTestButton","authSyncSaveButton"].forEach(function(id){dom[id]=document.getElementById(id);});
if (dom.authSmsRow === undefined || dom.authSmsRow === null) { var smsEl = document.querySelector(".auth-sms-row"); if (smsEl) dom.authSmsRow = smsEl; }

/* Homework: unlimited entries pinned per class. Each entry is an item of the
 * synced "homework" list (id/classId/date/text), so a class can hold any number
 * of assignments and they merge across devices like students do. */
function currentHomework(){var cls=state.selectedClass||'class-main';return (state.homework||[]).filter(function(h){return !h.deleted&&h.classId===cls;}).sort(function(a,b){return (b.dueDate||'').localeCompare(a.dueDate||'')||b.updatedAt-a.updatedAt;});}
function addHomeworkEntry(){
  if(syncReadOnly()){showToast('Режим «только чтение»: подключите токен, чтобы добавлять домашние задания','warning');return;}
  // Guard every node used here: a missing control must never abort the action.
  if(!dom.hwText||!dom.hwText.isConnected)return showToast('Панель домашних заданий недоступна','error');
  var text=(dom.hwText.value||'').trim();if(!text)return showToast('Напишите текст домашнего задания','warning');
  if(text.length>4000)return showToast('Слишком длинное задание (до 4000 символов)','warning');
  var date=dom.hwDueDate&&dom.hwDueDate.value?dom.hwDueDate.value:'';if(!validDate(date))date=formatDateKey(new Date());
  var cls=state.selectedClass||'class-main';
  if(!Array.isArray(state.homework))state.homework=[];
  var entry={id:generateId(),classId:cls,dueDate:date,text:text,updatedAt:nextTimestamp(),actor:deviceId,deleted:false};
  state.homework.push(entry);commitProject(['homework/'+entry.id]);dom.hwText.value='';
  showToast('Домашнее задание добавлено','success');
}
function deleteHomeworkEntry(id){
  if(syncReadOnly())return showToast('Режим «только чтение»: изменения недоступны','warning');
  var h=(state.homework||[]).find(function(v){return v.id===id&&!v.deleted;});if(!h)return;
  if(!confirm('Убрать это домашнее задание?'))return;
  try{saveRecoveryBackup();}catch(e){return showToast(e.message,'error');}
  h.deleted=true;h.updatedAt=nextTimestamp();h.actor=deviceId;commitProject(['homework/'+h.id]);
}
function clearClassHomework(){
  if(syncReadOnly())return showToast('Режим «только чтение»: изменения недоступны','warning');
  var items=currentHomework();if(!items.length)return showToast('У этого класса нет закреплённых заданий','info');
  if(!confirm('Убрать все домашние задания этого класса ('+items.length+')?'))return;
  try{saveRecoveryBackup();}catch(e){return showToast(e.message,'error');}
  var keys=[];items.forEach(function(h){h.deleted=true;h.updatedAt=nextTimestamp();h.actor=deviceId;keys.push('homework/'+h.id);});
  commitProject(keys);showToast('Задания убраны','success');
}
function renderHomework(){
  lastHomeworkSig = null; // direct callers bypass the flushRender cache
  if(!dom.hwPanel||!dom.hwPanel.isConnected)return;
  var cls=state.selectedClass||'class-main';
  if(dom.hwClassName)dom.hwClassName.textContent=named('classes',cls);
  if(dom.hwDueDate&&!dom.hwDueDate.value)dom.hwDueDate.value=formatDateKey(new Date());
  if(dom.hwPinButton)dom.hwPinButton.disabled=syncReadOnly();
  if(dom.hwAddButton)dom.hwAddButton.disabled=syncReadOnly();
  if(dom.hwClearButton)dom.hwClearButton.disabled=syncReadOnly()||!currentHomework().length;
  if(!dom.hwHistory||!dom.hwHistory.isConnected)return;
  dom.hwHistory.replaceChildren();
  var items=currentHomework();
  if(!items.length){dom.hwHistory.appendChild(el('p','Для этого класса пока нет домашних заданий.','help-text'));return;}
  items.forEach(function(h){
    // Fixed-size circular delete button: flex item must never stretch or shrink.
    var del=el('button','×','secondary icon-button hw-delete');del.type='button';del.title='Убрать это задание';del.setAttribute('aria-label','Убрать это задание');
    del.addEventListener('click',function(){deleteHomeworkEntry(h.id);});
    var row=el('div',undefined,'lesson-list-item hw-item');
    var main=el('div',undefined,'hw-main');
    var dueTxt=h.dueDate?new Date(h.dueDate+'T00:00:00').toLocaleDateString('ru-RU'):'не указана';var overdue=!!h.dueDate&&h.dueDate<formatDateKey(new Date());var meta=el('span',(overdue?'⚠ Просрочено · ':'')+'Сдать к: '+dueTxt+' · добавлено '+new Date(h.updatedAt).toLocaleDateString('ru-RU'),'hw-meta'+(overdue?' hw-overdue':''));
    var body=el('span',h.text,'hw-text');
    main.append(body,meta);
    row.append(main,del);dom.hwHistory.appendChild(row);
  });
}

var renderCardBase = renderStudentCard;
renderStudentCard = function(){renderCardBase();var card=getStudentById(studentCardState.studentId);if(card&&dom.studentClassPicker){fillSelect(dom.studentClassPicker,state.classes);dom.studentClassPicker.value=card.classId||'class-main';}};

/* The outbox is local-only. Acknowledgements carry operation IDs, so a delayed
 * PATCH cannot erase a newer edit and another tab cannot resurrect old entries. */
var offline={queue:{},conflicts:{}}, trackedPayload=buildPayload();
['offlineStatus','queueCount','lastSyncTime','queueList','conflictList','offlineDetails'].forEach(function(id){dom[id]=document.getElementById(id);});
function flattenRecords(data){var r={};['students'].concat(projectLists,[homeworkListKey]).forEach(function(k){(data[k]||[]).forEach(function(v){r[k+'/'+v.id]=copy(v);if(k==='students')r[k+'/'+v.id].classId=v.classId||'class-main';});});['attendance','lessonMarks'].forEach(function(k){Object.keys(data[k]||{}).forEach(function(id){r[k+'/'+id]=copy(data[k][id]);});});settingFields.forEach(function(f){r['settings/'+f]=Object.assign({value:data.settings[f]},data.settings.fieldMeta[f]);});return r;}
function recordValue(v){if(!v)return null;var r=copy(v);delete r.clock;delete r.updatedAt;delete r.actor;return r;}
function putRecord(data,key,value){var pos=key.indexOf('/'),kind=key.slice(0,pos),id=key.slice(pos+1);if(kind==='settings'){data.settings[id]=value.value;data.settings.fieldMeta[id]={updatedAt:value.updatedAt,actor:value.actor,clock:value.clock};data.settings.updatedAt=Math.max(data.settings.updatedAt,value.updatedAt);}else if(kind==='attendance'||kind==='lessonMarks')data[kind][id]=copy(value);else{var i=data[kind].findIndex(function(x){return x.id===id;});if(i<0)data[kind].push(copy(value));else data[kind][i]=copy(value);}}
function causalActor(){return (deviceId+"_"+syncRuntime.tabWriterId).slice(0,100);}
function mergeOffline(other,skipConflicts){if(!other||typeof other!=='object')return;Object.keys(other.queue||{}).forEach(function(k){var a=offline.queue[k],b=other.queue[k];if(!b||typeof b.op!=='string'||!Number.isFinite(b.time))return;if(!a||b.time>a.time||(b.time===a.time&&b.op>a.op))offline.queue[k]=copy(b);else if(a.op===b.op&&b.done)a.done=true;});Object.keys(skipConflicts?{}:other.conflicts||{}).forEach(function(k){offline.conflicts[k]=(offline.conflicts[k]||[]).concat(copy(other.conflicts[k]));});}
function migrateLegacyQueue(parsed,data){if(parsed._offline||!parsed.pendingChanges)return;var flat=flattenRecords(data);Object.keys(flat).forEach(function(k){var v=flat[k];if(k.indexOf('settings/')===0&&!v.updatedAt)return;if(k==='classes/class-main'&&!v.updatedAt)return;if(!offline.queue[k]){var t=nextTimestamp();offline.queue[k]={op:generateId()+'-'+t,time:t,done:false};}});}
function queuedEntries(){return Object.keys(offline.queue).filter(function(k){return !offline.queue[k].done;});}
function getRecord(data,key){
  var pos=key.indexOf('/'),kind=key.slice(0,pos),id=key.slice(pos+1);
  if(kind==='settings')return Object.assign({value:data.settings[id]},data.settings.fieldMeta[id]);
  if(kind==='attendance'||kind==='lessonMarks')return data[kind][id];
  return (data[kind]||[]).find(function(v){return v.id===id;});
}
markChanged=function(keys){
  // Ordinary edits touch one record; imports still use the complete diff.
  var data=keys?state:buildPayload(),before=trackedPayload||{},after=keys?null:flattenRecords(data);
  (keys||Object.keys(after)).forEach(function(k){
    var previous=getRecord(before,k),current=keys?getRecord(data,k):after[k];
    if(isDataEqual(recordValue(current),recordValue(previous)))return;
    var v=copy(current),t=nextTimestamp();
    v.clock=unionClocks(cleanClock(previous&&previous.clock,previous&&previous.updatedAt),cleanClock(v.clock,0));
    v.clock[causalActor()]=t;v.updatedAt=t;v.actor=deviceId;
    putRecord(data,k,v);if(keys)putRecord(trackedPayload,k,v);
    offline.queue[k]={op:generateId()+'-'+t,time:t,done:false};
  });
  if(!keys)applyMergedToState(data);
  state.revision++;syncRuntime.hasPendingChanges=queuedEntries().length>0;renderOffline();
};
function acknowledgeQueue(sent){Object.keys(sent).forEach(function(k){if(offline.queue[k]&&offline.queue[k].op===sent[k].op)offline.queue[k].done=true;});}
function queueSnapshot(){return copy(offline.queue);}
function recordLabel(key){var p=key.indexOf('/'),type=key.slice(0,p),id=key.slice(p+1);if(type==='students')return 'Ученик: '+named('students',id);if(type==='classes')return 'Класс: '+named(type,id);if(type==='subjects')return 'Предмет: '+named(type,id);if(type==='attendance'){var at=id.lastIndexOf('_');return named('students',id.slice(0,at))+' · '+id.slice(at+1);}if(type==='lessonMarks'){var parts=id.split('~'),lesson=state.lessons.find(function(l){return l.id===parts[0];});return named('students',parts[1])+(lesson?' · '+named('subjects',lesson.subjectId)+' · '+lesson.date:' · отметка занятия');}if(type==='lessons'){var l=state.lessons.find(function(v){return v.id===id;});return l?'Занятие: '+named('subjects',l.subjectId)+' · '+l.date:'Занятие';}if(type==='homework')return 'Домашнее задание для класса: '+named('classes',id);return 'Настройка: '+({news:'Объявление',maintenance:'Обслуживание',maintenanceMessage:'Сообщение',maintenanceBy:'Устройство',versionText:'Версия'}[id]||id);}
function variantText(v){if(v.deleted)return 'Удалено';if(v.status&&statusLabels[v.status])return statusLabels[v.status];if(v.name)return v.name+(v.classId?' · '+named('classes',v.classId):'');if(v.text)return String(v.text).slice(0,60)+(v.classId?' · '+named('classes',v.classId):'');if(v.date)return v.date+' '+v.endTime+' · '+({held:'Проведено',planned:'Запланировано',cancelled:'Отменено'}[v.status])+' · '+v.studentIds.length+' учеников';return String(v.value);}
function collectConflicts(payloads,carry){
  var versions={};payloads.forEach(function(p){var flat=flattenRecords(p);Object.keys(flat).forEach(function(k){(versions[k]||(versions[k]=[])).push(flat[k]);});});Object.keys(carry||{}).forEach(function(k){versions[k]=(versions[k]||[]).concat(carry[k]);});var conflicts={};
  Object.keys(versions).forEach(function(k){var all=versions[k].map(function(v){return k==='settings/versionText'?Object.assign({},v,{value:normalizeDefaultVersion(v.value,v)}):v;}),unique=[];all.forEach(function(v){if(!unique.some(function(u){return isDataEqual(u,v);}))unique.push(v);});var top=unique.filter(function(v){return !unique.some(function(u){return clockDominates(cleanClock(u.clock,u.updatedAt),cleanClock(v.clock,v.updatedAt));});});if(top.length>1&&top.some(function(v){return !isDataEqual(recordValue(v),recordValue(top[0]));}))conflicts[k]=top;});return conflicts;
}
function reconcileLocalConflicts(incoming){offline.conflicts=collectConflicts([buildPayload(),incoming],offline.conflicts);}
function checkSyncConflicts(remote,local){
  var conflicts=collectConflicts((remote.sources||[remote.data]).concat(local?[local]:[]),local?offline.conflicts:{});offline.conflicts=conflicts;
  if(Object.keys(conflicts).length){
    if(local){var safe=mergeData(local,remote.data);Object.keys(conflicts).forEach(function(k){var v=getRecord(local,k);if(v)putRecord(safe,k,v);});syncApply(safe);}
    saveLocal();renderOffline();syncRuntime.lastConflictRevision=state.revision;var error=Error('Есть конфликтующие изменения. Выберите нужные записи в очереди синхронизации.');error.noRetry=true;error.conflict=true;throw error;}
}
function resolveConflict(key,index){var choices=offline.conflicts[key];if(!choices||!choices[index])return;var selected=copy(choices[index]),clock={};choices.forEach(function(v){clock=unionClocks(clock,cleanClock(v.clock,v.updatedAt));});var time=nextTimestamp();clock[causalActor()]=time;selected.clock=clock;selected.updatedAt=time;selected.actor=deviceId;var data=buildPayload();putRecord(data,key,selected);applyMergedToState(data);offline.queue[key]={op:generateId()+'-'+time,time:time,done:false};delete offline.conflicts[key];state.revision++;syncRuntime.hasPendingChanges=true;scheduleSaveLocal();render();scheduleSync();showToast('Выбранная запись сохранена и ожидает отправки','success');}
var offlineListSignature="";
function renderOfflineNow(){if(!dom.queueCount)return;var count=queuedEntries().length,conflicts=Object.keys(offline.conflicts);dom.queueCount.textContent=String(count);dom.lastSyncTime.textContent=formatTime(syncConfig.lastSync);dom.offlineStatus.textContent=conflicts.length?'Нужен выбор: конфликтов '+conflicts.length:!syncOnline()?'Нет интернета · изменения сохраняются здесь':count?(syncConfigured()?(syncRuntime.pollIntervalMs===0?'Изменения ждут ручной отправки':'Изменения ожидают отправки'):'Изменения сохранены · подключите синхронизацию'):(syncConfigured()?'Все изменения отправлены':'Сохранено только на этом устройстве');dom.offlineStatus.classList.toggle('has-conflicts',!!conflicts.length);var signature=JSON.stringify([offline.queue,offline.conflicts]);
if(signature===offlineListSignature)return;offlineListSignature=signature;
dom.queueList.replaceChildren();queuedEntries().sort(function(a,b){return offline.queue[b].time-offline.queue[a].time;}).slice(0,100).forEach(function(k){dom.queueList.appendChild(el('li',recordLabel(k)+' · '+formatTime(offline.queue[k].time)));});if(count>100)dom.queueList.appendChild(el('li','Показаны последние 100 из '+count+' записей'));dom.conflictList.replaceChildren();conflicts.forEach(function(k){var box=el('article',undefined,'conflict-card');box.appendChild(el('strong',recordLabel(k)));offline.conflicts[k].forEach(function(v,i){var b=el('button',variantText(v)+' · '+formatTime(v.updatedAt)+(v.actor===deviceId?' · это устройство':' · другое устройство'),'secondary');b.type='button';b.addEventListener('click',function(){resolveConflict(k,i);});box.appendChild(b);});dom.conflictList.appendChild(box);});if(conflicts.length)dom.offlineDetails.open=true;}
// Coalesced variant: markChanged/scheduleSync/updateSyncUI used to rebuild the
// queue list several times per click; now it runs at most once per frame.
function renderOffline(){if(renderOfflineScheduled)return;renderOfflineScheduled=true;if(typeof requestAnimationFrame==="function")requestAnimationFrame(function(){renderOfflineScheduled=false;renderOfflineNow();});else renderOfflineNow();}
function wireOfflineEvents(){if(storage){try{var raw=JSON.parse(storage.getItem(STORAGE_KEY)||'{}');if(raw._offline&&raw._offline.conflicts)offline.conflicts=raw._offline.conflicts;}catch(e){}}trackedPayload=buildPayload();renderOffline();}

['reportsModal','reportsClose','reportYear','reportQuarter','reportStart','reportEnd','reportClass','reportSubject','reportStudent','reportGroup','reportSummary','reportRows','reportNote','reportExcel','reportPDF'].forEach(function(id){dom[id]=document.getElementById(id);});
var lastReport=null;
function reportOptions(){return {start:dom.reportStart.value,end:dom.reportEnd.value,classId:dom.reportClass.value,subjectId:dom.reportSubject.value,studentId:dom.reportStudent.value,group:dom.reportGroup.value};}
function computeReport(options,now){
  now=now||new Date();var result={options:copy(options),generatedAt:now.toISOString(),groups:{students:{},classes:{},subjects:{}},present:0,late:0,absent:0,marked:0,unmarked:0,slots:0,held:0,excludedLessons:0,source:[]};
  function group(type,id,label){return result.groups[type][id]||(result.groups[type][id]={id:id,name:label,present:0,late:0,absent:0,marked:0,unmarked:0});}
  state.lessons.filter(function(l){return !l.deleted&&l.date>=options.start&&l.date<=options.end&&(!options.classId||l.classId===options.classId)&&(!options.subjectId||l.subjectId===options.subjectId)&&(!options.studentId||l.studentIds.includes(options.studentId));}).forEach(function(l){
    var ended=parseDateKey(l.date);ended.setHours(Number(l.endTime.slice(0,2)),Number(l.endTime.slice(3)),0,0);
    var reason=ended>now?'Будущее занятие':l.status==='cancelled'?'Отменено':l.status!=='held'?'Не проведено':'';if(reason)result.excludedLessons++;else result.held++;
    l.studentIds.filter(function(id){return !options.studentId||id===options.studentId;}).forEach(function(id){var status=(state.lessonMarks[l.id+'~'+id]||{}).status||'unmarked';var student=named('students',id),className=named('classes',l.classId),subject=named('subjects',l.subjectId);result.source.push([l.date,l.endTime,className,subject,student,statusLabels[status],reason|| (status==='unmarked'?'Нет отметки':'Учтено')]);if(reason)return;
      result.slots++;var groups=[group('students',id,student),group('classes',l.classId,className),group('subjects',l.subjectId,subject)];if(status==='unmarked'){result.unmarked++;groups.forEach(function(g){g.unmarked++;});return;}result[status]++;result.marked++;groups.forEach(function(g){g[status]++;g.marked++;});
    });
  });
  Object.keys(result.groups).forEach(function(k){result.groups[k]=Object.values(result.groups[k]).sort(function(a,b){return a.name.localeCompare(b.name,'ru');});result.groups[k].forEach(function(g){g.rate=g.marked?(g.present+g.late)/g.marked:null;});});result.rate=result.marked?(result.present+result.late)/result.marked:null;result.completeness=result.slots?result.marked/result.slots:null;return result;
}
function percent(v){return v===null?'—':new Intl.NumberFormat('ru-RU',{style:'percent',maximumFractionDigits:1}).format(v);}
function setQuarterDates(){var y=Number(dom.reportYear.value),q=dom.reportQuarter.value;if(!Number.isInteger(y)||y<1000||y>9998||q==='custom')return;var dates={1:[y+'-09-01',y+'-10-31'],2:[y+'-11-01',y+'-12-31'],3:[(y+1)+'-01-01',(y+1)+'-03-31'],4:[(y+1)+'-04-01',(y+1)+'-05-31']};dom.reportStart.value=dates[q][0];dom.reportEnd.value=dates[q][1];}
function renderReports(){
  var options=reportOptions();dom.reportRows.replaceChildren();
  if(!validDate(options.start)||!validDate(options.end)||options.start>options.end){dom.reportSummary.textContent='Укажите корректный диапазон дат.';lastReport=null;dom.reportExcel.disabled=dom.reportPDF.disabled=true;return;}
  lastReport=computeReport(options);var r=lastReport;dom.reportExcel.disabled=dom.reportPDF.disabled=false;
  dom.reportSummary.textContent='Посещаемость: '+percent(r.rate)+' · Проведено занятий: '+r.held+' · Заполнено: '+r.marked+' из '+r.slots+' ('+percent(r.completeness)+'). Без отметки: '+r.unmarked+'. Исключено занятий: '+r.excludedLessons+'.';
  r.groups[options.group].forEach(function(g){var tr=el('tr');[g.name,g.present,g.late,g.absent,g.marked,percent(g.rate)].forEach(function(v){tr.appendChild(el('td',String(v)));});dom.reportRows.appendChild(tr);});
  if(!r.groups[options.group].length){var tr=el('tr'),td=el('td','За этот период нет подходящих проведённых занятий.');td.colSpan=6;tr.appendChild(td);dom.reportRows.appendChild(tr);}
  dom.reportNote.textContent='Отметка «Онлайн» считается посещением. Процент по классу и предмету считается по всем заполненным отметкам, а не как среднее процентов учеников. Дневные отметки без предмета ('+Object.keys(state.attendance).length+') в отчёт не включены.';
  try{if(storage)storage.setItem('attendance_report_filters',JSON.stringify(Object.assign({},options,{year:dom.reportYear.value,quarter:dom.reportQuarter.value})));}catch(e){}
}
function openReports(){fillSelect(dom.reportClass,state.classes,'Все классы');fillSelect(dom.reportSubject,state.subjects,'Все предметы');fillSelect(dom.reportStudent,state.students.map(function(s){return Object.assign({},s,{deleted:false});}),'Все ученики');var saved={};try{saved=JSON.parse(storage&&storage.getItem('attendance_report_filters')||'{}');}catch(e){}if(saved.classId)dom.reportClass.value=saved.classId;if(saved.subjectId)dom.reportSubject.value=saved.subjectId;if(saved.studentId)dom.reportStudent.value=saved.studentId;renderReports();openModal(dom.reportsModal,dom.reportQuarter);}
function wireReportEvents(){var today=new Date();dom.reportYear.value=today.getMonth()>=8?today.getFullYear():today.getFullYear()-1;dom.reportQuarter.value=today.getMonth()>=8&&today.getMonth()<=9?'1':today.getMonth()>=10?'2':today.getMonth()<3?'3':'4';setQuarterDates();try{var saved=JSON.parse(storage&&storage.getItem('attendance_report_filters')||'{}');if(validDate(saved.start)&&validDate(saved.end)){dom.reportStart.value=saved.start;dom.reportEnd.value=saved.end;dom.reportYear.value=saved.year;dom.reportQuarter.value=saved.quarter;dom.reportGroup.value=saved.group;}}catch(e){}
  dom.reportsButton.addEventListener('click',openReports);dom.reportsClose.addEventListener('click',closeModal);
  [dom.reportYear,dom.reportQuarter].forEach(function(n){n.addEventListener('change',function(){setQuarterDates();renderReports();});});[dom.reportStart,dom.reportEnd].forEach(function(n){n.addEventListener('change',function(){dom.reportQuarter.value='custom';renderReports();});});[dom.reportClass,dom.reportSubject,dom.reportStudent,dom.reportGroup].forEach(function(n){n.addEventListener('change',renderReports);});
  dom.reportExcel.addEventListener('click',function(){exportReport('xlsx');});dom.reportPDF.addEventListener('click',function(){exportReport('pdf');});
}

/* All dependencies are embedded by the build; both exports work offline. */
function xmlText(v){return String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function columnName(n){var name='';do{name=String.fromCharCode(65+n%26)+name;n=Math.floor(n/26)-1;}while(n>=0);return name;}
function sheetXML(rows,widths,filter){var xml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>'+widths.map(function(w,i){return '<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+w+'" customWidth="1"/>';}).join('')+'</cols><sheetData>';
rows.forEach(function(row,i){xml+='<row r="'+(i+1)+'" ht="'+(i?Math.max(32,Math.max.apply(null,row.map(function(v,j){return typeof v==='string'?Math.ceil(v.length/(widths[j]-2))*16+12:32;}))):36)+'" customHeight="1">';row.forEach(function(v,j){var ref=columnName(j)+(i+1),style=i===0?1:v&&typeof v==='object'?2:0;if(v&&typeof v==='object'){xml+='<c r="'+ref+'" s="'+style+'"><f>'+xmlText(v.formula)+'</f><v>'+v.value+'</v></c>';}else if(typeof v==='number')xml+='<c r="'+ref+'" s="'+style+'"><v>'+v+'</v></c>';else xml+='<c r="'+ref+'" t="inlineStr" s="'+style+'"><is><t xml:space="preserve">'+xmlText(v==null?'':v)+'</t></is></c>';});xml+='</row>';});xml+='</sheetData>';if(filter&&rows.length>1)xml+='<autoFilter ref="A1:'+columnName(rows[0].length-1)+rows.length+'"/>';return xml+'<pageSetup orientation="landscape" paperSize="9"/></worksheet>';}
async function createReportWorkbook(report){
  var zip=new JSZip(),sheets=[];
  var info=[['Отчёт посещаемости','Значение'],['Период',report.options.start+' — '+report.options.end],['Класс',report.options.classId?named('classes',report.options.classId):'Все классы'],['Предмет',report.options.subjectId?named('subjects',report.options.subjectId):'Все предметы'],['Ученик',report.options.studentId?named('students',report.options.studentId):'Все ученики'],['Сформирован',new Date(report.generatedAt).toLocaleString('ru-RU')],['Правило','(Присутствия + Онлайн) / заполненные отметки прошедших проведённых занятий'],['Проведено занятий',report.held],['Исключено занятий',report.excludedLessons],['Заполнено отметок',report.marked],['Без отметки',report.unmarked],['Посещаемость',percent(report.rate)],['Дневные отметки','Не входят в отчёты по предметам'],['Время','Окончание занятия сравнивается с местным временем устройства']];sheets.push({name:'Об отчёте',rows:info,widths:[32,95]});
  ['students','classes','subjects'].forEach(function(type){var rows=[['Имя / название','Присутствия','Онлайн','Пропуски','Отмечено','Посещаемость','Без отметки']];report.groups[type].forEach(function(g){var n=rows.length+1;rows.push([g.name,g.present,g.late,g.absent,g.marked,g.marked?{formula:'(B'+n+'+C'+n+')/E'+n,value:g.rate}:'—',g.unmarked]);});sheets.push({name:{students:'Ученики',classes:'Классы',subjects:'Предметы'}[type],rows:rows,widths:[35,16,16,16,16,20,18],filter:true});});
  sheets.push({name:'Исходные отметки',rows:[['Дата','Окончание','Класс','Предмет','Ученик','Отметка','Участие в расчёте']].concat(report.source),widths:[16,14,25,28,35,22,26],filter:true});
  var types='<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
  var workbook='<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>',rels='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  sheets.forEach(function(s,i){var n=i+1;types+='<Override PartName="/xl/worksheets/sheet'+n+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';workbook+='<sheet name="'+xmlText(s.name)+'" sheetId="'+n+'" r:id="rId'+n+'"/>';rels+='<Relationship Id="rId'+n+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+n+'.xml"/>';zip.file('xl/worksheets/sheet'+n+'.xml',sheetXML(s.rows,s.widths,s.filter));});
  rels+='<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
  zip.file('[Content_Types].xml',types+'</Types>');zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');zip.file('xl/workbook.xml',workbook+'</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>');zip.file('xl/_rels/workbook.xml.rels',rels);
  zip.file('xl/styles.xml','<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF166B73"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');return zip.generateAsync({type:'blob',compression:'DEFLATE',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
function wrapCanvas(ctx,text,width){var words=String(text).split(/\s+/),lines=[],line='';words.forEach(function(word){if(ctx.measureText(word).width>width){if(line){lines.push(line);line='';}var part='';Array.from(word).forEach(function(char){if(ctx.measureText(part+char).width>width){lines.push(part);part='';}part+=char;});line=part;return;}var candidate=line?line+' '+word:word;if(ctx.measureText(candidate).width>width){lines.push(line);line=word;}else line=candidate;});if(line)lines.push(line);return lines.length?lines:[''];}
async function createReportPDF(report){
  var pdf=await PDFLib.PDFDocument.create();pdf.setTitle('Отчёт посещаемости');pdf.setLanguage('ru-RU');pdf.setCreationDate(new Date(report.generatedAt));
  var rows=report.groups[report.options.group],canvas,ctx,y,pageNo=0,W=1684,H=1190,margin=70,cols=[70,674,838,998,1165,1322],widths=[604,164,160,167,157,292];
  async function finish(){if(!canvas)return;var img=await pdf.embedPng(canvas.toDataURL('image/png'));var page=pdf.addPage([842,595]);page.drawImage(img,{x:0,y:0,width:842,height:595});}
  function start(){pageNo++;canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,W,H);ctx.fillStyle='#166b73';ctx.font='bold 42px Arial';ctx.fillText('Отчёт посещаемости',margin,95);ctx.fillStyle='#34494c';ctx.font='24px Arial';ctx.fillText(report.options.start+' — '+report.options.end+'  ·  '+({students:'По ученикам',classes:'По классам',subjects:'По предметам'}[report.options.group]),margin,139);ctx.font='20px Arial';var filter='Класс: '+(report.options.classId?named('classes',report.options.classId):'Все')+' · Предмет: '+(report.options.subjectId?named('subjects',report.options.subjectId):'Все')+' · Ученик: '+(report.options.studentId?named('students',report.options.studentId):'Все');var lines=wrapCanvas(ctx,filter,W-margin*2);y=174;lines.forEach(function(line){ctx.fillText(line,margin,y);y+=25;});ctx.fillText('Посещаемость '+percent(report.rate)+' · Проведено занятий '+report.held+' · Отмечено '+report.marked+' из '+report.slots+' · Без отметки '+report.unmarked,margin,y+12);y+=42;ctx.fillStyle='#166b73';ctx.fillRect(margin,y,W-2*margin,52);ctx.fillStyle='#ffffff';ctx.font='bold 20px Arial';['Имя / название','Был','Онлайн','Пропустил','Отмечено','Посещаемость'].forEach(function(v,i){ctx.fillText(v,cols[i]+12,y+33);});y+=52;ctx.fillStyle='#67787a';ctx.font='18px Arial';ctx.fillText('Будущие, непроведённые занятия и пустые отметки исключены. Онлайн = посещение.',margin,H-78);ctx.fillText('Дневные отметки без предмета не включены. Сформирован '+new Date(report.generatedAt).toLocaleString('ru-RU'),margin,H-51);ctx.fillText('Стр. '+pageNo,W-145,H-51);}
  start();if(!rows.length){ctx.fillStyle='#34494c';ctx.font='24px Arial';ctx.fillText('Нет проведённых занятий за выбранный период.',margin+12,y+50);}
  for(var i=0;i<rows.length;i++){var g=rows[i];ctx.font='23px Arial';var lines=wrapCanvas(ctx,g.name,widths[0]-28),height=Math.max(56,lines.length*28+20);if(y+height>H-112){await finish();start();}ctx.fillStyle=i%2?'#f0f6f6':'#ffffff';ctx.fillRect(margin,y,W-margin*2,height);ctx.fillStyle='#21383b';ctx.font='23px Arial';lines.forEach(function(line,j){ctx.fillText(line,cols[0]+12,y+33+j*28);});[g.present,g.late,g.absent,g.marked,percent(g.rate)].forEach(function(v,j){ctx.fillText(String(v),cols[j+1]+12,y+33);});y+=height;}
  await finish();return new Blob([await pdf.save()],{type:'application/pdf'});
}
async function exportReport(format){renderReports();if(!lastReport)return;var report=copy(lastReport);dom.reportExcel.disabled=dom.reportPDF.disabled=true;showToast('Готовлю отчёт…');try{var blob=format==='xlsx'?await createReportWorkbook(report):await createReportPDF(report),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Посещаемость_'+report.options.start+'_'+report.options.end+'.'+format;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url);},30000);showToast('Отчёт скачан','success');}catch(e){showToast('Не удалось выгрузить отчёт: '+e.message,'error');}finally{dom.reportExcel.disabled=dom.reportPDF.disabled=false;}}

/* GitHub Gist transport for schema v5.
 * Every writer PATCHes its own file; attendance.json is a read-only legacy source.
 * Unmentioned files are preserved by the Gist API. All sources are merged by the
 * model's deterministic record/field clocks, including permanent tombstones.
 * Browsers with Web Locks serialize tabs sharing a device. Other browsers use
 * a unique file per open tab to avoid concurrent replacement of the same file.
 */
var syncRuntime = {
  pushTimer: null, pollTimer: null, retryTimer: null,
  isSyncing: false, pendingSync: false, hasPendingChanges: false,
  etag: null, cachedRemote: null, cachedHasFiles: false, cachedFiles: {}, remoteApplied: false,
  retryAt: 0, blocked: false, lastReceivedAt: 0, lastReceivedCount: 0,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, consecutiveErrors: 0,
  lastPullAt: 0, lastPushedAt: 0, generation: 0,
  activeOperation: null, operationCounter: 0, controllers: new Set(),
  tabWriterId: generateId().replace(/[^a-zA-Z0-9_-]/g, "")
};
var TOKEN_KEY = "attendance_sync_token";

function syncClone(value) { return JSON.parse(JSON.stringify(value)); }
function syncStable(value) {
  if (Array.isArray(value)) return "[" + value.map(syncStable).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ":" + syncStable(value[key]);
    }).join(",") + "}";
  }
  return JSON.stringify(value);
}
function syncEqual(a, b) { return syncStable(a) === syncStable(b); }
function syncConfigured() { return Boolean(syncConfig.enabled && syncConfig.gistId); }
// A connection without a token is read-only: the journal can be viewed and
// polled from a public Gist, but local edits never leave the device.
function syncReadOnly() {
  // Role gate first: student/observer devices cannot write anything unless the
  // tech-admin add-on is active. Token-less public-Gist connections stay
  // view-only for remote data but still allow local edits for teachers.
  return !effectivePermissions().canEditJournal;
}
function syncWritable() { return syncConfigured() && Boolean(syncConfig.token); }
function syncAutomatic() { return syncWritable() && syncRuntime.pollIntervalMs > 0; }
function syncOnline() { return typeof navigator === "undefined" || navigator.onLine !== false; }
function syncOperationConfig(token, gistId) {
  return Object.freeze({
    token: token === undefined ? syncConfig.token : token,
    gistId: gistId === undefined ? syncConfig.gistId : gistId,
    generation: syncRuntime.generation
  });
}
function syncCheckGeneration(config) {
  if (config.generation !== syncRuntime.generation) {
    var error = new Error("Настройки синхронизации изменились");
    error.stale = true;
    throw error;
  }
}
function syncInvalidate() {
  syncRuntime.generation++;
  clearTimeout(syncRuntime.pushTimer); clearTimeout(syncRuntime.retryTimer);
  syncRuntime.pushTimer = null; syncRuntime.retryTimer = null;
  stopPolling();
  syncRuntime.controllers.forEach(function (controller) { controller.abort(); });
  syncRuntime.controllers.clear();
  syncRuntime.etag = null; syncRuntime.cachedRemote = null;
  syncRuntime.cachedHasFiles = false; syncRuntime.isSyncing = false;
  syncRuntime.activeOperation = null; syncRuntime.pendingSync = false;
  syncRuntime.consecutiveErrors = 0; syncRuntime.retryAt = 0; syncRuntime.blocked = false;
  syncRuntime.cachedFiles = {}; syncRuntime.cachedSources = null; syncRuntime.remoteApplied = false;
}

function readStoredJson(store, key) {
  try { var raw = store && store.getItem(key); if (!raw) return null; var parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : null; }
  catch (error) { return null; }
}
function loadSyncConfig() {
  var stored = readStoredJson(storage, SYNC_CONFIG_KEY) || {};
  // Preferred location: token lives inside the main sync-config object in localStorage.
  var token = typeof stored.token === "string" ? stored.token : "";
  var gistId = typeof stored.gistId === "string" ? extractGistId(stored.gistId) : "";
  // Fallbacks for older builds: separate localStorage token entry, then legacy sessionStorage.
  var legacyStores = [readStoredJson(storage, TOKEN_KEY), readStoredJson(sessStorage, "attendance_sync_session_token")];
  if (!token) {
    for (var i = 0; i < legacyStores.length; i++) {
      var legacy = legacyStores[i];
      if (legacy && typeof legacy.token === "string" && legacy.token) {
        // Only adopt a legacy token when it was bound to this same Gist (or had no binding yet).
        if (!legacy.gistId || legacy.gistId === gistId) { token = legacy.token; break; }
      }
    }
  }
  syncConfig.enabled = Boolean(stored.enabled);
  syncConfig.gistId = gistId;
  syncConfig.token = token;
  syncConfig.isPublicGist = Boolean(stored.isPublicGist);
  syncConfig.lastSync = Number(stored.lastSync) || 0;
  syncConfig.lastSyncStatus = typeof stored.lastSyncStatus === "string" ? stored.lastSyncStatus : "off";
  syncConfig.lastError = "";
  saveSyncConfig();
  try { if (sessStorage) sessStorage.removeItem("attendance_sync_session_token"); } catch (error) {}
}
function saveSyncConfig() {
  // Everything (including the token) is persisted in localStorage under one key,
  // so closing the tab or restarting the browser never loses the connection.
  try {
    if (storage) storage.setItem(SYNC_CONFIG_KEY, JSON.stringify({
      enabled: syncConfig.enabled, gistId: syncConfig.gistId, token: syncConfig.token,
      isPublicGist: syncConfig.isPublicGist,
      lastSync: syncConfig.lastSync, lastSyncStatus: syncConfig.lastSyncStatus
    }));
  } catch (error) {
    console.warn("Не удалось сохранить настройки синхронизации");
  }
  try { if (storage) storage.removeItem(TOKEN_KEY); } catch (error) {}
}
function loadInterval() {
  try {
    var raw = storage && storage.getItem(INTERVAL_KEY);
    // A missing key means "never chosen by the user" -> apply the current
    // default (15 s). An explicit "0" (manual mode) must stay manual.
    var interval = raw === null || raw === undefined || String(raw).trim() === "" ? DEFAULT_POLL_INTERVAL_MS : Number(raw);
    // Upgrade the former defaults once; manual mode and other choices survive.
    // v32 migrated 30 s -> 5 s; that 5 s cadence proved too heavy for phones
    // (constant network + re-render churn), so v34 upgrades it to 15 s.
    if(storage && !storage.getItem("attendance_sync_speed_v32")) {
      if(interval === 30000) { interval=15000; storage.setItem(INTERVAL_KEY,"15000"); }
      storage.setItem("attendance_sync_speed_v32","1");
    }
    if(storage && !storage.getItem("attendance_sync_speed_v34")) {
      if(interval === 5000 || interval === 30000) { interval=15000; storage.setItem(INTERVAL_KEY,"15000"); }
      storage.setItem("attendance_sync_speed_v34","1");
    }
    // v35: 5 s and 15 s cadences proved too heavy for phones (constant merge +
    // re-render churn between taps). Upgrade them once to the calm 30 s pace.
    if(storage && !storage.getItem("attendance_sync_speed_v35")) {
      var migrated = migratePollInterval(interval);
      if (migrated !== interval) { interval = migrated; storage.setItem(INTERVAL_KEY, String(interval)); }
      storage.setItem("attendance_sync_speed_v35","1");
    }
    // v36: even 30 s background sync still caused visible lag on weak devices
    // (each poll = fetch + full JSON merge + possible re-render). Upgrade every
    // aggressive cadence to a calm pace, once. Manual mode (0) is preserved.
    // The former "every minute" choice was also bumped to 5 minutes because it
    // overlapped with the exponential error backoff and kept waking the CPU.
    if(storage && !storage.getItem("attendance_sync_speed_v36")) {
      if ([5000, 15000, 30000, 60000].indexOf(interval) !== -1) {
        interval = DEFAULT_POLL_INTERVAL_MS;
        storage.setItem(INTERVAL_KEY, String(interval));
      }
      storage.setItem("attendance_sync_speed_v36","1");
    }
    if ([0, 5000, 15000, 30000, 60000, 300000].indexOf(interval) !== -1) syncRuntime.pollIntervalMs = interval;
  } catch (error) {}
}
function saveInterval() {
  try { if (storage) storage.setItem(INTERVAL_KEY, String(syncRuntime.pollIntervalMs)); } catch (error) {}
}
function githubHeaders(config) {
  var headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  // Anonymous requests are allowed only for public Gists (read-only mode).
  if (config.token) headers.Authorization = "Bearer " + config.token;
  return headers;
}
function describeGithubError(status) {
  if (status === 401) return "Токен недействителен (401)";
  if (status === 403) return "Нет прав на Gist или исчерпан лимит запросов (403)";
  if (status === 404) return "Gist не найден или недоступен (404)";
  if (status === 422) return "GitHub отклонил данные (422)";
  if (status >= 500) return "GitHub временно недоступен (" + status + ")";
  return "Ошибка GitHub (" + status + ")";
}
// Anonymous read of a public Gist without a token (see fetchPublicGistFiles).
async function fetchPublicGistFiles(config, options) {
  // Anonymous read of a public Gist works from ANY domain and needs NO token:
  // gist.githubusercontent.com answers with "Access-Control-Allow-Origin: *",
  // so the browser never blocks these requests. Strategy:
  // 1) enumerate journal files via the public embed page (no redirect needed);
  // 2) if that page is unavailable, follow the short gist URL once in "manual"
  //    mode and read the Location header (opaque-redirect trick, no CORS);
  // 3) download every file's raw content directly from gist.githubusercontent.com.
  // api.github.com and personal access tokens are only needed for WRITING.
  // options.filePattern widens the enumeration to account files as well.
  options = options || {};
  var filePattern = options.filePattern || new RegExp("^(" + GIST_FILENAME + "|attendance\\.device\\.[a-zA-Z0-9_.-]+\\.json|accounts\\.device\\.[a-zA-Z0-9_.-]+\\.json)$");
  var gistId = String(config.gistId || "").trim();
  if (!/^[a-f0-9]{5,64}$/i.test(gistId)) throw new Error("Введите правильный ID публичного Gist.");

  async function anonFetch(url, options) {
    var controller = new AbortController();
    var timedOut = false;
    syncRuntime.controllers.add(controller);
    var timer = setTimeout(function () { timedOut = true; controller.abort(); }, 20000);
    try {
      var response = await fetch(url, Object.assign({ method: "GET", signal: controller.signal, cache: "no-store" }, options || {}));
      var body = await response.text();
      syncCheckGeneration(config);
      return { ok: response.ok, status: response.status, headers: response.headers, text: body };
    } catch (error) {
      syncCheckGeneration(config);
      if (timedOut) throw new Error("GitHub не ответил за 20 секунд. Данные остались на устройстве.");
      if (!error.message) error.message = "Браузер не смог получить данные с GitHub. Проверьте подключение к сети и ID Gist.";
      throw error;
    } finally {
      clearTimeout(timer); syncRuntime.controllers.delete(controller);
    }
  }

  // Step 1: collect candidate file names from any GitHub page we can reach.
  // The same public Gist stores journal files (attendance.device.*.json) and
  // account files (accounts.device.*.json); harvestNames matches whatever
  // filePattern describes, so both readers share this enumeration logic.
  function harvestNames(html) {
    var found = [];
    var patterns = [
      /href="\/[^"\/]+\/(?:[a-f0-9]{5,64})\/raw\/(?:[^"?#\s"]+\/)?([^"?#\s"]+)"/gi,
      /gist\.githubusercontent\.com\/[^/"']+\/[a-f0-9]{5,64}\/(?:raw|blob)\/[^"'?\s]+\/([^"'?#\s]+\.json)/gi
    ];
    for (var pi = 0; pi < patterns.length; pi++) {
      var match;
      while ((match = patterns[pi].exec(html)) !== null) {
        var name;
        try { name = decodeURIComponent(match[1]); } catch (error) { name = match[1]; }
        name = name.replace(/[#?].*$/, "");
        if (filePattern.test(name) && found.indexOf(name) === -1) found.push(name);
      }
    }
    return found;
  }
  var names = [];
  var embedResponse = await anonFetch("https://gist.github.com/" + encodeURIComponent(gistId) + "/embed", {});
  if (embedResponse.ok) names = harvestNames(embedResponse.text);
  // Step 2: fallback — resolve the owner login via the redirect Location header.
  if (!names.length) {
    try {
      var redirectResponse = await anonFetch("https://gist.github.com/" + encodeURIComponent(gistId), { redirect: "manual" });
      var location = redirectResponse.headers && typeof redirectResponse.headers.get === "function" ? redirectResponse.headers.get("location") : "";
      // The browser resolves relative Locations against the request URL, so do the same here.
      var absoluteLocation = "";
      if (location) { try { absoluteLocation = new URL(location, "https://gist.github.com/").href; } catch (error) { absoluteLocation = ""; } }
      var ownerMatch = absoluteLocation.match(/^https:\/\/gist\.github\.com\/([^/?#\s]+)\/([a-f0-9]{5,64})(?:[/?#].*)?$/i);
      if (ownerMatch && ownerMatch[1] !== "login") {
        var pageResponse = await anonFetch("https://gist.github.com/" + encodeURIComponent(ownerMatch[1]) + "/" + encodeURIComponent(gistId), {});
        if (pageResponse.ok) names = harvestNames(pageResponse.text);
      }
    } catch (error) { /* keep the empty list; the friendly message below explains it */ }
  }
  // Step 3: download every file straight from the CORS-open raw host.
  var result = {};
  for (var ni = 0; ni < names.length; ni++) {
    var fileName = names[ni];
    var rawResponse = await anonFetch("https://gist.githubusercontent.com/" + encodeURIComponent(gistId) + "/raw/" + encodeURIComponent(fileName), {});
    if (!rawResponse.ok) {
      // A single unavailable auxiliary file (e.g. one device's account list)
      // must not break the whole read — journal files are downloaded anyway.
      continue;
    }
    result[fileName] = { content: rawResponse.text, truncated: false, raw_url: "" };
  }
  if (!Object.keys(result).length) {
    throw new Error("Не удалось найти файлы журнала в публичном Gist. Убедитесь, что синхронизация с этим Gist уже выполнялась с токеном (например, кнопкой «Отправить изменения»), или введите токен для непубличного Gist.");
  }
  return result;
}
// Anonymous fallback for the account list of a public Gist. The embed page
// only links the first few files, so when the regular enumeration finds no
// accounts.device.*.json we probe the CORS-open raw host directly with this
// device id plus the ids of every journal file present in the Gist (devices
// write both files under the same name). Failures stay silent: an empty list
// simply means "no accounts uploaded yet".
async function fetchPublicAccountFilesFallback(config, gistId, journalFileNames) {
  async function anonRaw(url) {
    var controller = new AbortController();
    syncRuntime.controllers.add(controller);
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var response = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
      var body = await response.text();
      syncCheckGeneration(config);
      return { ok: response.ok, text: body };
    } catch (error) {
      syncCheckGeneration(config);
      return { ok: false, text: "" };
    } finally { clearTimeout(timer); syncRuntime.controllers.delete(controller); }
  }
  var writers = [];
  function addWriter(value) {
    var writer = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (writer && writers.indexOf(writer) === -1) writers.push(writer);
  }
  addWriter(deviceId || getDeviceId());
  (journalFileNames || []).forEach(function (name) {
    var match = /^attendance\.device\.([a-zA-Z0-9_.-]+)\.json$/.exec(name);
    if (match) addWriter(match[1]);
  });
  var found = {};
  for (var wi = 0; wi < writers.length; wi++) {
    var raw = await anonRaw("https://gist.githubusercontent.com/" + encodeURIComponent(gistId) + "/raw/accounts.device." + writers[wi] + ".json");
    if (raw.ok && raw.text && raw.text.trim()) found["accounts.device." + writers[wi] + ".json"] = { content: raw.text, truncated: false, raw_url: "" };
  }
  return found;
}
async function syncFetch(url, options, config) {
  syncCheckGeneration(config);
  var controller = new AbortController();
  var timedOut = false;
  syncRuntime.controllers.add(controller);
  var timer = setTimeout(function () { timedOut = true; controller.abort(); }, 20000);
  try {
    var response = await fetch(url, Object.assign({}, options, { signal: controller.signal, cache: "no-store" }));
    // Keep the timeout active while the response body is being downloaded,
    // not only until the HTTP headers arrive.
    var body = await response.text();
    syncCheckGeneration(config);
    return {
      ok: response.ok, status: response.status, headers: response.headers,
      text: function () { return Promise.resolve(body); },
      json: function () { return Promise.resolve().then(function () { return JSON.parse(body); }); }
    };
  } catch (error) {
    syncCheckGeneration(config);
    if (timedOut) throw new Error("Сервер не ответил за 20 секунд. Изменения сохранены на устройстве.");
    throw error;
  } finally {
    clearTimeout(timer); syncRuntime.controllers.delete(controller);
  }
}
function syncHTTPError(response) {
  var error = new Error(describeGithubError(response.status)); error.status = response.status;
  var retry = response.headers.get("Retry-After"), remaining = response.headers.get("X-RateLimit-Remaining");
  if (response.status === 429 || (response.status === 403 && (retry || remaining === "0"))) {
    var delay = retry ? (Number.isFinite(Number(retry)) ? Number(retry)*1000 : Date.parse(retry)-Date.now()) : Number(response.headers.get("X-RateLimit-Reset"))*1000-Date.now();
    error.retryAfter = Math.max(60000, Number.isFinite(delay) ? delay : 60000);
    error.message = "GitHub ограничил частоту запросов. Повтор после " + new Date(Date.now()+error.retryAfter).toLocaleTimeString("ru-RU") + ". Изменения сохранены.";
  }
  return error;
}
function syncEmptyData() { return migrateData({ version: 4, students: [], attendance: {}, settings: {} }); }
function syncFilename() {
  var writer = String(deviceId || getDeviceId()).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!(navigator.locks && typeof navigator.locks.request === "function")) writer += ".tab." + syncRuntime.tabWriterId;
  return "attendance.device." + writer + ".json";
}
async function syncReadFile(file, filename, config) {
  if (!file || typeof file !== "object") throw new Error("Повреждена запись файла «" + filename + "»");
  var text = file.content;
  if (file.truncated) {
    var rawUrl;
    try { rawUrl = new URL(file.raw_url); } catch (error) { throw new Error("Нет адреса полной версии файла «" + filename + "»"); }
    if (rawUrl.protocol !== "https:" || rawUrl.hostname !== "gist.githubusercontent.com" || rawUrl.username || rawUrl.password) {
      throw new Error("Недопустимый адрес полной версии файла Gist");
    }
    var raw = await syncFetch(rawUrl.href, { method: "GET", redirect: "error" }, config);
    if (!raw.ok) throw syncHTTPError(raw);
    text = await raw.text();
    syncCheckGeneration(config);
  }
  if (typeof text !== "string" || !text.trim()) throw new Error("Файл «" + filename + "» пуст или недоступен");
  var parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error("Некорректный JSON в «" + filename + "». Серверные данные не изменены."); }
  try { return migrateData(parsed, true); } catch (error) { throw new Error("Некорректные данные в «" + filename + "»: " + error.message); }
}
async function fetchFromGist(config, options) {
  config = config || syncOperationConfig(); options = options || {};
  // Read-only mode (public Gist, no token): skip api.github.com entirely.
  // Anonymous API calls are blocked by CORS from foreign domains and fail
  // under strict CSP, so we read the public Gist page instead, which always
  // allows cross-origin access and embeds full file contents.
  if (!config.token) {
    // Journal-only pattern: account files live in the same Gist but are read
    // by fetchAccountsFromGist, not merged into the journal payload.
    var anonFiles = await fetchPublicGistFiles(config, { filePattern: new RegExp("^(" + GIST_FILENAME + "|attendance\\.device\\.[a-zA-Z0-9_.-]+\\.json)$") });
    var anonNames = Object.keys(anonFiles).filter(function (name) {
      return name === GIST_FILENAME || /^attendance\.device\.[a-zA-Z0-9_.-]+\.json$/.test(name);
    }).sort();
    var anonSources = [], anonNextFiles = {}, anonAssembled = null;
    for (var ai = 0; ai < anonNames.length; ai++) {
      var aName = anonNames[ai];
      var aData = await syncReadFile(anonFiles[aName], aName, config);
      anonNextFiles[aName] = { fingerprint: "anon:" + aName + ":" + String(anonFiles[aName].content.length), data: aData };
      anonSources.push(aData);
    }
    syncCheckGeneration(config);
    var anonUnchanged = !options.noCache && anonSources.length && syncRuntime.cachedSources &&
      anonSources.length === syncRuntime.cachedSources.length &&
      anonSources.every(function (data, i) { return data === syncRuntime.cachedSources[i]; });
    if (anonUnchanged) anonAssembled = syncRuntime.cachedRemote;
    else anonSources.forEach(function (data) { anonAssembled = anonAssembled ? mergeData(anonAssembled, data) : data; });
    var anonResult = { sources: anonSources, data: anonAssembled || syncEmptyData(), etag: null, hasFiles: anonNames.length > 0, notModified: Boolean(anonUnchanged), gistPublic: true };
    if (!options.noCache) {
      syncRuntime.cachedFiles = anonNextFiles; syncRuntime.cachedSources = anonSources;
      syncRuntime.etag = null; syncRuntime.cachedRemote = anonResult.data; syncRuntime.cachedHasFiles = anonResult.hasFiles;
      if (!anonUnchanged) syncRuntime.remoteApplied = false;
    }
    if (config.gistId === syncConfig.gistId && !syncConfig.isPublicGist) { syncConfig.isPublicGist = true; saveSyncConfig(); }
    return anonResult;
  }
  var headers = githubHeaders(config);
  if (!options.unconditional && syncRuntime.etag && syncRuntime.cachedRemote) headers["If-None-Match"] = syncRuntime.etag;
  var response = await syncFetch("https://api.github.com/gists/" + encodeURIComponent(config.gistId), { method: "GET", headers: headers }, config);
  if (response.status === 304) {
    if (!syncRuntime.cachedRemote) throw new Error("Сервер вернул 304 без проверенной локальной копии");
    return { notModified: true, data: syncRuntime.cachedRemote, etag: syncRuntime.etag, hasFiles: syncRuntime.cachedHasFiles, sources: syncRuntime.cachedSources || [syncRuntime.cachedRemote] };
  }
  if (!response.ok) throw syncHTTPError(response);
  var gist;
  try { gist = await response.json(); } catch (error) { throw new Error("Сервер вернул некорректный ответ. Журнал не изменён."); }
  syncCheckGeneration(config);
  if (!gist || typeof gist !== "object" || !gist.files || typeof gist.files !== "object" || Array.isArray(gist.files)) throw new Error("Некорректная структура ответа Gist");
  var isPublic = gist.public === true;
  // Remember the real visibility reported by GitHub so the UI can show it.
  if (config.gistId === syncConfig.gistId && syncConfig.isPublicGist !== isPublic) {
    syncConfig.isPublicGist = isPublic;
    if (config.token === syncConfig.token) saveSyncConfig();
  }
  if (gist.truncated) throw new Error("Gist содержит слишком много файлов: GitHub вернул неполный список. Синхронизация остановлена.");
  var names = Object.keys(gist.files).filter(function (name) {
    return name === GIST_FILENAME || /^attendance\.device\.[a-zA-Z0-9_.-]+\.json$/.test(name);
  }).sort();
  var assembled = null, sources = [], nextFiles = {};
  // Validate every source before committing; download at most three raw files
  // at a time. Inline files reuse their content cache across Gist revisions.
  async function readSource(index) {
    var name = names[index], file = gist.files[name];
    var fingerprint = file && JSON.stringify(file.truncated ? [true, file.raw_url, file.content] : [false, file.content]);
    var cached = !options.noCache && syncRuntime.cachedFiles[name];
    var data = cached && cached.fingerprint === fingerprint ? cached.data : await syncReadFile(file, name, config);
    nextFiles[name] = { fingerprint: fingerprint, data: data }; sources[index] = data;
  }
  for(var index=0;index<names.length;index+=3){
    var batch=[];for(var offset=index;offset<Math.min(index+3,names.length);offset++)batch.push(readSource(offset));
    await Promise.all(batch);
  }
  syncCheckGeneration(config);
  var unchanged = !options.noCache && syncRuntime.cachedRemote && syncRuntime.cachedSources && sources.length === syncRuntime.cachedSources.length && sources.every(function(data,i){return data === syncRuntime.cachedSources[i];});
  if (unchanged) assembled = syncRuntime.cachedRemote;
  else sources.forEach(function(data){assembled = assembled ? mergeData(assembled, data) : data;});
  var result = { sources: sources, data: assembled || syncEmptyData(), etag: response.headers.get("ETag"), hasFiles: names.length > 0, notModified: Boolean(unchanged), gistPublic: isPublic };
  // A connection test uses independent credentials and never poisons the cache.
  if (!options.noCache) {
    syncRuntime.cachedFiles = nextFiles; syncRuntime.cachedSources = sources;
    syncRuntime.etag = result.etag; syncRuntime.cachedRemote = result.data; syncRuntime.cachedHasFiles = result.hasFiles;
    if (!unchanged) syncRuntime.remoteApplied = false;
  }
  return result;
}
/* ============ SYNC ENGINE v3.3.1 (rewritten) ============
   The synchronization code below replaced the previous implementation that
   failed to deliver changes reliably. Fixed defects:
   1. A single network hiccup used to block automatic sync forever: any hard
      error marked the runtime "blocked" and auto runs were silently dropped
      until the user pressed a button. Now only unrecoverable errors (invalid
      token, missing Gist, rejected payload, unresolved conflict) stop the
      automatic cycle; transient failures retry with backoff.
   2. Pending edits could be lost from the badge: hasPendingChanges was reset
      by an unrelated successful poll while an earlier change still sat in the
      offline queue. The flag is now recomputed from the real queue.
   3. forcePull ran only when the gist was writable AND the poll interval was
      non-zero, so manual download did nothing in "manual mode". Read-only
      connections now pull on demand as well.
   4. After saving connection settings the journal was not fetched when the
      token field was left empty (public read-only gist). The first load now
      happens immediately after connecting.
   5. Hard errors never cleared lastError, so the status line kept showing a
      stale message even after later successful syncs. */

// Errors that will never succeed on retry — automatic sync must stay paused
// for them until the user acts (fixes defect #1).
function syncHardError(error) {
  return Boolean(error && ((error.noRetry && !error.conflict) || error.status === 401 ||
    (error.status === 403 && !error.retryAfter) || error.status === 404 || error.status === 422));
}
async function pushToGist(data, config) {
  syncCheckGeneration(config);
  if (!config.token) throw new Error("Нет токена GitHub: журнал открыт из публичного Gist только для чтения. Введите токен в подключении, чтобы отправлять изменения.");
  // Stamp this device's presence card right before uploading so every other
  // connected device can see it in the settings ("Устройства синхронизации").
  var meta = state.deviceMeta || (state.deviceMeta = {});
  var entry = meta[deviceId] || (meta[deviceId] = {});
  entry.seenAt = Date.now();
  entry.updatedAt = Date.now();
  entry.name = typeof entry.name === "string" ? entry.name.slice(0, 40) : "";
  data = Object.assign({}, data, { deviceMeta: copy(meta) });
  var content = JSON.stringify(data);
  if (new TextEncoder().encode(content).byteLength > 8 * 1024 * 1024) {
    var sizeError = new Error("Журнал превышает 8 МБ — безопасный предел файла Gist. Экспортируйте резервную копию и перенесите архив в отдельное хранилище.");
    sizeError.noRetry = true; throw sizeError;
  }
  var files = {}; files[syncFilename()] = { content: content };
  var response = await syncFetch("https://api.github.com/gists/" + encodeURIComponent(config.gistId), {
    method: "PATCH", headers: Object.assign({ "Content-Type": "application/json" }, githubHeaders(config)), body: JSON.stringify({ files: files })
  }, config);
  if (!response.ok) throw syncHTTPError(response);
  syncCheckGeneration(config);
  // A PATCH may race with a different device's independent file. Always read
  // the complete Gist next time rather than caching only our submitted data.
  syncRuntime.etag = null; syncRuntime.cachedRemote = null; syncRuntime.cachedHasFiles = false;
}
function setSyncStatus(status, text) {
  if (dom.syncStatus) { dom.syncStatus.className = "sync-status " + status; dom.syncStatus.title = syncConfig.lastError || ""; }
  if (dom.syncStatusText) dom.syncStatusText.textContent = text;
}
function formatTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "ещё не было";
}
function updateSyncUI() {
  renderOffline();
  renderSyncOverview();
  var configured = syncConfigured(), readOnly = syncReadOnly();
  // Keep the checkbox in the connection form in sync with the saved config.
  // Doing this unconditionally used to overwrite whatever the user was
  // selecting right before pressing «Сохранить подключение» (the flag reset
  // itself back to false), which broke saving and left the status badge stuck.
  if (dom.gistPublicCheckbox && document.activeElement !== dom.gistPublicCheckbox) dom.gistPublicCheckbox.checked = Boolean(syncConfig.isPublicGist);
  if (dom.publicGistWarning) dom.publicGistWarning.hidden = !syncFormPublicFlag();
  if (!configured) setSyncStatus("off", syncConfig.enabled && syncConfig.gistId ? "Нет доступа к Gist — проверьте ID или добавьте токен" : "На этом устройстве");
  else if (readOnly) {
    // Read-only mode never uploads, so it is NOT "saved locally only": the
    // journal here mirrors the public Gist. The old order of checks showed
    // "Нет сети · сохранено локально" whenever navigator.onLine lied (VPN,
    // strict networks), which made users think sync was broken.
    setSyncStatus(syncOnline() ? "on" : "paused", syncConfig.lastSync ? "Публичный Gist · синхр. " + formatTime(syncConfig.lastSync) : "Публичный Gist · только чтение");
  }
  else if (syncRuntime.isSyncing) setSyncStatus("busy", "Синхронизация…");
  else if (!syncOnline()) setSyncStatus("paused", "Нет сети · изменения сохранятся на устройстве");
  else if (syncConfig.lastSyncStatus === "error") setSyncStatus("error", syncRuntime.retryTimer ? "Ошибка · повтор запланирован" : "Ошибка синхронизации");
  else if (syncRuntime.hasPendingChanges || state.revision > state.lastSyncedRevision) setSyncStatus("paused", syncRuntime.pollIntervalMs === 0 ? "Есть изменения · отправьте вручную" : "Изменения ждут отправки");
  else setSyncStatus("on", syncConfig.lastSync ? "Синхр. " + formatTime(syncConfig.lastSync) : "Готово к синхронизации");
  // "Синхронизировать сейчас" and "Загрузить серверную копию" also work in
  // read-only mode (public Gist without a token); only uploading needs write
  // access. Previously all three buttons were disabled while read-only, so
  // the user had no way to trigger a manual refresh at all.
  [dom.syncNowButton, dom.forcePullButton].forEach(function (button) { if (button) button.disabled = !configured || syncRuntime.isSyncing; });
  if (dom.forcePushButton) dom.forcePushButton.disabled = !configured || readOnly || syncRuntime.isSyncing;
  // Rebuilding the whole device roster on every sync tick used to steal focus
  // from the device-name input while typing and cost needless DOM work. The
  // roster only changes when its data changes — so render it only then, and
  // never while the user is editing inside it.
  var rosterSignature = JSON.stringify([Object.keys(state.deviceMeta || {}).sort(), state.deviceMeta, configured, deviceId]);
  if (rosterSignature !== updateSyncUI.lastRoster) {
    updateSyncUI.lastRoster = rosterSignature;
    var ae = document.activeElement;
    var editingInside = ae && dom.syncDeviceList && dom.syncDeviceList.contains(ae);
    if (!editingInside) renderDeviceList();
  }
}
function scheduleSync() {
  if (syncRuntime.blocked && !Object.keys(offline.conflicts).length && syncConfig.lastError.indexOf("конфликт") !== -1) syncRuntime.blocked = false;
  syncRuntime.hasPendingChanges = syncRuntime.hasPendingChanges || state.revision > state.lastSyncedRevision;
  updateSyncUI();
  if (!syncAutomatic()) return;
  clearTimeout(syncRuntime.pushTimer);
  var generation = syncRuntime.generation;
  syncRuntime.pushTimer = setTimeout(function () {
    syncRuntime.pushTimer = null;
    if (generation === syncRuntime.generation && syncAutomatic()) fullSync("auto");
  }, typeof PUSH_DEBOUNCE_MS === "number" ? PUSH_DEBOUNCE_MS : 2500);
}
function syncWithDeviceLock(config, callback) {
  if (navigator.locks && typeof navigator.locks.request === "function") {
    return navigator.locks.request("attendance-gist-" + config.gistId + "-" + deviceId, { mode: "exclusive" }, function () { syncCheckGeneration(config); return callback(); });
  }
  return callback();
}
function syncApply(merged) {
  var before = buildPayload();
  if (!syncEqual(before, merged)) {
    applyMergedToState(merged);
    if (saveLocal() === false) throw syncLocalSaveError();
    render(); announceIncoming(before, merged, "Получено с другого устройства");
  }
  // Device roster changes must not schedule a push: the heartbeat is stamped
  // locally and uploaded with the next real change.
  state.deviceMeta = cleanDeviceMeta(merged.deviceMeta);
}
/* ---------- Connected devices roster (settings panel) ---------- */
// Every device writes its journal snapshot into its own Gist file together
// with a small "deviceMeta" card (name + last activity). The merged journal
// therefore always contains the full list of devices connected to this Gist.
function deviceSuggestedName(id) {
  var ua = navigator.userAgent || "";
  var browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Браузер";
  var os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return (browser + " " + os).trim() + " · " + String(id).slice(0, 4);
}
function formatSeenAgo(seenAt) {
  if (!(seenAt > 0)) return "никогда";
  var minutes = Math.max(0, Math.round((Date.now() - seenAt) / 60000));
  if (minutes < 1) return "только что";
  if (minutes < 60) return minutes + " мин назад";
  var hours = Math.round(minutes / 60);
  if (hours < 24) return hours + " ч назад";
  var days = Math.round(hours / 24);
  if (days < 31) return days + " дн назад";
  return new Date(seenAt).toLocaleDateString("ru-RU");
}
function renderDeviceList() {
  var container = dom.syncDeviceList;
  if (!container) return;
  // The current device is always listed (roles and the tech-admin add-on are
  // managed locally even before a Gist connection exists). Other devices only
  // appear once sync is configured.
  var meta = state.deviceMeta || {};
  var ids = syncConfigured() ? Object.keys(meta) : [];
  if (deviceId && ids.indexOf(deviceId) === -1) ids.push(deviceId);
  if (!ids.length) {
    container.innerHTML = '<p class="help-text">Пока ни одно устройство не отправляло данные в этот Gist. Отправьте изменения — устройство появится в списке.</p>';
    return;
  }
  ids.sort(function (a, b) {
    if (a === deviceId) return -1;
    if (b === deviceId) return 1;
    return ((meta[b] || {}).seenAt || 0) - ((meta[a] || {}).seenAt || 0);
  });
  container.textContent = "";
  ids.forEach(function (id) {
    var entry = meta[id] || {};
    var row = document.createElement("div"); row.className = "device-row";
    var info = document.createElement("div");
    var name = document.createElement("span"); name.className = "device-name";
    name.textContent = entry.name || deviceSuggestedName(id);
    info.appendChild(name);
    if (id === deviceId) { var badge = document.createElement("span"); badge.className = "device-badge"; badge.textContent = "это устройство"; info.appendChild(badge); }
    var shortId = document.createElement("span"); shortId.className = "device-id"; shortId.textContent = "ID: " + id.slice(0, 8); info.appendChild(document.createElement("br")); info.appendChild(shortId);
    row.appendChild(info);
    var seen = document.createElement("span"); seen.className = "device-seen" + (entry.seenAt ? "" : " never");
    seen.textContent = id === deviceId ? formatSeenAgo(Math.max(entry.seenAt || 0, syncConfig.lastSync || 0)) : formatSeenAgo(entry.seenAt);
    row.appendChild(seen);
    var input = document.createElement("input"); input.className = "device-input"; input.type = "text"; input.maxLength = 40;
    input.placeholder = "Имя устройства"; input.value = entry.name || ""; input.dataset.deviceId = id;
    if (id !== deviceId && !syncWritable()) input.disabled = true;
    input.title = id === deviceId ? "Ваше имя устройства — сохранится в облаке после ближайшей отправки" : "Переименовать это устройство (нужен токен для отправки)";
    row.appendChild(input);
    // Role selector: teacher / student / admin / observer. Changing other
    // devices' roles requires a write connection (token); own device is always editable.
    var roleSelect = document.createElement("select"); roleSelect.className = "device-role"; roleSelect.dataset.deviceId = id;
    DEVICE_ROLE_KEYS.forEach(function (key) {
      var option = new Option(DEVICE_ROLES[key].label, key);
      option.title = DEVICE_ROLES[key].hint;
      roleSelect.appendChild(option);
    });
    roleSelect.value = deviceRole(id); // reflects the effective role incl. "registered account → student" default
    roleSelect.setAttribute("aria-label", "Роль устройства: " + (entry.name || id.slice(0, 4)));
    if (id !== deviceId && !syncWritable()) roleSelect.disabled = true;
    roleSelect.title = id === deviceId ? "Ваша роль на этом устройстве" : "Назначить роль этому устройству (нужен токен для отправки)";
    row.appendChild(roleSelect);
    // Tech-admin add-on chip: shown next to the base role for every device that
    // was granted it via the settings password. Clicking toggles it (own device
    // always; other devices require manage rights + write connection).
    var flag = document.createElement("button");
    flag.type = "button";
    flag.className = "device-tech-flag" + (entry.techAdmin ? " is-active" : "");
    flag.dataset.deviceId = id;
    flag.textContent = entry.techAdmin ? "🛡 Тех. адм." : "Тех. адм.";
    flag.setAttribute("aria-pressed", String(Boolean(entry.techAdmin)));
    flag.setAttribute("aria-label", "Статус тех. администрации: " + (entry.name || id.slice(0, 4)));
    flag.title = entry.techAdmin
      ? "Доступ ко всем функциям выдан (введите пароль настроек на этом устройстве, чтобы снять)"
      : "Выдать доступ ко всем функциям (можно только на самом устройстве — через пароль настроек)";
    if (id !== deviceId) flag.disabled = true;
    row.appendChild(flag);
    container.appendChild(row);
  });
  applyRoleRestrictions();
}
async function refreshDeviceList() {
  if (!syncConfigured()) { showToast("Сначала подключите Gist в разделе «Синхронизация»", "warning"); return; }
  if (syncRuntime.isSyncing) { showToast("Синхронизация уже выполняется — подождите", "info"); return; }
  var button = dom.refreshDeviceListButton;
  if (button) { button.disabled = true; button.textContent = "Обновление…"; }
  try {
    var config = syncOperationConfig();
    var remote = await fetchFromGist(config, { noCache: true });
    state.deviceMeta = mergeDeviceMeta(state.deviceMeta || {}, remote.data.deviceMeta || {});
    saveLocal(); renderDeviceList();
    showToast("Список устройств обновлён (" + Object.keys(state.deviceMeta).length + ")", "success");
  } catch (error) {
    showToast("Не удалось получить список устройств: " + (error.message || "ошибка сети"), "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = "Обновить список"; }
  }
}
function syncLocalSaveError() {
  var error = new Error("Не удалось сохранить журнал на устройстве. Экспортируйте данные и восстановите локальное хранилище перед синхронизацией.");
  error.noRetry = true; return error;
}
function syncSuccess(reason, sentRevision, unchanged) {
  state.lastSyncedRevision = Math.max(state.lastSyncedRevision || 0, sentRevision);
  // Recompute from the real queue: an unrelated successful poll must not hide
  // edits that are still waiting to be sent (fixes defect #2).
  syncRuntime.hasPendingChanges = state.revision > state.lastSyncedRevision || queuedEntries().length > 0;
  syncRuntime.consecutiveErrors = 0; syncRuntime.retryAt = 0; syncRuntime.blocked = false;
  clearTimeout(syncRuntime.retryTimer); syncRuntime.retryTimer = null;
  // A healthy cycle always clears the stale error message (fixes defect #5).
  syncConfig.lastSync = Date.now(); syncConfig.lastSyncStatus = "ok"; syncConfig.lastError = "";
  if (!unchanged && saveLocal() === false) { syncRuntime.hasPendingChanges = true; throw syncLocalSaveError(); }
  saveSyncConfig();
  if (reason === "manual") showToast("Синхронизация выполнена", "success");
}
function syncRetry(error) {
  if (!syncAutomatic() || syncHardError(error)) return;
  clearTimeout(syncRuntime.retryTimer);
  var delays = [15000, 30000, 60000, 120000, 300000];
  var delay = error.retryAfter || delays[Math.min(Math.max(syncRuntime.consecutiveErrors - 1, 0), delays.length - 1)];
  syncRuntime.retryAt = Date.now() + delay;
  var generation = syncRuntime.generation;
  syncRuntime.retryTimer = setTimeout(function () {
    syncRuntime.retryTimer = null; syncRuntime.retryAt = 0;
    if (generation === syncRuntime.generation && syncAutomatic() && syncOnline()) fullSync("auto");
  }, delay);
}
function syncError(error, reason) {
  if (error.stale) return;
  if (error.status === 401) {
    // The token is kept in localStorage; only its validity is lost. Prompt for a fresh one.
    syncConfig.token = "";
    try { if (storage) storage.removeItem(TOKEN_KEY); } catch (saveError) {}
    saveSyncConfig();
    syncConfig.lastError = "Сохранённый токен отозван или истёк. Создайте новый токен GitHub с правом gist, введите его и нажмите «Сохранить подключение». ID Gist можно не менять.";
    syncConfig.lastSyncStatus = "error";
    saveSyncConfig(); updateSyncUI();
    if (reason === "manual") showToast(syncConfig.lastError, "error");
    return;
  }
  syncRuntime.consecutiveErrors++;
  syncConfig.lastSyncStatus = "error"; syncConfig.lastError = error.message || "Синхронизация не выполнена";
  syncRuntime.hasPendingChanges = syncRuntime.hasPendingChanges || state.revision > state.lastSyncedRevision || queuedEntries().length > 0;
  // Only unrecoverable errors pause the automatic cycle. Transient failures
  // (network drop, timeout, DNS) stay unblocked and resume with the next
  // scheduled poll even if the backoff timer was cancelled (fixes defect #1).
  syncRuntime.blocked = syncHardError(error) || Boolean(error.conflict);
  syncRetry(error);
  if (reason === "manual") showToast(syncConfig.lastError, "error");
}
async function syncRun(reason, polling) {
  if (!syncConfigured() || (reason !== "manual" && !syncAutomatic())) return;
  if (syncRuntime.isSyncing) { if (!polling) syncRuntime.pendingSync = true; return; }
  if (syncRuntime.retryAt > Date.now()) { if (reason === "manual") showToast(syncConfig.lastError, "warning"); return; }
  if (reason !== "manual" && syncRuntime.blocked) return;
  if (reason === "manual") { syncRuntime.blocked = false; clearTimeout(syncRuntime.retryTimer); syncRuntime.retryTimer = null; syncRuntime.retryAt = 0; }
  if (!syncOnline()) { updateSyncUI(); return; }
  // Read-only connections never upload, so a failed fetch must not leave the
  // UI stuck in "error" state: local data is intact and the next poll retries
  // anyway. Clear the stale error flag before starting a fresh cycle.
  if (syncReadOnly() && syncConfig.lastSyncStatus === "error") {
    var hardFailure = Boolean(syncRuntime.blocked) || /токен|конфликт|401|403|404|422/i.test(String(syncConfig.lastError || ""));
    if (!hardFailure) { syncConfig.lastSyncStatus = "off"; syncConfig.lastError = ""; }
  }
  if (polling && document.hidden) return;
  clearTimeout(syncRuntime.pushTimer); syncRuntime.pushTimer = null;
  var config = syncOperationConfig();
  var operation = ++syncRuntime.operationCounter;
  syncRuntime.activeOperation = operation; syncRuntime.isSyncing = true;
  updateSyncUI();
  try {
    await syncWithDeviceLock(config, async function () {
      var remote = await fetchFromGist(config);
      syncCheckGeneration(config);
      // Another tab may have changed localStorage while this tab waited for its
      // lock or for the network. Merge it before constructing a sent snapshot.
      if (!loadLocal()) throw syncLocalSaveError();
      // Read-only connections never upload: a remote that is byte-for-byte equal
  // to the local snapshot means "fully in sync" even on the very first fetch
  // (no cached copy yet). Without this, fresh devices connected to a public
  // Gist kept showing "Нет сети · сохранено локально" forever because the
  // notModified fast-path required remoteApplied, which was never set.
  var remoteMatchesLocal = remote.notModified ? Boolean(syncRuntime.remoteApplied) : syncEqual(buildPayload(), remote.data);
  var hasWork = syncRuntime.hasPendingChanges || state.revision > state.lastSyncedRevision || queuedEntries().length > 0 || Object.keys(offline.conflicts).length > 0;
      if (remote.notModified && remoteMatchesLocal && !hasWork) {
        syncRuntime.lastPullAt = Date.now(); syncSuccess(reason, state.revision, true); scheduleAccountSync(reason === "manual" ? "manual" : "auto"); return;
      }
      if(remote.notModified && Object.keys(offline.conflicts).length && syncRuntime.lastConflictRevision === state.revision){
        if(reason === "manual")showToast(syncConfig.lastError,"warning");return;
      }
      checkSyncConflicts(remote, buildPayload());
      var merged = mergeData(buildPayload(), remote.data);
      syncApply(merged);
      syncCheckGeneration(config);
      var sentRevision = state.revision;
      var payload = buildPayload(), sentQueue = queueSnapshot();
      // Read-only mode (public Gist without a token): apply remote data but never upload.
      var requiresPush = Boolean(config.token) && !syncEqual(payload, remote.data);
      // When nothing is uploaded the local snapshot now mirrors the Gist
      // exactly, so mark it synced and remember the remote was applied even
      // if the very next fetch answers 304 (fixes the stuck "сохранено
      // локально" status on read-only connections).
      if (!requiresPush && syncEqual(payload, remote.data)) {
        state.lastSyncedRevision = Math.max(state.lastSyncedRevision || 0, state.revision);
        syncRuntime.remoteApplied = true;
      }
      if (requiresPush) {
        // Mark the merged local-only records pending before a potentially failing
        // PATCH so even the first failure receives a retry.
        syncRuntime.hasPendingChanges = true;
        await pushToGist(payload, config);
        syncRuntime.lastPushedAt = Date.now();
      }
      syncCheckGeneration(config);
      loadLocal();
      // Revision only acknowledges the submitted snapshot, never edits made
      // during PATCH. A semantic comparison also catches cross-tab changes.
      if (!syncEqual(buildPayload(), payload)) {
        if (state.revision <= sentRevision) state.revision = sentRevision + 1;
        syncRuntime.pendingSync = true;
      }
      syncRuntime.lastPullAt = Date.now();
      acknowledgeQueue(sentQueue); syncSuccess(reason, sentRevision); syncRuntime.remoteApplied = !requiresPush;
      // Accounts ride along with every successful journal cycle: upload this
      // device's list, merge all accounts.device.*.json files from the Gist
      // and apply the result locally (see "Account sync" section).
      scheduleAccountSync(reason === "manual" ? "manual" : "auto");
    });
  } catch (error) {
    if (config.generation === syncRuntime.generation) syncError(error, reason);
  } finally {
    if (syncRuntime.activeOperation === operation && config.generation === syncRuntime.generation) {
      syncRuntime.isSyncing = false; syncRuntime.activeOperation = null;
      var pending = syncRuntime.pendingSync; syncRuntime.pendingSync = false;
      updateSyncUI();
      if (pending && syncAutomatic() && !syncRuntime.blocked) scheduleSync();
    }
  }
}
function fullSync(reason) { return syncRun(reason || "manual", false); }
function pollOnce() { if (syncRuntime.retryTimer) return; return syncRun("auto", true); }
function startPolling() {
  stopPolling();
  if (syncReadOnly()) {
    // Read-only mode: refresh the public Gist on the chosen interval too.
    if (syncRuntime.pollIntervalMs > 0) syncRuntime.pollTimer = setInterval(function () { fullSync("auto"); }, syncRuntime.pollIntervalMs);
    return;
  }
  if (!syncAutomatic()) return;
  syncRuntime.pollTimer = setInterval(function () { pollOnce(); }, syncRuntime.pollIntervalMs);
}
function stopPolling() { clearInterval(syncRuntime.pollTimer); syncRuntime.pollTimer = null; }
function restartPolling() { startPolling(); }
function forcePush() { return fullSync("manual"); }
async function forcePull() {
  // Manual download works for read-only connections as well and no longer
  // depends on the polling interval being non-zero (fixes defect #3).
  if (!syncConfigured() || syncRuntime.isSyncing) return;
  if (!confirm("Заменить журнал на этом устройстве проверенной серверной копией? Перед заменой будет сохранена резервная копия текущего журнала.")) return;
  if (!syncOnline()) { updateSyncUI(); showToast("Нет сети. Журнал остаётся на устройстве.", "warning"); return; }
  var config = syncOperationConfig();
  var operation = ++syncRuntime.operationCounter;
  syncRuntime.activeOperation = operation; syncRuntime.isSyncing = true;
  clearTimeout(syncRuntime.pushTimer); syncRuntime.pushTimer = null;
  clearTimeout(syncRuntime.retryTimer); syncRuntime.retryTimer = null;
  updateSyncUI();
  try {
    await syncWithDeviceLock(config, async function () {
      loadLocal();
      var startRevision = state.revision;
      var before = buildPayload();
      var remote = await fetchFromGist(config, { unconditional: true });
      syncCheckGeneration(config); loadLocal();
      if (state.revision !== startRevision || !syncEqual(buildPayload(), before)) throw new Error("Журнал изменился во время загрузки. Повторите загрузку, чтобы сохранить новые изменения.");
      if (!remote.hasFiles) throw new Error("В Gist нет журнала. Локальные данные сохранены.");
      checkSyncConflicts(remote);
      var backup = saveRecoveryBackup();
      if (backup === false) throw new Error("Не удалось сохранить резервную копию. Замена отменена.");
      var previousRevision = state.revision;
      var previousSyncedRevision = state.lastSyncedRevision;
      var previousPending = syncRuntime.hasPendingChanges;
      var previousOffline = copy(offline); acknowledgeQueue(queueSnapshot()); offline.conflicts = {};
      applyMergedToState(remote.data);
      state.revision++;
      state.lastSyncedRevision = state.revision;
      syncRuntime.hasPendingChanges = false; syncRuntime.pendingSync = false;
      if (saveLocal(true) === false) {
        offline = previousOffline; applyMergedToState(before); state.revision = previousRevision;
        state.lastSyncedRevision = previousSyncedRevision; syncRuntime.hasPendingChanges = previousPending;
        throw syncLocalSaveError();
      }
      render();
      syncSuccess("pull", state.revision);
      showToast("Серверная копия загружена. Предыдущий журнал сохранён в резервной копии.", "success");
    });
  } catch (error) {
    if (config.generation === syncRuntime.generation) {
      // A pull/backup/schema failure must not trigger an automatic upload.
      syncRuntime.consecutiveErrors++;
      syncConfig.lastSyncStatus = "error"; syncConfig.lastError = error.message;
      showToast(error.message, "error");
    }
  } finally {
    if (syncRuntime.activeOperation === operation && config.generation === syncRuntime.generation) {
      syncRuntime.isSyncing = false; syncRuntime.activeOperation = null; updateSyncUI();
    }
  }
}
function extractGistId(input) {
  var value = String(input || "").trim();
  var match = value.match(/^https:\/\/gist\.github\.com\/[^/]+\/([a-f0-9]+)(?:[/?#].*)?$/i);
  return match ? match[1] : value;
}
function syncInputConfig() {
  // Token is OPTIONAL everywhere: with only a Gist ID the journal opens in
  // read-only mode from a public Gist — no personal access token required.
  var token = dom.githubToken.value.trim(); var gistId = extractGistId(dom.gistId.value);
  if (!/^[a-f0-9]{5,64}$/i.test(gistId) || /[\r\n]/.test(token)) throw new Error("Введите правильный ID Gist (ссылку на публичный Gist тоже можно вставить целиком).");
  return syncOperationConfig(token, gistId);
}
function syncListen(element, event, handler) { if (element) element.addEventListener(event, handler); }
function syncFormPublicFlag() { return Boolean(dom.gistPublicCheckbox && dom.gistPublicCheckbox.checked); }
syncListen(dom.gistPublicCheckbox, "change", function () {
  if (dom.publicGistWarning) dom.publicGistWarning.hidden = !syncFormPublicFlag();
});
syncListen(dom.toggleSyncConfigButton, "click", function () {
  var open = dom.syncConfig.classList.toggle("open");
  dom.toggleSyncConfigButton.setAttribute("aria-expanded", String(open));
  if (open) { dom.githubToken.value = syncConfig.token; dom.gistId.value = syncConfig.gistId; if (dom.gistPublicCheckbox) dom.gistPublicCheckbox.checked = Boolean(syncConfig.isPublicGist); if (dom.publicGistWarning) dom.publicGistWarning.hidden = !syncConfig.isPublicGist; dom.githubToken.focus(); }
});
syncListen(dom.saveSyncConfigButton, "click", async function () {
  var proposed;
  try { proposed = syncInputConfig(); } catch (error) { showToast(error.message, "warning"); return; }
  dom.saveSyncConfigButton.disabled = true;
  try {
    var result = await fetchFromGist(proposed, { unconditional: true, noCache: true });
    syncCheckGeneration(proposed);
    // No token is fine: the Gist must simply be public — anonymous read works
    // from any domain through gist.githubusercontent.com (CORS-open). The
    // checkbox only confirms the user intends to share data publicly.
    if (!proposed.token && !syncFormPublicFlag()) {
      throw new Error("Для работы без токена Gist должен быть публичным: отметьте «Публичный Gist». Для отправки изменений в непубличный Gist укажите токен.");
    }
    syncInvalidate();
    syncConfig.token = proposed.token; syncConfig.gistId = proposed.gistId; syncConfig.enabled = true;
    syncConfig.isPublicGist = Boolean(result.gistPublic);
    syncConfig.lastSync = 0; syncConfig.lastSyncStatus = "off"; syncConfig.lastError = "";
    syncRuntime.hasPendingChanges = true;
    saveSyncConfig(); updateSyncUI();
    dom.syncConfig.classList.remove("open"); dom.toggleSyncConfigButton.setAttribute("aria-expanded", "false");
    startPolling();
    if (proposed.token) {
      await fullSync("manual");
      showToast(syncConfig.isPublicGist ? "Подключено. Публичный Gist с токеном: полная синхронизация." : "Подключение сохранено. Журнал синхронизирован.", "success");
    } else {
      // Read-only connection: load the public Gist right away instead of
      // waiting for the first poll tick, so the journal appears immediately
      // after saving the connection (fixes defect #4). fullSync("auto") used
      // to be dropped silently because syncAutomatic() is false without a
      // token — that left the journal never fetched and the status stuck on
      // "только чтение"/"сохранено локально". Run it as a manual cycle.
      try { await fullSync("manual"); } catch (error) {}
      showToast("Подключено в режиме «только чтение»: данные загружаются из публичного Gist. Для отправки изменений добавьте токен.", "warning");
    }
  } catch (error) { if (!error.stale) showToast(error.message, "error"); }
  finally { dom.saveSyncConfigButton.disabled = false; }
});
syncListen(dom.testConnectionButton, "click", async function () {
  var proposed;
  try { proposed = syncInputConfig(); } catch (error) { showToast(error.message, "warning"); return; }
  dom.testConnectionButton.disabled = true;
  try {
    var result = await fetchFromGist(proposed, { unconditional: true, noCache: true }); syncCheckGeneration(proposed);
    showToast("Связь установлена. " + (result.gistPublic ? "Gist публичный" : "Gist непубличный") + ", формат журнала проверен." + (proposed.token ? "" : " Доступ только для чтения."), "success");
  } catch (error) { if (!error.stale) showToast(error.message, "error"); }
  finally { dom.testConnectionButton.disabled = false; }
});
syncListen(dom.disableSyncButton, "click", function () {
  syncInvalidate();
  syncConfig.enabled = false; syncConfig.token = ""; syncConfig.gistId = ""; syncConfig.isPublicGist = false;
  syncConfig.lastSync = 0; syncConfig.lastSyncStatus = "off"; syncConfig.lastError = "";
  saveSyncConfig(); updateSyncUI(); dom.githubToken.value = ""; dom.gistId.value = "";
  if (dom.gistPublicCheckbox) dom.gistPublicCheckbox.checked = false;
  if (dom.publicGistWarning) dom.publicGistWarning.hidden = true;
  dom.syncConfig.classList.remove("open"); dom.toggleSyncConfigButton.setAttribute("aria-expanded", "false");
  showToast("Синхронизация отключена. Журнал сохранён на устройстве.");
});
syncListen(dom.syncNowButton, "click", function () { fullSync("manual"); });
syncListen(dom.forcePushButton, "click", forcePush);
syncListen(dom.forcePullButton, "click", forcePull);
if (dom.forcePushButton) dom.forcePushButton.textContent = "Отправить изменения";
syncListen(dom.intervalSelect, "change", function (event) {
  var interval = Number(event.target.value);
  if ([0, 5000, 15000, 30000, 60000, 300000].indexOf(interval) === -1) return;
  syncInvalidate(); syncRuntime.pollIntervalMs = interval; saveInterval(); startPolling(); updateSyncUI();
  if (interval > 0) scheduleSync();
  showToast(interval === 0 ? "Только вручную: автоматические запросы отключены" : "Автосинхронизация включена", "success");
});
document.addEventListener("visibilitychange", function () { if (!document.hidden && (syncAutomatic() || syncReadOnly())) pollOnce(); });
window.addEventListener("online", function () { updateSyncUI(); if (syncAutomatic() || syncReadOnly()) fullSync("auto"); });
window.addEventListener("offline", updateSyncUI);


// Always visible connection status; incoming notices survive subsequent no-op polls.
["syncOverview","syncOverviewText","syncOverviewDetail","syncQuickButton","syncNotice"].forEach(function(id){dom[id]=document.getElementById(id);});
function renderSyncOverview(){
  if(!dom.syncOverviewText)return;
  var conflictCount=Object.keys(offline.conflicts).length,count=queuedEntries().length;
  var title,detail;
  if(!syncConfigured()){
    title=syncConfig.enabled&&syncConfig.gistId?"Подключение приостановлено":"Только на этом устройстве";
    detail=syncConfig.enabled&&syncConfig.gistId?"Введите токен в подключении — изменения остаются в очереди.":"Для обмена отметками подключите один и тот же Gist на всех устройствах.";
  }else if(syncReadOnly()){title="Публичный Gist · только чтение";detail="Журнал загружается с GitHub без токена — вход открыт с любого домена. Правки сохраняются только на этом устройстве; токен нужен лишь для отправки изменений.";}
  else if(conflictCount){title="Нужно выбрать версии записей";detail="Конфликтов: "+conflictCount+". Откройте очередь ниже.";}
  else if(!syncOnline()){title="Без интернета";detail="Изменения сохранены здесь. В очереди: "+count+".";}
  else if(syncRuntime.isSyncing){title="Проверяем изменения…";detail="В очереди: "+count+". Можно продолжать работу.";}
  else if(syncConfig.lastSyncStatus==="error"){title="Не удалось синхронизировать";detail=syncConfig.lastError;}
  else {title=count?"Ожидают отправки: "+count:"Устройства синхронизированы";detail=(syncConfig.lastSync?"Проверено: "+formatTime(syncConfig.lastSync)+". ":"")+(syncRuntime.pollIntervalMs===0?"Отправка вручную.":"Проверка каждые "+syncRuntime.pollIntervalMs/1000+" с, пока вкладка открыта.");}
  dom.syncOverviewText.textContent=title;dom.syncOverviewDetail.textContent=detail;
  dom.syncOverview.dataset.state=conflictCount||syncConfig.lastSyncStatus==="error"?"error":syncWritable()?"connected":"local";
  dom.syncQuickButton.textContent=syncWritable()?"Обновить сейчас":syncConfigured()?"Добавить токен для записи":"Подключить устройства";
  dom.syncQuickButton.disabled=syncRuntime.isSyncing;
}
function announceIncoming(before,after,source){
  var a=flattenRecords(before),b=flattenRecords(after),keys=Object.keys(b).filter(function(k){return !isDataEqual(recordValue(a[k]),recordValue(b[k]));});
  if(!keys.length)return;
  syncRuntime.lastReceivedAt=Date.now();syncRuntime.lastReceivedCount=keys.length;
  var text=source+" · "+formatTime(syncRuntime.lastReceivedAt)+" · записей: "+keys.length;
  if(dom.syncNotice){dom.syncNotice.hidden=false;dom.syncNotice.textContent=text+". "+keys.slice(0,3).map(recordLabel).join("; ")+(keys.length>3?"…":"");}
  var keySet = new Set(keys);
  document.querySelectorAll(".attendance-button").forEach(function(button){
    if(keySet.has("attendance/"+button.dataset.studentId+"_"+button.dataset.dateKey))button.classList.add("just-received");
  });
  if(attendanceModalState.open){var entry=state.attendance[attendanceModalState.studentId+"_"+attendanceModalState.dateKey];attendanceModalState.currentStatus=entry?entry.status:STATUS_UNMARKED;updateAttendanceModalOptions();}
  showToast(text,"success");
}
syncListen(dom.syncQuickButton,"click",function(){
  if(syncWritable())return fullSync("manual");
  var panel=dom.syncConfig.closest("details");if(panel)panel.open=true;
  dom.syncConfig.classList.add("open");dom.toggleSyncConfigButton.setAttribute("aria-expanded","true");
  dom.githubToken.value=syncConfig.token;dom.gistId.value=syncConfig.gistId;
  if(syncConfigured()&&!syncWritable()){try{fullSync("manual");}catch(error){}}
  dom.syncConfig.scrollIntoView({behavior:"smooth",block:"center"});dom.githubToken.focus({preventScroll:true});
});
window.addEventListener("focus",function(){if((syncAutomatic()||syncReadOnly())&&Date.now()-syncRuntime.lastPullAt>2000)pollOnce();});

/* Relative URLs work both on user.github.io and user.github.io/repository/. */
var APP_VERSION = '3.3.0', APP_BUILD_ID = '9452c43ae2da225b';
var appUpdateRuntime = { checkedAt: 0, busy: false, available: '' };
async function checkAppUpdate(){
  if(!/^https?:$/.test(window.location.protocol)||!syncOnline()||document.hidden||appUpdateRuntime.busy||Date.now()-appUpdateRuntime.checkedAt<300000)return;
  appUpdateRuntime.checkedAt=Date.now();appUpdateRuntime.busy=true;
  var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},10000);
  try{
    var url=new URL('./version.json',window.location.href);url.searchParams.set('check',String(Date.now()));
    var response=await fetch(url.href,{cache:'no-store',signal:controller.signal});if(!response.ok)return;
    var release=await response.json();
    if(release.app!=='attendance-diary'||typeof release.build!=='string'||!/^[a-f0-9]{16}$/.test(release.build)||release.build===APP_BUILD_ID)return;
    appUpdateRuntime.available=release.build;
    var banner=document.getElementById('appUpdateBanner');if(banner)banner.hidden=false;
  }catch(error){/* Offline or a standalone HTML without a release manifest. */}
  finally{clearTimeout(timer);appUpdateRuntime.busy=false;}
}
function wireAppUpdates(){
  var button=document.getElementById('appUpdateButton');
  if(button)button.addEventListener('click',function(){
    if(!appUpdateRuntime.available||saveLocal()===false)return;
    var url=new URL(window.location.href);url.searchParams.set('v',appUpdateRuntime.available);window.location.replace(url.href);
  });
  if(/^https?:$/.test(window.location.protocol)){
    checkAppUpdate();setInterval(checkAppUpdate,300000);
    window.addEventListener('focus',checkAppUpdate);
    document.addEventListener('visibilitychange',checkAppUpdate);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

/* Full wipe implementation (project layer): marks every student, lesson and
   homework record as deleted across ALL classes, resets all attendance and
   lesson marks, saves a recovery backup first, and queues every changed
   record for synchronization. Classes and subjects are preserved. */
function runFullClear(){
  try{
    if(!effectivePermissions().canEditJournal||!effectivePermissions().canManageDevices){showToast("Полная очистка доступна учителю или тех. администрации","warning");return;}
    saveRecoveryBackup();
    // Mark every student, lesson, homework record deleted across ALL classes and
    // reset all attendance/lesson marks. Then hand the changed records to the
    // standard commit path (markChanged(keys)) so clocks, offline queue and sync
    // are updated exactly like any other edit. Classes and subjects stay intact.
    var keys=[];
    state.students.forEach(function(s){if(!s.deleted){s.deleted=true;s.updatedAt=nextTimestamp();s.actor=deviceId;keys.push("students/"+s.id);}});
    Object.keys(state.attendance||{}).forEach(function(k){var v=state.attendance[k];if(v&&v.status!==STATUS_UNMARKED){state.attendance[k]={status:STATUS_UNMARKED,updatedAt:nextTimestamp(),actor:deviceId};keys.push("attendance/"+k);}});
    (state.lessons||[]).forEach(function(l){if(!l.deleted){l.deleted=true;l.updatedAt=nextTimestamp();l.actor=deviceId;keys.push("lessons/"+l.id);}});
    (state.homework||[]).forEach(function(h){if(!h.deleted){h.deleted=true;h.updatedAt=nextTimestamp();h.actor=deviceId;keys.push(homeworkListKey+"/"+h.id);}});
    Object.keys(state.lessonMarks||{}).forEach(function(k){var v=state.lessonMarks[k];if(v&&v.status!=="unmarked"){state.lessonMarks[k]={status:"unmarked",updatedAt:nextTimestamp(),actor:deviceId};keys.push("lessonMarks/"+k);}});
    trackedPayload=buildPayload();
    markChanged(keys);saveLocal(true);render();scheduleSync();
    showToast("Журнал очищен: удалены все ученики, отметки, домашние задания и занятия. Восстановить: «Восстановить последнюю»","success");
  }catch(e){console.error(e);showToast("Очистка не выполнена: "+e.message,"error");}
}
