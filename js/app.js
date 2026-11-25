import {
  APP_VERSION,
  DEFAULT_SETTINGS,
  DEFAULT_STATUSES,
  PRIORITIES,
  PRIORITY_MAP,
  STATUS_COLORS
} from './constants.js';
import {
  isStoragePersisted,
  loadAppState,
  requestPersistentStorage,
  saveAppState
} from './db.js';
import {
  compareTasksChronologically,
  generateId,
  sortTitleHistory
} from './migrations.js';
import { BackupManager } from './backup.js';
import { AppUpdater } from './updater.js';
import { attachSwipeGesture } from './swipe.js';

const SWIPE_HINT_SEEN_KEY = 'arvi_swipe_hint_seen';

let state = {
  tasks: [],
  statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
  settings: { ...DEFAULT_SETTINGS },
  titleHistory: []
};

let backupStatus = null;
let deferredInstallPrompt = null;
let toastTimer = null;
let toastActionHandler = null;
let lastChangedTaskId = null;
let newStatusColor = STATUS_COLORS[2];

const backupManager = new BackupManager((status) => {
  backupStatus = status;
  renderBackupIndicators();
});
const updater = new AppUpdater();

// DOM references
const els = {
  headerSummary: document.getElementById('headerSummary'),
  backupIndicatorBtn: document.getElementById('backupIndicatorBtn'),
  backupDot: document.getElementById('backupDot'),
  openSettingsBtn: document.getElementById('openSettingsBtn'),
  backupPermissionBanner: document.getElementById('backupPermissionBanner'),
  backupBannerDetail: document.getElementById('backupBannerDetail'),
  reauthorizeBannerBtn: document.getElementById('reauthorizeBannerBtn'),
  installBanner: document.getElementById('installBanner'),
  installPwaBtn: document.getElementById('installPwaBtn'),
  dismissInstallBtn: document.getElementById('dismissInstallBtn'),
  toolbarStats: document.getElementById('toolbarStats'),
  toggleDoneBtn: document.getElementById('toggleDoneBtn'),
  toggleDoneLabel: document.getElementById('toggleDoneLabel'),
  taskList: document.getElementById('taskList'),
  swipeHint: document.getElementById('swipeHint'),
  emptyState: document.getElementById('emptyState'),
  emptyTitle: document.getElementById('emptyTitle'),
  emptyMessage: document.getElementById('emptyMessage'),
  emptyAddBtn: document.getElementById('emptyAddBtn'),
  addTaskFab: document.getElementById('addTaskFab'),

  // Task Sheet
  taskSheetBackdrop: document.getElementById('taskSheetBackdrop'),
  taskSheetTitle: document.getElementById('taskSheetTitle'),
  closeTaskSheetBtn: document.getElementById('closeTaskSheetBtn'),
  cancelTaskBtn: document.getElementById('cancelTaskBtn'),
  deleteTaskBtn: document.getElementById('deleteTaskBtn'),
  taskForm: document.getElementById('taskForm'),
  taskIdInput: document.getElementById('taskIdInput'),
  titleAutocomplete: document.getElementById('titleAutocomplete'),
  taskTitleInput: document.getElementById('taskTitleInput'),
  titleSuggestions: document.getElementById('titleSuggestions'),
  taskDeadlineInput: document.getElementById('taskDeadlineInput'),
  taskTimeInput: document.getElementById('taskTimeInput'),
  quickDateChips: document.getElementById('quickDateChips'),
  priorityPicker: document.getElementById('priorityPicker'),
  statusPicker: document.getElementById('statusPicker'),
  taskNotesInput: document.getElementById('taskNotesInput'),

  // Settings Sheet
  settingsSheetBackdrop: document.getElementById('settingsSheetBackdrop'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  statusEditorList: document.getElementById('statusEditorList'),
  addStatusForm: document.getElementById('addStatusForm'),
  newStatusNameInput: document.getElementById('newStatusNameInput'),
  newStatusColorPalette: document.getElementById('newStatusColorPalette'),
  newStatusDoneInput: document.getElementById('newStatusDoneInput'),
  backupFolderDisplay: document.getElementById('backupFolderDisplay'),
  backupTimeDisplay: document.getElementById('backupTimeDisplay'),
  backupStateDisplay: document.getElementById('backupStateDisplay'),
  storagePersistDisplay: document.getElementById('storagePersistDisplay'),
  chooseFolderBtn: document.getElementById('chooseFolderBtn'),
  reauthorizeFolderBtn: document.getElementById('reauthorizeFolderBtn'),
  backupNowBtn: document.getElementById('backupNowBtn'),
  disconnectFolderBtn: document.getElementById('disconnectFolderBtn'),
  downloadBackupBtn: document.getElementById('downloadBackupBtn'),
  restoreFileBtn: document.getElementById('restoreFileBtn'),
  restoreFileInput: document.getElementById('restoreFileInput'),
  folderBackupsSection: document.getElementById('folderBackupsSection'),
  folderBackupsList: document.getElementById('folderBackupsList'),
  internalSnapshotsList: document.getElementById('internalSnapshotsList'),
  appVersionDisplay: document.getElementById('appVersionDisplay'),
  checkUpdatesBtn: document.getElementById('checkUpdatesBtn'),
  updateResultBox: document.getElementById('updateResultBox'),
  themePicker: document.getElementById('themePicker'),

  // Toast
  toast: document.getElementById('toast'),
  toastMessage: document.getElementById('toastMessage'),
  toastActionBtn: document.getElementById('toastActionBtn')
};

/* ---------- Date & Formatting Helpers (Finnish) ---------- */

function toDateInputString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTodayDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function parseLocalDate(yyyyMmDd) {
  if (!yyyyMmDd) return null;
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

const WEEKDAYS_FI = ['Su', 'Ma', 'Ti', 'Ke', 'To', 'Pe', 'La'];

function formatDeadlineInfo(deadline, deadlineTime, isDone) {
  const dateObj = parseLocalDate(deadline);
  if (!dateObj) {
    return { text: 'Ei määräaikaa', urgency: 'normal' };
  }

  const today = getTodayDate();
  const diffDays = Math.round((dateObj.getTime() - today.getTime()) / 86400000);
  const weekday = WEEKDAYS_FI[dateObj.getDay()];
  const day = dateObj.getDate();
  const month = dateObj.getMonth() + 1;
  const showYear = dateObj.getFullYear() !== today.getFullYear();
  const dateShort = showYear ? `${weekday} ${day}.${month}.${dateObj.getFullYear()}` : `${weekday} ${day}.${month}.`;
  const timeSuffix = deadlineTime ? ` klo ${deadlineTime}` : '';

  if (isDone) {
    return { text: `${dateShort}${timeSuffix}`, urgency: 'done' };
  }
  if (diffDays < 0) {
    const overdue = Math.abs(diffDays);
    const label = overdue === 1 ? 'Myöhässä 1 pv' : `Myöhässä ${overdue} pv`;
    return { text: `${label} (${dateShort}${timeSuffix})`, urgency: 'overdue' };
  }
  if (diffDays === 0) {
    return { text: `Tänään${timeSuffix}`, urgency: 'soon' };
  }
  if (diffDays === 1) {
    return { text: `Huomenna${timeSuffix}`, urgency: 'soon' };
  }
  if (diffDays <= 6) {
    return { text: `${dateShort}${timeSuffix} (${diffDays} pv)`, urgency: 'normal' };
  }
  return { text: `${dateShort}${timeSuffix}`, urgency: 'normal' };
}

function formatDateTimeFi(isoOrMs) {
  if (!isoOrMs) return 'Ei vielä tallennettu';
  const d = new Date(isoOrMs);
  if (Number.isNaN(d.getTime())) return 'Tuntematon';
  return d.toLocaleString('fi-FI', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/* ---------- Theme ---------- */

const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(themePref) {
  const effective = themePref === 'system' ? (darkMediaQuery.matches ? 'dark' : 'light') : themePref;
  document.documentElement.setAttribute('data-theme', effective);
  els.themePicker.querySelectorAll('.choice-btn').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.theme === themePref);
  });
}

darkMediaQuery.addEventListener('change', () => {
  if (state.settings.theme === 'system') {
    applyTheme('system');
  }
});

/* ---------- State Persistence & Auto-Backup ---------- */

async function persistAndBackup(reason = 'change') {
  await saveAppState(state);
  backupManager.scheduleAutoBackup(state, reason);
}

function getStatusById(id) {
  return state.statuses.find((s) => s.id === id) || state.statuses[0];
}

function getStatusIndex(id) {
  const idx = state.statuses.findIndex((s) => s.id === id);
  return idx >= 0 ? idx : 0;
}

/* ---------- Toast Notification ---------- */

function showToast(message, actionLabel = null, onAction = null, durationMs = 4200) {
  if (toastTimer) clearTimeout(toastTimer);
  els.toastMessage.textContent = message;
  toastActionHandler = onAction;

  if (actionLabel && onAction) {
    els.toastActionBtn.textContent = actionLabel;
    els.toastActionBtn.classList.remove('hidden');
  } else {
    els.toastActionBtn.classList.add('hidden');
  }

  els.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => {
    els.toast.classList.add('hidden');
    toastActionHandler = null;
  }, durationMs);
}

els.toastActionBtn.addEventListener('click', () => {
  if (toastActionHandler) {
    const fn = toastActionHandler;
    toastActionHandler = null;
    els.toast.classList.add('hidden');
    fn();
  }
});

/* ---------- Render Main List ---------- */

function renderApp() {
  const sorted = [...state.tasks].sort(compareTasksChronologically);
  const doneCount = sorted.filter((t) => getStatusById(t.statusId)?.isDone).length;
  const openTasks = sorted.filter((t) => !getStatusById(t.statusId)?.isDone);
  const overdueCount = openTasks.filter((t) => {
    const d = parseLocalDate(t.deadline);
    return d && d.getTime() < getTodayDate().getTime();
  }).length;

  // Header subtitle
  if (sorted.length === 0) {
    els.headerSummary.textContent = 'Ei töitä listalla';
  } else {
    els.headerSummary.textContent =
      openTasks.length === 0
        ? `Kaikki ${doneCount} työtä valmiina`
        : `${openTasks.length} avoinna · ${doneCount} valmiina`;
  }

  // Toolbar stats
  els.toolbarStats.innerHTML = '';
  const openPill = document.createElement('span');
  openPill.className = 'stat-pill';
  openPill.textContent = openTasks.length === 1 ? '1 tuleva työ' : `${openTasks.length} tulevaa työtä`;
  els.toolbarStats.appendChild(openPill);

  if (overdueCount > 0) {
    const overPill = document.createElement('span');
    overPill.className = 'stat-pill stat-overdue';
    overPill.textContent = `${overdueCount} myöhässä`;
    els.toolbarStats.appendChild(overPill);
  }

  // Hide done toggle
  const hideDone = Boolean(state.settings.hideDone);
  els.toggleDoneBtn.setAttribute('aria-pressed', String(hideDone));
  els.toggleDoneLabel.textContent = hideDone
    ? `Näytä tehdyt (${doneCount})`
    : 'Piilota tehdyt';

  // Filtered tasks
  const visibleTasks = hideDone ? openTasks : sorted;

  els.taskList.innerHTML = '';

  if (visibleTasks.length === 0) {
    els.emptyState.classList.remove('hidden');
    els.swipeHint.classList.add('hidden');
    if (sorted.length > 0 && hideDone) {
      els.emptyTitle.textContent = 'Kaikki työt on tehty!';
      els.emptyMessage.textContent = `Sinulla on ${doneCount} valmista työtä piilotettuna. Voit näyttää ne yläreunan painikkeesta tai lisätä uuden työn.`;
    } else {
      els.emptyTitle.textContent = 'Ei vielä arvioitavia töitä';
      els.emptyMessage.textContent = 'Lisää ensimmäinen työ alakulman plus-painikkeella. Työt järjestyvät automaattisesti aikajärjestykseen.';
    }
    return;
  }

  els.emptyState.classList.add('hidden');

  const hintSeen = localStorage.getItem(SWIPE_HINT_SEEN_KEY) === '1';
  els.swipeHint.classList.toggle('hidden', hintSeen || state.statuses.length < 2);

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const frag = document.createDocumentFragment();

  for (const task of visibleTasks) {
    frag.appendChild(buildTaskCard(task, isDark));
  }

  els.taskList.appendChild(frag);
  lastChangedTaskId = null;
}

function buildTaskCard(task, isDark) {
  const statusIdx = getStatusIndex(task.statusId);
  const status = state.statuses[statusIdx];
  const nextStatus = statusIdx < state.statuses.length - 1 ? state.statuses[statusIdx + 1] : null;
  const prevStatus = statusIdx > 0 ? state.statuses[statusIdx - 1] : null;
  const priority = PRIORITY_MAP[task.priority] || PRIORITY_MAP.normal;
  const deadlineInfo = formatDeadlineInfo(task.deadline, task.deadlineTime, status.isDone);

  const wrap = document.createElement('div');
  wrap.className = 'task-swipe-wrap';
  wrap.setAttribute('role', 'listitem');
  wrap.dataset.taskId = task.id;

  // Swipe backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'swipe-backdrop';

  let leftAction = null;
  if (nextStatus) {
    leftAction = document.createElement('div');
    leftAction.className = 'swipe-action swipe-action-left';
    leftAction.style.background = nextStatus.color;
    leftAction.innerHTML = `<span class="swipe-action-inner"><span>${nextStatus.isDone ? '✓' : '→'}</span><span>${escapeHtml(nextStatus.name)}</span></span>`;
    backdrop.appendChild(leftAction);
  }

  let rightAction = null;
  if (prevStatus) {
    rightAction = document.createElement('div');
    rightAction.className = 'swipe-action swipe-action-right';
    rightAction.style.background = prevStatus.color;
    rightAction.innerHTML = `<span class="swipe-action-inner"><span>${escapeHtml(prevStatus.name)}</span><span>←</span></span>`;
    backdrop.appendChild(rightAction);
  }

  // Card surface
  const card = document.createElement('article');
  card.className = `task-card${status.isDone ? ' is-done' : ''}`;

  const bar = document.createElement('div');
  bar.className = 'task-priority-bar';
  bar.style.background = priority.color;

  const body = document.createElement('div');
  body.className = 'task-card-body';

  // Top row: title + priority
  const topRow = document.createElement('div');
  topRow.className = 'task-top-row';

  const titleEl = document.createElement('h3');
  titleEl.className = 'task-title';
  titleEl.textContent = task.title;

  const prioBadge = document.createElement('span');
  prioBadge.className = 'priority-badge';
  prioBadge.textContent = priority.label;
  prioBadge.style.color = priority.color;
  prioBadge.style.background = isDark ? priority.bgDark : priority.bgLight;

  topRow.append(titleEl, prioBadge);

  // Meta row: deadline + status chip
  const metaRow = document.createElement('div');
  metaRow.className = 'task-meta-row';

  const deadlineEl = document.createElement('span');
  deadlineEl.className = `deadline-chip${deadlineInfo.urgency === 'overdue' ? ' is-overdue' : deadlineInfo.urgency === 'soon' ? ' is-soon' : ''}`;
  deadlineEl.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
    <span>${escapeHtml(deadlineInfo.text)}</span>
  `;

  const statusChip = document.createElement('span');
  statusChip.className = `status-chip${lastChangedTaskId === task.id ? ' just-changed' : ''}`;
  statusChip.style.setProperty('--status-color', status.color);
  statusChip.innerHTML = `<span class="status-chip-dot" style="background:${status.color}"></span><span>${escapeHtml(status.name)}</span>`;

  metaRow.append(deadlineEl, statusChip);
  body.append(topRow, metaRow);

  // Optional notes preview
  if (task.notes && task.notes.trim()) {
    const notesEl = document.createElement('div');
    notesEl.className = 'task-notes-preview';
    notesEl.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
      </svg>
      <span></span>
    `;
    notesEl.querySelector('span').textContent = task.notes.trim();
    body.appendChild(notesEl);
  }

  card.append(bar, body);
  wrap.append(backdrop, card);

  attachSwipeGesture(wrap, {
    surfaceEl: card,
    leftActionEl: leftAction,
    rightActionEl: rightAction,
    canSwipeRight: Boolean(nextStatus),
    canSwipeLeft: Boolean(prevStatus),
    onSwipeRight: () => {
      localStorage.setItem(SWIPE_HINT_SEEN_KEY, '1');
      changeTaskStatus(task.id, nextStatus.id, wrap);
    },
    onSwipeLeft: () => {
      localStorage.setItem(SWIPE_HINT_SEEN_KEY, '1');
      changeTaskStatus(task.id, prevStatus.id, wrap);
    },
    onTap: () => openTaskSheet(task)
  });

  return wrap;
}

async function changeTaskStatus(taskId, newStatusId, wrapEl = null) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || task.statusId === newStatusId) return;

  const oldStatusId = task.statusId;
  const newStatus = getStatusById(newStatusId);
  const willHide = Boolean(state.settings.hideDone && newStatus.isDone);

  task.statusId = newStatusId;
  task.updatedAt = new Date().toISOString();
  task.completedAt = newStatus.isDone ? task.updatedAt : null;
  lastChangedTaskId = task.id;

  const commit = async () => {
    renderApp();
    await persistAndBackup('status-change');
    showToast(
      `Tila vaihdettu: ${newStatus.name}`,
      'Kumoa',
      async () => {
        const target = state.tasks.find((t) => t.id === taskId);
        if (!target) return;
        target.statusId = oldStatusId;
        target.updatedAt = new Date().toISOString();
        target.completedAt = getStatusById(oldStatusId).isDone ? target.updatedAt : null;
        lastChangedTaskId = target.id;
        renderApp();
        await persistAndBackup('status-undo');
      }
    );
  };

  if (willHide && wrapEl) {
    wrapEl.style.maxHeight = `${wrapEl.offsetHeight}px`;
    requestAnimationFrame(() => {
      wrapEl.classList.add('is-collapsing');
      wrapEl.style.maxHeight = '0px';
      wrapEl.style.marginBottom = '-10px';
    });
    setTimeout(commit, 230);
  } else {
    await commit();
  }
}

/* ---------- Task Add / Edit Sheet ---------- */

let selectedPriority = 'normal';
let selectedStatusId = null;
let isProgrammaticTitleFocus = false;

function recordTitleUsage(rawTitle) {
  const title = String(rawTitle || '').trim().slice(0, 200);
  if (!title) return;
  if (!Array.isArray(state.titleHistory)) state.titleHistory = [];

  const key = title.toLowerCase();
  const now = new Date().toISOString();
  const existing = state.titleHistory.find((entry) => entry.title.toLowerCase() === key);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.title = title;
    existing.lastUsedAt = now;
  } else {
    state.titleHistory.push({ title, count: 1, lastUsedAt: now });
  }
  state.titleHistory = sortTitleHistory(state.titleHistory);
}

async function removeTitleSuggestion(titleToRemove) {
  const key = String(titleToRemove || '').trim().toLowerCase();
  if (!key || !Array.isArray(state.titleHistory)) return;
  state.titleHistory = state.titleHistory.filter((entry) => entry.title.toLowerCase() !== key);
  renderTitleSuggestions(els.taskTitleInput.value);
  await persistAndBackup('title-suggestion-remove');
}

function hideTitleSuggestions() {
  els.titleSuggestions.classList.add('hidden');
  els.taskTitleInput.setAttribute('aria-expanded', 'false');
}

function renderTitleSuggestions(query = '') {
  const history = sortTitleHistory(Array.isArray(state.titleHistory) ? state.titleHistory : []);
  const q = String(query || '').trim().toLowerCase();

  let matches = history;
  if (q) {
    const startsWith = history.filter((item) => item.title.toLowerCase().startsWith(q));
    const contains = history.filter(
      (item) => !item.title.toLowerCase().startsWith(q) && item.title.toLowerCase().includes(q)
    );
    matches = [...startsWith, ...contains];
  }

  if (matches.length === 0) {
    hideTitleSuggestions();
    return;
  }

  els.titleSuggestions.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const item of matches) {
    const row = document.createElement('div');
    row.className = 'title-suggestion-row';
    row.setAttribute('role', 'option');

    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'title-suggestion-pick';

    const textSpan = document.createElement('span');
    textSpan.className = 'title-suggestion-text';
    textSpan.textContent = item.title;
    pickBtn.appendChild(textSpan);

    if (item.count > 1) {
      const countSpan = document.createElement('span');
      countSpan.className = 'title-suggestion-count';
      countSpan.textContent = `${item.count}×`;
      countSpan.title = `Käytetty ${item.count} kertaa`;
      pickBtn.appendChild(countSpan);
    }

    pickBtn.addEventListener('mousedown', (e) => e.preventDefault());
    pickBtn.addEventListener('click', () => {
      els.taskTitleInput.value = item.title;
      hideTitleSuggestions();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'title-suggestion-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = `Poista "${item.title}" ehdotuksista`;
    removeBtn.setAttribute('aria-label', `Poista ${item.title} ehdotuksista`);
    removeBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    removeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeTitleSuggestion(item.title);
    });

    row.append(pickBtn, removeBtn);
    frag.appendChild(row);
  }

  els.titleSuggestions.appendChild(frag);
  els.titleSuggestions.classList.remove('hidden');
  els.taskTitleInput.setAttribute('aria-expanded', 'true');
}

els.taskTitleInput.addEventListener('click', () => {
  renderTitleSuggestions(els.taskTitleInput.value);
});

els.taskTitleInput.addEventListener('focus', () => {
  if (isProgrammaticTitleFocus) return;
  renderTitleSuggestions(els.taskTitleInput.value);
});

els.taskTitleInput.addEventListener('input', () => {
  renderTitleSuggestions(els.taskTitleInput.value);
});

document.addEventListener('pointerdown', (e) => {
  if (!els.titleSuggestions.classList.contains('hidden') && !els.titleAutocomplete.contains(e.target)) {
    hideTitleSuggestions();
  }
});

function renderPriorityPicker() {
  els.priorityPicker.innerHTML = '';
  for (const p of PRIORITIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `choice-btn${selectedPriority === p.id ? ' selected' : ''}`;
    btn.style.setProperty('--choice-color', p.color);
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(selectedPriority === p.id));
    btn.innerHTML = `<span class="status-chip-dot" style="background:${p.color}"></span><span>${p.label}</span>`;
    btn.addEventListener('click', () => {
      selectedPriority = p.id;
      renderPriorityPicker();
    });
    els.priorityPicker.appendChild(btn);
  }
}

function renderStatusPicker() {
  els.statusPicker.innerHTML = '';
  for (const s of state.statuses) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `status-choice${selectedStatusId === s.id ? ' selected' : ''}`;
    btn.style.setProperty('--choice-color', s.color);
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(selectedStatusId === s.id));
    btn.innerHTML = `<span class="status-chip-dot" style="background:${s.color}"></span><span>${escapeHtml(s.name)}</span>`;
    btn.addEventListener('click', () => {
      selectedStatusId = s.id;
      renderStatusPicker();
    });
    els.statusPicker.appendChild(btn);
  }
}

function openTaskSheet(task = null) {
  if (task) {
    els.taskSheetTitle.textContent = 'Muokkaa työtä';
    els.taskIdInput.value = task.id;
    els.taskTitleInput.value = task.title;
    els.taskDeadlineInput.value = task.deadline || toDateInputString(getTodayDate());
    els.taskTimeInput.value = task.deadlineTime || '';
    els.taskNotesInput.value = task.notes || '';
    selectedPriority = task.priority || 'normal';
    selectedStatusId = task.statusId || state.statuses[0].id;
    els.deleteTaskBtn.classList.remove('hidden');
  } else {
    els.taskSheetTitle.textContent = 'Uusi työ';
    els.taskIdInput.value = '';
    els.taskTitleInput.value = '';
    const tomorrow = getTodayDate();
    tomorrow.setDate(tomorrow.getDate() + 1);
    els.taskDeadlineInput.value = toDateInputString(tomorrow);
    els.taskTimeInput.value = '';
    els.taskNotesInput.value = '';
    selectedPriority = 'normal';
    selectedStatusId = state.statuses[0].id;
    els.deleteTaskBtn.classList.add('hidden');
  }

  renderPriorityPicker();
  renderStatusPicker();
  hideTitleSuggestions();

  els.taskSheetBackdrop.classList.remove('hidden');
  els.taskSheetBackdrop.setAttribute('aria-hidden', 'false');
  setTimeout(() => {
    isProgrammaticTitleFocus = true;
    els.taskTitleInput.focus();
    isProgrammaticTitleFocus = false;
  }, 60);
}

function closeTaskSheet() {
  hideTitleSuggestions();
  els.taskSheetBackdrop.classList.add('hidden');
  els.taskSheetBackdrop.setAttribute('aria-hidden', 'true');
}

els.taskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = els.taskTitleInput.value.trim();
  const deadline = els.taskDeadlineInput.value;
  if (!title || !deadline) return;

  const now = new Date().toISOString();
  const existingId = els.taskIdInput.value;
  const st = getStatusById(selectedStatusId);

  if (existingId) {
    const task = state.tasks.find((t) => t.id === existingId);
    if (task) {
      const titleChanged = task.title.trim().toLowerCase() !== title.toLowerCase();
      task.title = title;
      task.deadline = deadline;
      task.deadlineTime = els.taskTimeInput.value || '';
      task.priority = selectedPriority;
      task.statusId = st.id;
      task.notes = els.taskNotesInput.value.trim();
      task.updatedAt = now;
      task.completedAt = st.isDone ? (task.completedAt || now) : null;
      if (titleChanged) {
        recordTitleUsage(title);
      }
    }
    closeTaskSheet();
    renderApp();
    await persistAndBackup('task-edit');
    showToast('Työ päivitetty');
  } else {
    state.tasks.push({
      id: generateId('task'),
      title,
      deadline,
      deadlineTime: els.taskTimeInput.value || '',
      priority: selectedPriority,
      statusId: st.id,
      notes: els.taskNotesInput.value.trim(),
      createdAt: now,
      updatedAt: now,
      completedAt: st.isDone ? now : null
    });
    recordTitleUsage(title);
    closeTaskSheet();
    renderApp();
    await persistAndBackup('task-add');
    showToast('Työ lisätty');
  }
});

els.deleteTaskBtn.addEventListener('click', async () => {
  const id = els.taskIdInput.value;
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return;

  const [removed] = state.tasks.splice(idx, 1);
  closeTaskSheet();
  renderApp();
  await persistAndBackup('task-delete');

  showToast(`Poistettu: ${removed.title}`, 'Kumoa', async () => {
    state.tasks.push(removed);
    renderApp();
    await persistAndBackup('task-delete-undo');
  });
});

els.quickDateChips.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-days]');
  if (!btn) return;
  const days = parseInt(btn.dataset.days, 10);
  const d = getTodayDate();
  d.setDate(d.getDate() + days);
  els.taskDeadlineInput.value = toDateInputString(d);
});

/* ---------- Settings Sheet ---------- */

function openSettingsSheet(tabName = 'statuses') {
  switchSettingsTab(tabName);
  renderStatusEditor();
  renderBackupPanel();
  els.appVersionDisplay.textContent = `v${APP_VERSION}`;
  els.settingsSheetBackdrop.classList.remove('hidden');
  els.settingsSheetBackdrop.setAttribute('aria-hidden', 'false');
}

function closeSettingsSheet() {
  els.settingsSheetBackdrop.classList.add('hidden');
  els.settingsSheetBackdrop.setAttribute('aria-hidden', 'true');
}

function switchSettingsTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
  const settingsBody = document.querySelector('.settings-body');
  if (settingsBody) settingsBody.scrollTop = 0;
  if (tabName === 'backups') {
    renderBackupPanel();
  }
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchSettingsTab(btn.dataset.tab));
});

/* ---------- Custom Statuses Editor ---------- */

function renderStatusEditor() {
  els.statusEditorList.innerHTML = '';

  state.statuses.forEach((status, idx) => {
    const item = document.createElement('div');
    item.className = 'status-editor-item';

    const top = document.createElement('div');
    top.className = 'status-editor-top';

    const orderBadge = document.createElement('span');
    orderBadge.className = 'status-order-badge';
    orderBadge.textContent = String(idx + 1);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'status-name-input';
    nameInput.maxLength = 40;
    nameInput.value = status.name;
    nameInput.setAttribute('aria-label', 'Tilan nimi');
    nameInput.addEventListener('change', async () => {
      const cleaned = nameInput.value.trim();
      if (!cleaned) {
        nameInput.value = status.name;
        return;
      }
      status.name = cleaned;
      renderApp();
      await persistAndBackup('status-rename');
      showToast('Tilan nimi päivitetty');
    });

    const controls = document.createElement('div');
    controls.className = 'status-controls';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'mini-icon-btn';
    upBtn.textContent = '↑';
    upBtn.title = 'Siirrä ylös';
    upBtn.disabled = idx === 0;
    upBtn.addEventListener('click', () => moveStatus(idx, -1));

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'mini-icon-btn';
    downBtn.textContent = '↓';
    downBtn.title = 'Siirrä alas';
    downBtn.disabled = idx === state.statuses.length - 1;
    downBtn.addEventListener('click', () => moveStatus(idx, 1));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'mini-icon-btn danger';
    delBtn.textContent = '✕';
    delBtn.title = 'Poista tila';
    delBtn.disabled = state.statuses.length <= 1;
    delBtn.addEventListener('click', () => deleteStatus(status.id));

    controls.append(upBtn, downBtn, delBtn);
    top.append(orderBadge, nameInput, controls);

    // Color swatches
    const palette = document.createElement('div');
    palette.className = 'color-palette';
    for (const color of STATUS_COLORS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = `color-swatch${status.color.toLowerCase() === color.toLowerCase() ? ' selected' : ''}`;
      sw.style.background = color;
      sw.setAttribute('aria-label', `Väri ${color}`);
      sw.addEventListener('click', async () => {
        status.color = color;
        renderStatusEditor();
        renderApp();
        await persistAndBackup('status-color');
      });
      palette.appendChild(sw);
    }

    // isDone toggle
    const doneLabel = document.createElement('label');
    doneLabel.className = 'checkbox-row';
    const doneCb = document.createElement('input');
    doneCb.type = 'checkbox';
    doneCb.checked = Boolean(status.isDone);
    doneCb.addEventListener('change', async () => {
      status.isDone = doneCb.checked;
      renderApp();
      await persistAndBackup('status-done-flag');
    });
    const doneTxt = document.createElement('span');
    doneTxt.textContent = 'Lasketaan tehdyksi (piilotettava)';
    doneLabel.append(doneCb, doneTxt);

    item.append(top, palette, doneLabel);
    els.statusEditorList.appendChild(item);
  });

  renderNewStatusColorPalette();
}

function renderNewStatusColorPalette() {
  els.newStatusColorPalette.innerHTML = '';
  for (const color of STATUS_COLORS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = `color-swatch${newStatusColor === color ? ' selected' : ''}`;
    sw.style.background = color;
    sw.setAttribute('aria-label', `Valitse väri ${color}`);
    sw.addEventListener('click', () => {
      newStatusColor = color;
      renderNewStatusColorPalette();
    });
    els.newStatusColorPalette.appendChild(sw);
  }
}

async function moveStatus(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.statuses.length) return;
  const [moved] = state.statuses.splice(index, 1);
  state.statuses.splice(target, 0, moved);
  renderStatusEditor();
  renderApp();
  await persistAndBackup('status-reorder');
}

async function deleteStatus(statusId) {
  if (state.statuses.length <= 1) return;
  const idx = state.statuses.findIndex((s) => s.id === statusId);
  if (idx === -1) return;

  const fallback = state.statuses[idx === 0 ? 1 : idx - 1];
  const affectedCount = state.tasks.filter((t) => t.statusId === statusId).length;

  if (affectedCount > 0) {
    const ok = confirm(
      `${affectedCount} työtä on tässä tilassa. Ne siirretään tilaan "${fallback.name}". Poistetaanko tila?`
    );
    if (!ok) return;
    for (const t of state.tasks) {
      if (t.statusId === statusId) {
        t.statusId = fallback.id;
      }
    }
  }

  state.statuses.splice(idx, 1);
  renderStatusEditor();
  renderApp();
  await persistAndBackup('status-delete');
  showToast('Tila poistettu');
}

els.addStatusForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = els.newStatusNameInput.value.trim();
  if (!name) return;

  const newStatus = {
    id: generateId('st'),
    name,
    color: newStatusColor,
    isDone: els.newStatusDoneInput.checked
  };

  // Insert before the first "done" status unless the new status itself is a "done" status
  if (!newStatus.isDone) {
    const firstDoneIdx = state.statuses.findIndex((s) => s.isDone);
    if (firstDoneIdx > -1) {
      state.statuses.splice(firstDoneIdx, 0, newStatus);
    } else {
      state.statuses.push(newStatus);
    }
  } else {
    state.statuses.push(newStatus);
  }

  els.newStatusNameInput.value = '';
  els.newStatusDoneInput.checked = false;
  renderStatusEditor();
  renderApp();
  await persistAndBackup('status-add');
  showToast(`Tila "${name}" lisätty`);
});

/* ---------- Backups Panel & Indicators ---------- */

function renderBackupIndicators() {
  if (!backupStatus) return;

  els.backupDot.className = 'status-dot';
  if (backupStatus.lastBackupStatus === 'ok') {
    els.backupDot.classList.add('dot-ok');
  } else if (backupStatus.lastBackupStatus === 'needs_permission') {
    els.backupDot.classList.add('dot-warn');
  } else if (backupStatus.lastBackupStatus === 'error') {
    els.backupDot.classList.add('dot-err');
  } else {
    els.backupDot.classList.add('dot-idle');
  }

  const showPermBanner = backupStatus.hasFolder && backupStatus.lastBackupStatus === 'needs_permission';
  els.backupPermissionBanner.classList.toggle('hidden', !showPermBanner);
  if (showPermBanner) {
    els.backupBannerDetail.textContent = backupStatus.pendingSync
      ? `Kansio "${backupStatus.folderName}" vaatii vahvistuksen uusien muutosten tallentamiseen.`
      : `Vahvista oikeus kansioon "${backupStatus.folderName}" jatkaaksesi automaattista tallennusta.`;
  }

  if (!els.settingsSheetBackdrop.classList.contains('hidden')) {
    renderBackupPanel();
  }
}

async function renderBackupPanel() {
  if (!backupStatus) return;

  els.backupFolderDisplay.textContent = backupStatus.folderName || 'Ei valittu';
  els.backupTimeDisplay.textContent = formatDateTimeFi(backupStatus.lastBackupAt);

  const stateLabels = {
    ok: 'Aktiivinen (automaattinen tallennus päällä)',
    needs_permission: 'Odottaa kansion kirjoitusoikeuden vahvistusta',
    error: `Virhe: ${backupStatus.lastError || 'tallennus epäonnistui'}`,
    unsupported: 'Selain ei tue kansiovalintaa (käytä manuaalista .json-vientiä)',
    idle: 'Valitse kansio ottaaksesi automaattisen kopioinnin käyttöön'
  };
  els.backupStateDisplay.textContent = stateLabels[backupStatus.lastBackupStatus] || 'Valmis';

  const persisted = await isStoragePersisted();
  els.storagePersistDisplay.textContent = persisted ? 'Suojattu (pysyvä)' : 'Normaali selaintallennus';

  els.chooseFolderBtn.textContent = backupStatus.hasFolder
    ? 'Vaihda varmuuskopiokansio'
    : 'Valitse varmuuskopiokansio';
  els.chooseFolderBtn.disabled = !backupStatus.supportsFolderPicker;

  els.reauthorizeFolderBtn.classList.toggle(
    'hidden',
    !(backupStatus.hasFolder && backupStatus.lastBackupStatus === 'needs_permission')
  );
  els.disconnectFolderBtn.classList.toggle('hidden', !backupStatus.hasFolder);
  els.backupNowBtn.disabled = !backupStatus.hasFolder;

  // Render folder backup files if authorized
  const folderFiles = await backupManager.listFolderBackups();
  if (folderFiles.length > 0) {
    els.folderBackupsSection.classList.remove('hidden');
    els.folderBackupsList.innerHTML = '';
    for (const file of folderFiles.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'backup-item';
      row.innerHTML = `
        <div class="backup-item-meta">
          <strong>${escapeHtml(file.name)}</strong>
          <span>${formatDateTimeFi(file.lastModified)} · ${Math.max(1, Math.round(file.size / 1024))} kt</span>
        </div>
      `;
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn btn-sm btn-secondary';
      restoreBtn.textContent = 'Palauta';
      restoreBtn.addEventListener('click', async () => {
        if (!confirm(`Palautetaanko varmuuskopio "${file.name}"? Nykyiset tiedot korvataan.`)) return;
        const result = await backupManager.readFolderBackupFile(file.handle);
        await applyRestoreResult(result);
      });
      row.appendChild(restoreBtn);
      els.folderBackupsList.appendChild(row);
    }
  } else {
    els.folderBackupsSection.classList.add('hidden');
  }

  // Render internal recovery snapshots
  const snapshots = await backupManager.getInternalSnapshots();
  els.internalSnapshotsList.innerHTML = '';
  if (snapshots.length === 0) {
    els.internalSnapshotsList.innerHTML = '<div class="backup-item"><span class="info-label">Ei vielä palautuspisteitä.</span></div>';
  } else {
    for (const snap of snapshots.slice(0, 6)) {
      const row = document.createElement('div');
      row.className = 'backup-item';
      row.innerHTML = `
        <div class="backup-item-meta">
          <strong>${formatDateTimeFi(snap.createdAt)}</strong>
          <span>${snap.taskCount} työtä · ${snap.reason === 'pre-update' ? 'Ennen päivitystä' : 'Automaattinen'}</span>
        </div>
      `;
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn btn-sm btn-secondary';
      restoreBtn.textContent = 'Palauta';
      restoreBtn.addEventListener('click', async () => {
        if (!confirm('Palautetaanko tämä palautuspiste?')) return;
        const { parseAndMigrateBackup } = await import('./migrations.js');
        const result = await parseAndMigrateBackup(snap.envelope);
        await applyRestoreResult(result);
      });
      row.appendChild(restoreBtn);
      els.internalSnapshotsList.appendChild(row);
    }
  }
}

async function applyRestoreResult(result) {
  if (!result.ok) {
    showToast(result.error || 'Palautus epäonnistui.');
    return;
  }

  state.tasks = result.state.tasks;
  state.statuses = result.state.statuses;
  state.settings = result.state.settings;
  state.titleHistory = result.state.titleHistory || [];

  applyTheme(state.settings.theme);
  renderApp();
  renderStatusEditor();
  await persistAndBackup('restore');
  renderBackupPanel();

  const warnText = result.warnings.length > 0 ? ` (${result.warnings[0]})` : '';
  showToast(`Palautettu ${state.tasks.length} työtä.${warnText}`, null, null, 5200);
}

els.chooseFolderBtn.addEventListener('click', async () => {
  const res = await backupManager.chooseBackupFolder(state);
  if (res.cancelled) return;
  if (res.ok) {
    showToast('Varmuuskopiokansio asetettu ja ensimmäinen kopio tallennettu');
    renderBackupPanel();
  } else {
    showToast(res.error || 'Kansion valinta epäonnistui');
  }
});

const handleReauthorize = async () => {
  const res = await backupManager.reauthorizeFolder(state);
  if (res.ok) {
    showToast('Kansion oikeus vahvistettu ja varmuuskopio päivitetty');
    renderBackupPanel();
  } else if (!res.cancelled) {
    showToast(res.error || 'Vahvistus epäonnistui');
  }
};

els.reauthorizeFolderBtn.addEventListener('click', handleReauthorize);
els.reauthorizeBannerBtn.addEventListener('click', handleReauthorize);

els.backupNowBtn.addEventListener('click', async () => {
  const res = await backupManager.writeFolderBackupNow(state, 'manual');
  if (res.ok) {
    showToast('Varmuuskopio tallennettu kansioon');
    renderBackupPanel();
  } else {
    showToast(res.error || 'Varmuuskopiointi epäonnistui');
  }
});

els.disconnectFolderBtn.addEventListener('click', async () => {
  if (!confirm('Irrotetaanko varmuuskopiokansio? Aiemmat tiedostot säilyvät kansiossa.')) return;
  await backupManager.disconnectFolder();
  showToast('Kansio irrotettu');
  renderBackupPanel();
});

els.downloadBackupBtn.addEventListener('click', async () => {
  const res = await backupManager.downloadManualBackup(state);
  if (res.ok) {
    showToast(`Ladattu: ${res.filename}`);
  }
});

els.restoreFileBtn.addEventListener('click', () => {
  els.restoreFileInput.value = '';
  els.restoreFileInput.click();
});

els.restoreFileInput.addEventListener('change', async () => {
  const file = els.restoreFileInput.files?.[0];
  if (!file) return;
  if (!confirm(`Palautetaanko varmuuskopio tiedostosta "${file.name}"? Nykyiset tiedot korvataan.`)) return;
  const result = await backupManager.importFromFile(file);
  await applyRestoreResult(result);
});

/* ---------- Manual Update Checker ---------- */

els.checkUpdatesBtn.addEventListener('click', async () => {
  els.checkUpdatesBtn.disabled = true;
  els.checkUpdatesBtn.textContent = 'Tarkistetaan…';
  els.updateResultBox.classList.add('hidden');

  const res = await updater.checkForUpdates();

  els.checkUpdatesBtn.disabled = false;
  els.checkUpdatesBtn.textContent = 'Tarkista päivitykset';
  els.updateResultBox.classList.remove('hidden');
  els.updateResultBox.classList.toggle('is-available', Boolean(res.ok && res.updateAvailable));

  if (!res.ok) {
    els.updateResultBox.innerHTML = `<p style="margin:0;">${escapeHtml(res.message)}</p>`;
    return;
  }

  if (!res.updateAvailable) {
    els.updateResultBox.innerHTML = `<p style="margin:0;"><strong>✓ ${escapeHtml(res.message)}</strong></p>`;
    return;
  }

  const notesHtml =
    res.changelog.length > 0
      ? `<ul>${res.changelog.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '';

  els.updateResultBox.innerHTML = `
    <p style="margin:0 0 6px;"><strong>Uusi versio saatavilla: v${escapeHtml(res.latestVersion)}</strong> (nykyinen v${escapeHtml(res.currentVersion)})</p>
    ${notesHtml}
    <button type="button" class="btn btn-primary btn-full" id="installUpdateNowBtn">Lataa ja asenna päivitys</button>
  `;

  document.getElementById('installUpdateNowBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Varmuuskopioidaan ja päivitetään…';
    await updater.installUpdate(state, backupManager);
  });
});

/* ---------- Global Event Listeners ---------- */

els.toggleDoneBtn.addEventListener('click', async () => {
  state.settings.hideDone = !state.settings.hideDone;
  renderApp();
  await persistAndBackup('toggle-hide-done');
});

els.addTaskFab.addEventListener('click', () => openTaskSheet(null));
els.emptyAddBtn.addEventListener('click', () => openTaskSheet(null));
els.closeTaskSheetBtn.addEventListener('click', closeTaskSheet);
els.cancelTaskBtn.addEventListener('click', closeTaskSheet);
els.taskSheetBackdrop.addEventListener('click', (e) => {
  if (e.target === els.taskSheetBackdrop) closeTaskSheet();
});

els.openSettingsBtn.addEventListener('click', () => openSettingsSheet('statuses'));
els.backupIndicatorBtn.addEventListener('click', () => openSettingsSheet('backups'));
els.closeSettingsBtn.addEventListener('click', closeSettingsSheet);
els.settingsSheetBackdrop.addEventListener('click', (e) => {
  if (e.target === els.settingsSheetBackdrop) closeSettingsSheet();
});

els.themePicker.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-theme]');
  if (!btn) return;
  state.settings.theme = btn.dataset.theme;
  applyTheme(state.settings.theme);
  renderApp();
  await persistAndBackup('theme-change');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!els.titleSuggestions.classList.contains('hidden')) {
      hideTitleSuggestions();
      return;
    }
    closeTaskSheet();
    closeSettingsSheet();
  }
});

// PWA install prompt handling
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (localStorage.getItem('arvi_install_dismissed') !== '1') {
    els.installBanner.classList.remove('hidden');
  }
});

els.installPwaBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  els.installBanner.classList.add('hidden');
});

els.dismissInstallBtn.addEventListener('click', () => {
  localStorage.setItem('arvi_install_dismissed', '1');
  els.installBanner.classList.add('hidden');
});

window.addEventListener('appinstalled', () => {
  els.installBanner.classList.add('hidden');
  showToast('Arvi asennettu kotinäytölle');
});

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* ---------- Boot ---------- */

async function init() {
  try {
    state = await loadAppState();
  } catch (err) {
    console.warn('Tilan lataus epäonnistui, käytetään oletustilaa:', err);
    state = {
      tasks: [],
      statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
      settings: { ...DEFAULT_SETTINGS },
      titleHistory: []
    };
  }
  applyTheme(state.settings.theme);
  renderApp();

  // Request durable browser storage & initialize backup subsystem
  requestPersistentStorage();
  try {
    await backupManager.init();
  } catch (err) {
    console.warn('Varmuuskopioinnin alustus epäonnistui:', err);
  }
  renderBackupIndicators();

  // Register offline-first Service Worker (never auto-updates active version)
  await updater.registerServiceWorker();
}

init();
