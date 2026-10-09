"use strict";

var STORAGE_KEY = "attendance_diary_data";
var SYNC_CONFIG_KEY = "attendance_sync_config";
var DEVICE_ID_KEY = "attendance_device_id";
var INTERVAL_KEY = "attendance_poll_interval";
var GIST_FILENAME = "attendance.json";
var DEFAULT_POLL_INTERVAL_MS = 5000, PUSH_DEBOUNCE_MS = 400;
var SETTINGS_UNLOCK_KEY = "attendance_settings_unlocked";
var SETTINGS_CODE_SET_KEY = "attendance_settings_code_set";
var BACKUP_KEY = "attendance_recovery_backups";
var NEWS_DISMISS_KEY = "attendance_news_dismissed";
var DEFAULT_VERSION_TEXT = "версия: 3.3";
var DEFAULT_MAINTENANCE_MSG = "Журнал временно на обслуживании. Попробуйте вернуться позже.";
var STATUS_PRESENT = "present", STATUS_ABSENT = "absent", STATUS_LATE = "late", STATUS_UNMARKED = "unmarked";
var statusLabels = { present: "Присутствует", absent: "Отсутствует", late: "Опоздал", unmarked: "Не отмечено" };
var statusSymbols = { present: "✓", absent: "Н", late: "О", unmarked: "·" };
var settingFields = ["maintenance", "maintenanceMessage", "maintenanceBy", "news", "versionText"];
var monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
var weekdayNames = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
var state = { students: [], attendance: {}, settings: defaultSettings(), selectedMonth: getMonthString(new Date()), searchQuery: "", revision: 0, lastSyncedRevision: 0, devUnlocked: false, deviceMeta: {}, homework: [] };
var syncConfig = { enabled: false, token: "", gistId: "", isPublicGist: false, lastSync: 0, lastSyncStatus: "off", lastError: "" };
var deviceId = "", logicalTime = 0, activeModal = null, previousFocus = null, modalStack = [];
var attendanceModalState = { open: false, studentId: "", dateKey: "", currentStatus: STATUS_UNMARKED };
var dom = {};
["studentName", "addStudentButton", "monthPicker", "previousMonthButton", "nextMonthButton", "todayButton", "monthTitle", "tableHead", "tableBody", "emptyMessage", "searchInput", "clearSearchButton", "searchResultsInfo", "noSearchResults", "toast", "syncStatus", "syncStatusText", "toggleSyncConfigButton", "syncConfig", "githubToken", "gistId", "gistPublicCheckbox", "publicGistWarning", "saveSyncConfigButton", "testConnectionButton", "disableSyncButton", "syncNowButton", "forcePushButton", "forcePullButton", "debugButton", "refreshDebugButton", "copyDebugButton", "debugBlock", "debugPre", "intervalSelect", "newsBanner", "newsText", "newsCloseButton", "versionButton", "versionButtonText", "journalEdition", "devPanelModal", "devCloseButton", "devExitButton", "devVersionTextInput", "devSaveVersionTextButton", "devResetVersionTextButton", "devToggleMaintenanceButton", "devMaintenanceMessageInput", "devSaveMaintenanceMessageButton", "devResetMaintenanceMessageButton", "devNewsInput", "devSaveNewsButton", "devClearNewsButton", "maintenanceOverlay", "maintenanceMessageText", "maintenanceActiveBadge", "maintenanceDevAccessButton", "attendanceModal", "attCloseButton", "attStudentName", "attDateText", "attOptions", "localSaveStatus", "exportBackupButton", "importBackupButton", "importBackupInput", "restoreBackupButton", "printButton", "summaryStudents", "summaryPresent", "summaryAbsent", "summaryLate", "coverageInfo", "journalApp", "printMonthTitle"].forEach(function (id) { dom[id] = document.getElementById(id); });
dom.studentNameInput = dom.studentName;
var storage = accessibleStorage("localStorage"), sessStorage = accessibleStorage("sessionStorage");

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
    result[id] = { name: name, seenAt: Number.isFinite(seenAt) && seenAt > 0 ? seenAt : 0, updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0 };
  });
  return result;
}
function mergeDeviceMeta(local, remote) {
  var result = Object.assign({}, local || {}), remoteData = remote || {};
  Object.keys(remoteData).forEach(function (id) {
    var incoming = remoteData[id], existing = result[id];
    if (!existing) { result[id] = incoming; return; }
    var mergedName = (incoming.updatedAt || 0) >= (existing.updatedAt || 0) ? incoming.name : existing.name;
    result[id] = { name: mergedName || existing.name || incoming.name, seenAt: Math.max(existing.seenAt || 0, incoming.seenAt || 0), updatedAt: Math.max(existing.updatedAt || 0, incoming.updatedAt || 0) };
  });
  return result;
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
function updateSettings(patch) {
  var time = nextTimestamp(); settingFields.forEach(function (field) { if (Object.prototype.hasOwnProperty.call(patch, field)) { state.settings[field] = patch[field]; state.settings.fieldMeta[field] = { updatedAt: time, actor: deviceId }; } });
  state.settings.updatedAt = time; markChanged(Object.keys(patch).map(function(f){return "settings/"+f;})); saveLocal(); render(); scheduleSync();
}
function getVisibleStudents() { return state.students.filter(function (s) { return !s.deleted && (s.classId || "class-main") === (state.selectedClass || "class-main"); }).sort(function (a, b) { return a.name.localeCompare(b.name, "ru") || a.id.localeCompare(b.id); }); }
function getStudentById(id) { return state.students.find(function (s) { return s.id === id; }) || null; }
function getFilteredStudents() { var q = state.searchQuery.trim().toLocaleLowerCase("ru"); return getVisibleStudents().filter(function (s) { return !q || s.name.toLocaleLowerCase("ru").includes(q); }); }
function addStudent() {
  var name = dom.studentNameInput.value.trim().replace(/\s+/g, " ");
  if (!name) { dom.studentNameInput.focus(); showToast("Введите имя ученика", "warning"); return; }
  if (name.length > 200) { showToast("Имя должно быть короче 200 символов", "warning"); return; }
  state.students.push({ id: generateId(), name: name, updatedAt: nextTimestamp(), actor: deviceId, deleted: false, classId: state.selectedClass || "class-main" });
  dom.studentNameInput.value = ""; markChanged(["students/"+state.students[state.students.length-1].id]); saveLocal(); render(); scheduleSync(); dom.studentNameInput.focus(); showToast("Ученик добавлен", "success");
}
function renameStudent(id) {
  var student = getStudentById(id); if (!student || student.deleted) return;
  var name = window.prompt("Имя ученика", student.name); if (name === null) return; name = name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 200) { showToast("Введите имя длиной до 200 символов", "warning"); return; }
  if (name === student.name) return; student.name = name; student.updatedAt = nextTimestamp(); student.actor = deviceId;
  markChanged(["students/"+id]); saveLocal(); render(); scheduleSync();
}
function removeStudent(id) {
  var student = getStudentById(id); if (!student || student.deleted) return;
  if (!window.confirm("Удалить ученика «" + student.name + "» из журнала? Перед удалением будет сохранена резервная копия.")) return;
  try { saveRecoveryBackup(); } catch (e) { showToast("Удаление отменено: " + e.message, "error"); return; }
  student.deleted = true; student.updatedAt = nextTimestamp(); student.actor = deviceId;
  markChanged(["students/"+id]); saveLocal(); render(); scheduleSync(); showToast("Ученик удалён. Доступно восстановление из копии.", "success");
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
  if (!attendanceModalState.open || !Object.prototype.hasOwnProperty.call(statusLabels, status)) return;
  var student = getStudentById(attendanceModalState.studentId); if (!student || student.deleted) { closeAttendanceModal(); return; }
  var key = student.id + "_" + attendanceModalState.dateKey;
  state.attendance[key] = { status: status, updatedAt: nextTimestamp(), actor: deviceId };
  markChanged(["attendance/"+key]); saveLocal(); render(); scheduleSync(); closeAttendanceModal();
}
function changeMonth(offset) { var d = parseMonth(state.selectedMonth); d.setMonth(d.getMonth() + offset); if (d.getFullYear() < 1000 || d.getFullYear() > 9999) return; state.selectedMonth = getMonthString(d); state.selectedDate = formatDateKey(d); render(); }
function element(tag, className, text) { var el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function renderHeader(days) {
  var row = element("tr"), first = element("th", "student-column", "Ученик"); first.scope = "col"; row.appendChild(first);
  days.forEach(function (day) { var th = element("th", (isWeekend(day) ? "weekend " : "") + (isToday(day) ? "today-column" : "")); th.scope = "col"; th.dataset.dateKey = formatDateKey(day); th.appendChild(element("span", "date-number", day.getDate())); th.appendChild(element("span", "weekday", weekdayNames[day.getDay()])); th.setAttribute("aria-label", day.toLocaleDateString("ru-RU")); row.appendChild(th); });
  var actions = element("th", "actions-column", "Действия"); actions.scope = "col"; row.appendChild(actions); dom.tableHead.replaceChildren(row);
}
function renderBody(days) {
  var visible = getVisibleStudents(), filtered = getFilteredStudents(), fragment = document.createDocumentFragment();
  dom.emptyMessage.style.display = visible.length ? "none" : "block"; dom.noSearchResults.style.display = visible.length && !filtered.length ? "block" : "none";
  filtered.forEach(function (student) {
    var row = element("tr"), name = element("th", "student-name-cell"); name.scope = "row";
    var flex = element("div", "student-name-flex"); flex.appendChild(element("span", "student-number", visible.indexOf(student) + 1));
    var text = element("button", "student-name-text student-card-trigger", student.name); text.type = "button"; text.title = "Открыть карточку: " + student.name; text.dataset.action = "card"; text.dataset.studentId = student.id; text.setAttribute("aria-label", "Карточка ученика: " + student.name); text.setAttribute("aria-haspopup", "dialog"); flex.appendChild(text); name.appendChild(flex); row.appendChild(name);
    days.forEach(function (day) {
      var dateKey = formatDateKey(day), value = normalizeStatusEntry(state.attendance[student.id + "_" + dateKey]), status = value ? value.status : STATUS_UNMARKED;
      var cell = element("td", (isWeekend(day) ? "weekend " : "") + (isToday(day) ? "today-column" : "")), btn = element("button", "attendance-button " + status, state.viewMode === "day" ? statusSymbols[status] + " " + statusLabels[status] : statusSymbols[status]);
      if(state.viewMode === "day"){
        btn.replaceChildren(element("span","day-status-icon",statusSymbols[status]),element("span","day-status-label",{present:"Был",absent:"Нет",late:"Опоздал",unmarked:"Отметить"}[status]));
      }
      btn.type = "button"; btn.dataset.studentId = student.id; btn.dataset.dateKey = dateKey;
      btn.title = statusLabels[status]; btn.setAttribute("aria-label", student.name + ", " + day.toLocaleDateString("ru-RU") + ": " + statusLabels[status]); cell.appendChild(btn); row.appendChild(cell);
    });
    var actions = element("td", "actions-column"), edit = element("button", "secondary row-edit", "Изменить"), remove = element("button", "row-remove", "Удалить");
    edit.type = remove.type = "button"; edit.dataset.action = "rename"; remove.dataset.action = "remove"; edit.dataset.studentId = remove.dataset.studentId = student.id;
    edit.setAttribute("aria-label", "Изменить имя: " + student.name); remove.setAttribute("aria-label", "Удалить: " + student.name); actions.append(edit, remove); row.appendChild(actions); fragment.appendChild(row);
  }); dom.tableBody.replaceChildren(fragment);
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
function render() {
  var focused = document.activeElement, days = getDisplayedDays();
  renderViewControls(days); dom.printMonthTitle.textContent = dom.monthTitle.textContent;
  renderHeader(days); renderBody(days); renderSummary(days); renderStudentCard(); renderProject();
  dom.searchResultsInfo.textContent = state.searchQuery.trim() ? "Найдено " + getFilteredStudents().length + " из " + getVisibleStudents().length : "Всего " + getVisibleStudents().length;
  dom.clearSearchButton.hidden = !state.searchQuery; dom.versionButtonText.textContent = state.settings.versionText; dom.versionButton.setAttribute("aria-label", state.settings.versionText + ". Открыть настройки по коду"); if (dom.journalEdition) dom.journalEdition.textContent = settingsVersionText(); renderNews(); renderMaintenance(); renderHomework(); renderOffline();
  if (!activeModal && focused && focused.dataset && focused.dataset.dateKey && !focused.isConnected) { var replacement = document.querySelector('.attendance-button[data-student-id="' + focused.dataset.studentId + '"][data-date-key="' + focused.dataset.dateKey + '"]'); if (replacement) replacement.focus(); }
}
function refreshDevPanel() {
  dom.devVersionTextInput.value = state.settings.versionText; dom.devMaintenanceMessageInput.value = state.settings.maintenanceMessage; dom.devNewsInput.value = state.settings.news;
  dom.devToggleMaintenanceButton.textContent = state.settings.maintenance ? "Завершить обслуживание" : "Включить экран обслуживания";
  dom.devToggleMaintenanceButton.className = state.settings.maintenance ? "danger" : "secondary";
  renderDeviceList();
}
function openDevPanel() { if (!state.devUnlocked) { openPasswordModal(); return; } refreshDevPanel(); renderMaintenance(); openModal(dom.devPanelModal, dom.devVersionTextInput); }
function collapseDevPanel() { closeModal(); renderMaintenance(); }
function exitDevSettings() { state.devUnlocked = false; try { if (storage) storage.removeItem(SETTINGS_UNLOCK_KEY); } catch (error) {} closeModal(); renderMaintenance(); if (dom.journalEdition) dom.journalEdition.textContent = settingsVersionText(); showToast("Вы вышли из настроек. Для возврата потребуется код доступа.", "info"); }
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
function settingsVersionText() { return "Версия " + settingsEditionText(); }
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
function restoreBackup() {
  try { var backups = storage && JSON.parse(storage.getItem(BACKUP_KEY) || "[]"); if (!backups || !backups.length) { showToast("Пока нет автоматических резервных копий", "warning"); return; }
    var last = backups[0], data = migrateData(last.data, true); if (!window.confirm("Восстановить журнал из копии от " + new Date(last.savedAt).toLocaleString("ru-RU") + "? Текущая версия тоже будет сохранена.")) return; saveRecoveryBackup(); restoreData(data); showToast("Журнал восстановлен", "success");
  } catch (e) { showToast("Не удалось восстановить: " + e.message, "error"); }
}
function wireCoreEvents() {
  dom.addStudentButton.addEventListener("click", addStudent);
  dom.studentNameInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addStudent(); } });
  dom.monthPicker.addEventListener("change", function (e) { try { var d = parseMonth(e.target.value); state.selectedMonth = e.target.value; state.selectedDate = formatDateKey(d); render(); } catch (error) { e.target.value = state.selectedMonth; } });
  dom.previousMonthButton.addEventListener("click", function () { changePeriod(-1); }); dom.nextMonthButton.addEventListener("click", function () { changePeriod(1); }); dom.todayButton.addEventListener("click", goToToday);
  dom.searchInput.addEventListener("input", function (e) { state.searchQuery = e.target.value; render(); });
  dom.clearSearchButton.addEventListener("click", function () { state.searchQuery = ""; dom.searchInput.value = ""; render(); dom.searchInput.focus(); });
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
  dom.newsCloseButton.addEventListener("click", function () { try { if (storage) storage.setItem(NEWS_DISMISS_KEY, state.settings.news.trim()); } catch (e) {} dom.newsBanner.classList.remove("visible"); });
  dom.exportBackupButton.addEventListener("click", exportBackup); dom.importBackupButton.addEventListener("click", function () { dom.importBackupInput.click(); }); dom.restoreBackupButton.addEventListener("click", restoreBackup); dom.printButton.addEventListener("click", function () { window.print(); });
  dom.importBackupInput.addEventListener("change", async function (e) {
    var file = e.target.files[0]; if (!file) return;
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
  loadViewPreference(); dom.intervalSelect.value = String(syncRuntime.pollIntervalMs); wireCoreEvents(); wireViewEvents(); wireProjectEvents(); wireAppUpdates(); updateSyncUI(); render();
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
  render(); dom.attendanceTableWrapper.scrollLeft = 0;
}
function changePeriod(offset) {
  if (state.viewMode === "month") { changeMonth(offset); return; }
  var date = selectedDate(); date.setDate(date.getDate() + offset * (state.viewMode === "week" ? 7 : 1));
  if (setSelectedDate(date)) render();
}
function goToToday() {
  setSelectedDate(new Date()); render();
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
  var stats = document.createDocumentFragment(); [["present", "Присутствия"], ["absent", "Пропуски"], ["late", "Опоздания"]].forEach(function (item) { var card = element("div", "card-stat " + item[0]); card.appendChild(element("strong", "", counts[item[0]])); card.appendChild(element("span", "", item[1])); stats.appendChild(card); }); dom.studentCardStats.replaceChildren(stats);
}
function wireViewEvents() {
  var navigation=document.getElementById("glassNavigation");
  if(navigation)navigation.addEventListener("click",function(event){
    var button=event.target.closest("[data-nav]");if(!button)return;
    var destination=button.dataset.nav;
    if(!["reports","settings"].includes(destination))navigation.querySelectorAll("[data-nav]").forEach(function(item){item.classList.toggle("is-active",item===button);if(item===button)item.setAttribute("aria-current","location");else item.removeAttribute("aria-current");});
    if(destination==="reports"){dom.reportsButton.click();return;}
    if(destination==="settings"){dom.versionButton.click();return;}
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
var projectDomIds = ['classPicker','addClassButton','reportsButton','lessonsPanel','lessonDate','lessonSubject','lessonEnd','lessonStatus','lessonCreate','addSubjectButton','lessonList','lessonModal','lessonTitle','lessonRoster','lessonClose','lessonState','lessonDelete','studentClassPicker','studentClassMove'];
projectDomIds.forEach(function(id) { dom[id] = document.getElementById(id); });
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
function commitProject(keys){markChanged(keys);saveLocal();render();scheduleSync();}
function createNamed(type){var name=window.prompt(type==='classes'?'Название класса':'Название предмета');if(name===null)return;name=name.trim();if(!name||name.length>200)return showToast('Введите название до 200 символов','warning');var existing=state[type].find(function(x){return !x.deleted&&x.name.toLowerCase()===name.toLowerCase();});if(existing)return showToast('Такое название уже есть','warning');var item={id:generateId(),name:name,updatedAt:nextTimestamp(),actor:deviceId,deleted:false};state[type].push(item);if(type==='classes')state.selectedClass=item.id;commitProject([type+'/'+item.id]);if(type==='subjects'&&dom.lessonSubject)dom.lessonSubject.value=item.id;}
function createLesson(){
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
    var input=event.target.closest('.device-input');if(!input||!input.dataset.deviceId)return;
    var id=input.dataset.deviceId,name=(input.value||'').trim().slice(0,40);
    var meta=state.deviceMeta||(state.deviceMeta={});var entry=meta[id]||(meta[id]={seenAt:0});
    if(id!==deviceId&&!syncWritable())return showToast('Переименование других устройств требует токен для отправки','warning');
    entry.name=name;entry.seenAt=Math.max(entry.seenAt||0,id===deviceId?Date.now():0);
    saveLocal();scheduleSync();renderDeviceList();showToast(name?'Имя устройства сохранено':'Имя устройства очищено','success');
  });
  wireReportEvents();wireOfflineEvents();
}

["hwPanel","hwDueDate","hwClassName","hwText","hwPinButton","hwClearButton","hwAddButton","hwHistory","syncDeviceList","refreshDeviceListButton"].forEach(function(id){dom[id]=document.getElementById(id);});

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
    var row=el('div',undefined,'lesson-list-item hw-item');
    var dueTxt=h.dueDate?new Date(h.dueDate+'T00:00:00').toLocaleDateString('ru-RU'):'не указана';var overdue=!!h.dueDate&&h.dueDate<formatDateKey(new Date());var meta=el('span',(overdue?'⚠ Просрочено · ':'')+'Сдать к: '+dueTxt+' · добавлено '+new Date(h.updatedAt).toLocaleDateString('ru-RU'),'hw-meta'+(overdue?' hw-overdue':''));
    var body=el('span',h.text,'hw-text');
    var del=el('button','×','secondary icon-button hw-delete');del.type='button';del.title='Убрать это задание';
    del.addEventListener('click',function(){deleteHomeworkEntry(h.id);});
    row.append(body,meta,del);dom.hwHistory.appendChild(row);
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
function resolveConflict(key,index){var choices=offline.conflicts[key];if(!choices||!choices[index])return;var selected=copy(choices[index]),clock={};choices.forEach(function(v){clock=unionClocks(clock,cleanClock(v.clock,v.updatedAt));});var time=nextTimestamp();clock[causalActor()]=time;selected.clock=clock;selected.updatedAt=time;selected.actor=deviceId;var data=buildPayload();putRecord(data,key,selected);applyMergedToState(data);offline.queue[key]={op:generateId()+'-'+time,time:time,done:false};delete offline.conflicts[key];state.revision++;syncRuntime.hasPendingChanges=true;saveLocal();render();scheduleSync();showToast('Выбранная запись сохранена и ожидает отправки','success');}
var offlineListSignature="";
function renderOffline(){if(!dom.queueCount)return;var count=queuedEntries().length,conflicts=Object.keys(offline.conflicts);dom.queueCount.textContent=String(count);dom.lastSyncTime.textContent=formatTime(syncConfig.lastSync);dom.offlineStatus.textContent=conflicts.length?'Нужен выбор: конфликтов '+conflicts.length:!syncOnline()?'Нет интернета · изменения сохраняются здесь':count?(syncConfigured()?(syncRuntime.pollIntervalMs===0?'Изменения ждут ручной отправки':'Изменения ожидают отправки'):'Изменения сохранены · подключите синхронизацию'):(syncConfigured()?'Все изменения отправлены':'Сохранено только на этом устройстве');dom.offlineStatus.classList.toggle('has-conflicts',!!conflicts.length);var signature=JSON.stringify([offline.queue,offline.conflicts]);
if(signature===offlineListSignature)return;offlineListSignature=signature;
dom.queueList.replaceChildren();queuedEntries().sort(function(a,b){return offline.queue[b].time-offline.queue[a].time;}).slice(0,100).forEach(function(k){dom.queueList.appendChild(el('li',recordLabel(k)+' · '+formatTime(offline.queue[k].time)));});if(count>100)dom.queueList.appendChild(el('li','Показаны последние 100 из '+count+' записей'));dom.conflictList.replaceChildren();conflicts.forEach(function(k){var box=el('article',undefined,'conflict-card');box.appendChild(el('strong',recordLabel(k)));offline.conflicts[k].forEach(function(v,i){var b=el('button',variantText(v)+' · '+formatTime(v.updatedAt)+(v.actor===deviceId?' · это устройство':' · другое устройство'),'secondary');b.type='button';b.addEventListener('click',function(){resolveConflict(k,i);});box.appendChild(b);});dom.conflictList.appendChild(box);});if(conflicts.length)dom.offlineDetails.open=true;}
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
  dom.reportNote.textContent='Опоздание считается посещением. Процент по классу и предмету считается по всем заполненным отметкам, а не как среднее процентов учеников. Дневные отметки без предмета ('+Object.keys(state.attendance).length+') в отчёт не включены.';
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
  var info=[['Отчёт посещаемости','Значение'],['Период',report.options.start+' — '+report.options.end],['Класс',report.options.classId?named('classes',report.options.classId):'Все классы'],['Предмет',report.options.subjectId?named('subjects',report.options.subjectId):'Все предметы'],['Ученик',report.options.studentId?named('students',report.options.studentId):'Все ученики'],['Сформирован',new Date(report.generatedAt).toLocaleString('ru-RU')],['Правило','(Присутствия + опоздания) / заполненные отметки прошедших проведённых занятий'],['Проведено занятий',report.held],['Исключено занятий',report.excludedLessons],['Заполнено отметок',report.marked],['Без отметки',report.unmarked],['Посещаемость',percent(report.rate)],['Дневные отметки','Не входят в отчёты по предметам'],['Время','Окончание занятия сравнивается с местным временем устройства']];sheets.push({name:'Об отчёте',rows:info,widths:[32,95]});
  ['students','classes','subjects'].forEach(function(type){var rows=[['Имя / название','Присутствия','Опоздания','Пропуски','Отмечено','Посещаемость','Без отметки']];report.groups[type].forEach(function(g){var n=rows.length+1;rows.push([g.name,g.present,g.late,g.absent,g.marked,g.marked?{formula:'(B'+n+'+C'+n+')/E'+n,value:g.rate}:'—',g.unmarked]);});sheets.push({name:{students:'Ученики',classes:'Классы',subjects:'Предметы'}[type],rows:rows,widths:[35,16,16,16,16,20,18],filter:true});});
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
  function start(){pageNo++;canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,W,H);ctx.fillStyle='#166b73';ctx.font='bold 42px Arial';ctx.fillText('Отчёт посещаемости',margin,95);ctx.fillStyle='#34494c';ctx.font='24px Arial';ctx.fillText(report.options.start+' — '+report.options.end+'  ·  '+({students:'По ученикам',classes:'По классам',subjects:'По предметам'}[report.options.group]),margin,139);ctx.font='20px Arial';var filter='Класс: '+(report.options.classId?named('classes',report.options.classId):'Все')+' · Предмет: '+(report.options.subjectId?named('subjects',report.options.subjectId):'Все')+' · Ученик: '+(report.options.studentId?named('students',report.options.studentId):'Все');var lines=wrapCanvas(ctx,filter,W-margin*2);y=174;lines.forEach(function(line){ctx.fillText(line,margin,y);y+=25;});ctx.fillText('Посещаемость '+percent(report.rate)+' · Проведено занятий '+report.held+' · Отмечено '+report.marked+' из '+report.slots+' · Без отметки '+report.unmarked,margin,y+12);y+=42;ctx.fillStyle='#166b73';ctx.fillRect(margin,y,W-2*margin,52);ctx.fillStyle='#ffffff';ctx.font='bold 20px Arial';['Имя / название','Был','Опоздал','Пропустил','Отмечено','Посещаемость'].forEach(function(v,i){ctx.fillText(v,cols[i]+12,y+33);});y+=52;ctx.fillStyle='#67787a';ctx.font='18px Arial';ctx.fillText('Будущие, непроведённые занятия и пустые отметки исключены. Опоздание = посещение.',margin,H-78);ctx.fillText('Дневные отметки без предмета не включены. Сформирован '+new Date(report.generatedAt).toLocaleString('ru-RU'),margin,H-51);ctx.fillText('Стр. '+pageNo,W-145,H-51);}
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
function syncReadOnly() { return syncConfigured() && !syncConfig.token; }
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
    var interval = raw === null || raw === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(raw);
    // Upgrade the former default once; manual mode and other choices survive.
    if(storage && !storage.getItem("attendance_sync_speed_v32")) {
      if(interval === 30000) { interval=5000; storage.setItem(INTERVAL_KEY,"5000"); }
      storage.setItem("attendance_sync_speed_v32","1");
    }
    if ([0, 5000, 15000, 30000, 60000].indexOf(interval) !== -1) syncRuntime.pollIntervalMs = interval;
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
async function fetchPublicGistFiles(config) {
  // Anonymous read of a public Gist works from ANY domain and needs NO token:
  // gist.githubusercontent.com answers with "Access-Control-Allow-Origin: *",
  // so the browser never blocks these requests. Strategy:
  // 1) enumerate journal files via the public embed page (no redirect needed);
  // 2) if that page is unavailable, follow the short gist URL once in "manual"
  //    mode and read the Location header (opaque-redirect trick, no CORS);
  // 3) download every file's raw content directly from gist.githubusercontent.com.
  // api.github.com and personal access tokens are only needed for WRITING.
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
        if ((name === GIST_FILENAME || /^attendance\.device\.[a-zA-Z0-9_.-]+\.json$/.test(name)) && found.indexOf(name) === -1) found.push(name);
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
  // Step 3: download every journal file straight from the CORS-open raw host.
  var result = {};
  for (var ni = 0; ni < names.length; ni++) {
    var fileName = names[ni];
    var rawResponse = await anonFetch("https://gist.githubusercontent.com/" + encodeURIComponent(gistId) + "/raw/" + encodeURIComponent(fileName), {});
    if (!rawResponse.ok) {
      throw new Error("Не удалось скачать файл «" + fileName + "» из публичного Gist (код " + rawResponse.status + "). Проверьте, что Gist публичный.");
    }
    result[fileName] = { content: rawResponse.text, truncated: false, raw_url: "" };
  }
  if (!Object.keys(result).length) {
    throw new Error("Не удалось найти файлы журнала в публичном Gist. Убедитесь, что синхронизация с этим Gist уже выполнялась с токеном (например, кнопкой «Отправить изменения»), или введите токен для непубличного Gist.");
  }
  return result;
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
    var anonFiles = await fetchPublicGistFiles(config);
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
  renderDeviceList();
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
  }, typeof PUSH_DEBOUNCE_MS === "number" ? PUSH_DEBOUNCE_MS : 1500);
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
  if (!syncConfigured()) {
    container.innerHTML = '<p class="help-text">Подключите Gist в разделе «Синхронизация», чтобы увидеть список устройств.</p>';
    return;
  }
  var meta = state.deviceMeta || {};
  var ids = Object.keys(meta);
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
    container.appendChild(row);
  });
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
  var delays = [5000, 10000, 20000, 30000, 60000];
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
        syncRuntime.lastPullAt = Date.now(); syncSuccess(reason, state.revision, true); return;
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
  if ([0, 5000, 15000, 30000, 60000].indexOf(interval) === -1) return;
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
  document.querySelectorAll(".attendance-button").forEach(function(button){
    if(keys.indexOf("attendance/"+button.dataset.studentId+"_"+button.dataset.dateKey)!==-1)button.classList.add("just-received");
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