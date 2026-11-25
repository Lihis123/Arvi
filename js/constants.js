export const APP_NAME = 'Arvi';
export const APP_VERSION = '1.0.5';
export const SCHEMA_VERSION = 1;

export const PRIORITIES = [
  { id: 'low', label: 'Matala', rank: 1, color: '#64748b', bgLight: '#f1f5f9', bgDark: '#1e293b' },
  { id: 'normal', label: 'Normaali', rank: 2, color: '#2563eb', bgLight: '#eff6ff', bgDark: '#172554' },
  { id: 'high', label: 'Tärkeä', rank: 3, color: '#d97706', bgLight: '#fffbeb', bgDark: '#451a03' },
  { id: 'critical', label: 'Kriittinen', rank: 4, color: '#dc2626', bgLight: '#fef2f2', bgDark: '#450a0a' }
];

export const PRIORITY_MAP = Object.fromEntries(PRIORITIES.map((p) => [p.id, p]));

export const STATUS_COLORS = [
  '#64748b', // Siniharmaa
  '#2563eb', // Sininen
  '#0891b2', // Petrooli
  '#059669', // Smaragdi
  '#65a30d', // Oliivi
  '#d97706', // Meripihka
  '#ea580c', // Oranssi
  '#dc2626', // Punainen
  '#db2777', // Magenta
  '#7c3aed'  // Violetti
];

export const DEFAULT_STATUSES = [
  { id: 'todo', name: 'Aloittamatta', color: '#64748b', isDone: false },
  { id: 'in_progress', name: 'Työn alla', color: '#d97706', isDone: false },
  { id: 'done', name: 'Valmis', color: '#059669', isDone: true }
];

export const DEFAULT_SETTINGS = {
  hideDone: false,
  theme: 'system', // 'system' | 'light' | 'dark'
  keepDailyBackups: 14,
  autoBackupEnabled: true,
  showQuickDoneButton: true
};
