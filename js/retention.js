export const BACKUP_SUBFOLDER_NAME = 'Arvi-varmuuskopiot';
export const LATEST_FILENAME = 'arvi-varmuuskopio-uusin.json';
export const DAILY_PREFIX = 'arvi-varmuuskopio-';
export const DAILY_REGEX = /^arvi-varmuuskopio-(\d{4}-\d{2}-\d{2})\.json$/;

export const DEFAULT_RETENTION = {
  daily: 7,
  weekly: 4,
  monthly: 6
};

/**
 * Computes ISO 8601 week key (`YYYY-Www`) from a `YYYY-MM-DD` date string.
 */
export function getIsoWeekKey(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Plans tiered GFS backup retention over dated Arvi backup filenames:
 * - Tier 1 (daily): N most recent distinct days
 * - Tier 2 (weekly): M most recent older ISO weeks (1 per week)
 * - Tier 3 (monthly): K most recent older calendar months (1 per month)
 *
 * Non-dated files (including `arvi-varmuuskopio-uusin.json` and any unrelated files)
 * are ignored and never scheduled for deletion.
 */
export function planBackupRetention(filenames, policy = DEFAULT_RETENTION) {
  const dated = [];
  const seen = new Set();

  for (const name of filenames) {
    if (typeof name !== 'string' || seen.has(name)) continue;
    const match = DAILY_REGEX.exec(name);
    if (!match) continue;
    seen.add(name);
    const dateStr = match[1];
    dated.push({
      name,
      dateStr,
      weekKey: getIsoWeekKey(dateStr),
      monthKey: dateStr.slice(0, 7)
    });
  }

  // Newest YYYY-MM-DD first
  dated.sort((a, b) => (a.dateStr < b.dateStr ? 1 : a.dateStr > b.dateStr ? -1 : 0));

  const dailyLimit = Math.max(0, policy.daily ?? DEFAULT_RETENTION.daily);
  const weeklyLimit = Math.max(0, policy.weekly ?? DEFAULT_RETENTION.weekly);
  const monthlyLimit = Math.max(0, policy.monthly ?? DEFAULT_RETENTION.monthly);

  const daily = [];
  const weekly = [];
  const monthly = [];
  const toDelete = [];

  const usedWeeks = new Set();
  const usedMonths = new Set();

  // Tier 1: Daily
  for (let i = 0; i < dated.length && i < dailyLimit; i++) {
    const item = dated[i];
    daily.push(item.name);
    usedWeeks.add(item.weekKey);
    usedMonths.add(item.monthKey);
  }

  // Tier 2: Weekly (among remaining older files)
  const afterDaily = [];
  for (let i = dailyLimit; i < dated.length; i++) {
    const item = dated[i];
    if (weekly.length < weeklyLimit && !usedWeeks.has(item.weekKey)) {
      weekly.push(item.name);
      usedWeeks.add(item.weekKey);
      usedMonths.add(item.monthKey);
    } else {
      afterDaily.push(item);
    }
  }

  // Tier 3: Monthly (among remaining older files)
  for (const item of afterDaily) {
    if (monthly.length < monthlyLimit && !usedMonths.has(item.monthKey)) {
      monthly.push(item.name);
      usedMonths.add(item.monthKey);
    } else {
      toDelete.push(item.name);
    }
  }

  return {
    keep: [...daily, ...weekly, ...monthly],
    delete: toDelete,
    tiers: { daily, weekly, monthly }
  };
}
