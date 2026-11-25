import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareTasksChronologically,
  computeChecksum,
  createBackupEnvelope,
  normalizeTitleHistory,
  parseAndMigrateBackup
} from '../js/migrations.js';
import { getIsoWeekKey, LATEST_FILENAME, planBackupRetention } from '../js/retention.js';
import { compareVersions } from '../js/updater.js';
import { APP_VERSION, DEFAULT_STATUSES, SCHEMA_VERSION } from '../js/constants.js';

test('createBackupEnvelope & parseAndMigrateBackup round-trip with valid checksum', async () => {
  const sampleState = {
    tasks: [
      {
        id: 'task_1',
        title: '9A fysiikan koe',
        statusId: 'todo',
        deadline: '2026-12-01',
        deadlineTime: '14:00',
        notes: 'Muista laskukaavat',
        priority: 'high',
        createdAt: '2026-11-24T10:00:00.000Z',
        updatedAt: '2026-11-24T10:00:00.000Z',
        completedAt: null
      }
    ],
    statuses: [
      ...DEFAULT_STATUSES,
      { id: 'st_review', name: 'Tarkistettavana', color: '#7c3aed', isDone: false }
    ],
    settings: { hideDone: true, theme: 'dark', keepDailyBackups: 21, autoBackupEnabled: true }
  };

  const env = await createBackupEnvelope(sampleState);
  assert.equal(env.app, 'arvi');
  assert.equal(env.schemaVersion, SCHEMA_VERSION);
  assert.equal(env.appVersion, APP_VERSION);
  assert.ok(env.checksum.startsWith('sha256:'));

  const restored = await parseAndMigrateBackup(JSON.stringify(env));
  assert.equal(restored.ok, true);
  assert.equal(restored.warnings.length, 0);
  assert.equal(restored.state.tasks.length, 1);
  assert.equal(restored.state.tasks[0].title, '9A fysiikan koe');
  assert.equal(restored.state.statuses.length, 4);
  assert.equal(restored.state.settings.hideDone, true);
  assert.equal(restored.state.settings.theme, 'dark');
});

test('backward compatibility: restores minimal/old payload missing optional fields', async () => {
  const legacyJson = JSON.stringify({
    tasks: [
      { title: 'Vanha työ ilman ID:tä', dueDate: '2026-12-10' }
    ]
  });

  const restored = await parseAndMigrateBackup(legacyJson);
  assert.equal(restored.ok, true);
  assert.equal(restored.state.tasks.length, 1);
  assert.equal(restored.state.tasks[0].title, 'Vanha työ ilman ID:tä');
  assert.equal(restored.state.tasks[0].deadline, '2026-12-10');
  assert.equal(restored.state.tasks[0].priority, 'normal');
  assert.equal(restored.state.statuses.length, DEFAULT_STATUSES.length);
  assert.equal(restored.state.tasks[0].statusId, DEFAULT_STATUSES[0].id);
});

test('forward compatibility: preserves unknown future fields on tasks, statuses, and settings', async () => {
  const futureData = {
    tasks: [
      {
        id: 't_future',
        title: 'Tulevaisuuden työ',
        statusId: 'todo',
        deadline: '2027-01-15',
        priority: 'critical',
        notes: '',
        futureTag: 'matikka',
        futurePoints: 42
      }
    ],
    statuses: [
      { id: 'todo', name: 'Aloittamatta', color: '#64748b', isDone: false, futureIcon: 'star' }
    ],
    settings: {
      hideDone: false,
      theme: 'light',
      futureExperimentalFlag: true
    }
  };

  const envelope = {
    app: 'arvi',
    schemaVersion: SCHEMA_VERSION + 2,
    appVersion: '3.0.0',
    exportedAt: '2028-05-01T12:00:00.000Z',
    checksum: await computeChecksum(futureData),
    data: futureData
  };

  const restored = await parseAndMigrateBackup(envelope);
  assert.equal(restored.ok, true);
  assert.ok(restored.warnings.length >= 1);
  assert.equal(restored.state.tasks[0].futureTag, 'matikka');
  assert.equal(restored.state.tasks[0].futurePoints, 42);
  assert.equal(restored.state.statuses[0].futureIcon, 'star');
  assert.equal(restored.state.settings.futureExperimentalFlag, true);
});

test('repairs dangling statusId references safely and warns user', async () => {
  const data = {
    tasks: [
      { id: 't1', title: 'Orpo tila', statusId: 'deleted_status', deadline: '2026-12-05', priority: 'low' }
    ],
    statuses: DEFAULT_STATUSES,
    settings: {}
  };
  const env = { app: 'arvi', schemaVersion: 1, data };

  const restored = await parseAndMigrateBackup(env);
  assert.equal(restored.ok, true);
  assert.equal(restored.state.tasks[0].statusId, DEFAULT_STATUSES[0].id);
  assert.ok(restored.warnings.some((w) => w.includes('korjattiin')));
});

test('rejects invalid JSON or unrelated app files cleanly', async () => {
  const badJson = await parseAndMigrateBackup('{not valid json');
  assert.equal(badJson.ok, false);

  const wrongApp = await parseAndMigrateBackup({ app: 'other-app', data: { tasks: [] } });
  assert.equal(wrongApp.ok, false);
});

test('compareTasksChronologically orders by deadline date, time, then priority descending', () => {
  const tasks = [
    { id: 'c', deadline: '2026-12-02', deadlineTime: '', priority: 'critical', createdAt: '2026-11-24T01:00:00Z' },
    { id: 'a', deadline: '2026-12-01', deadlineTime: '15:00', priority: 'low', createdAt: '2026-11-24T01:00:00Z' },
    { id: 'b', deadline: '2026-12-01', deadlineTime: '09:00', priority: 'normal', createdAt: '2026-11-24T01:00:00Z' },
    { id: 'd', deadline: '2026-12-01', deadlineTime: '', priority: 'critical', createdAt: '2026-11-24T02:00:00Z' },
    { id: 'e', deadline: '2026-12-01', deadlineTime: '', priority: 'low', createdAt: '2026-11-24T01:00:00Z' }
  ];

  const sorted = [...tasks].sort(compareTasksChronologically).map((t) => t.id);
  assert.deepEqual(sorted, ['b', 'a', 'd', 'e', 'c']);
});

test('compareVersions handles semantic version comparisons accurately', () => {
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.0.2', '1.0.1'), 1);
});

test('normalizeTitleHistory seeds from legacy tasks sorted by frequency and respects empty array', async () => {
  const legacyTasks = [
    { title: 'Essee', createdAt: '2026-11-01T10:00:00Z' },
    { title: 'Koe', createdAt: '2026-11-02T10:00:00Z' },
    { title: 'Koe', createdAt: '2026-11-03T10:00:00Z' },
    { title: 'koe', createdAt: '2026-11-04T10:00:00Z' },
    { title: 'Essee', createdAt: '2026-11-05T10:00:00Z' },
    { title: 'Labra', createdAt: '2026-11-06T10:00:00Z' }
  ];

  // Legacy backup with no titleHistory field seeds from tasks sorted by frequency
  const seeded = normalizeTitleHistory(undefined, legacyTasks);
  assert.deepEqual(
    seeded.map((x) => [x.title.toLowerCase(), x.count]),
    [['koe', 3], ['essee', 2], ['labra', 1]]
  );

  // Explicit empty array (user deleted all suggestions) stays empty
  const cleared = normalizeTitleHistory([], legacyTasks);
  assert.deepEqual(cleared, []);

  // Round-trip through backup envelope preserves titleHistory accurately
  const env = await createBackupEnvelope({
    tasks: [],
    statuses: DEFAULT_STATUSES,
    settings: {},
    titleHistory: [
      { title: 'Harjoitustyö', count: 5, lastUsedAt: '2026-11-20T10:00:00Z' },
      { title: 'Välikoe', count: 2, lastUsedAt: '2026-11-22T10:00:00Z' }
    ]
  });
  const restored = await parseAndMigrateBackup(JSON.stringify(env));
  assert.equal(restored.ok, true);
  assert.deepEqual(
    restored.state.titleHistory.map((x) => [x.title, x.count]),
    [['Harjoitustyö', 5], ['Välikoe', 2]]
  );
});

test('planBackupRetention enforces 7 daily + 4 weekly + 6 monthly cap without touching non-dated files', () => {
  assert.equal(getIsoWeekKey('2026-11-25'), '2026-W48');

  // Generate 400 consecutive days ending 2026-11-25
  const base = Date.UTC(2026, 10, 25);
  const dailyNames = [];
  for (let i = 0; i < 400; i++) {
    const d = new Date(base - i * 86400000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    dailyNames.push(`arvi-varmuuskopio-${y}-${m}-${day}.json`);
  }

  const allFiles = [LATEST_FILENAME, 'notes.txt', 'other.json', 'photo.jpg', ...dailyNames];
  const plan = planBackupRetention(allFiles);

  assert.equal(plan.tiers.daily.length, 7);
  assert.equal(plan.tiers.weekly.length, 4);
  assert.equal(plan.tiers.monthly.length, 6);
  assert.equal(plan.keep.length, 17);
  assert.equal(plan.delete.length, 400 - 17);

  // Never deletes latest backup or unrelated user files
  assert.ok(!plan.delete.includes(LATEST_FILENAME));
  assert.ok(!plan.delete.includes('notes.txt'));
  assert.ok(!plan.delete.includes('other.json'));
  assert.ok(!plan.delete.includes('photo.jpg'));

  // Small backup sets keep everything
  const smallPlan = planBackupRetention([
    LATEST_FILENAME,
    'arvi-varmuuskopio-2026-11-25.json',
    'arvi-varmuuskopio-2026-11-24.json',
    'arvi-varmuuskopio-2026-11-23.json'
  ]);
  assert.equal(smallPlan.keep.length, 3);
  assert.equal(smallPlan.delete.length, 0);
});
