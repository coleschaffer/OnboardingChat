const DEFAULT_TIMEZONE = 'America/New_York';

function getDatePartsInTimeZone(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute
  };
}

function getDateKeyInTimeZone(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getMonthKeyInTimeZone(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  return `${parts.year}-${parts.month}`;
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = (dateKey || '').split('-').map(Number);
  if (!year || !month || !day) return null;

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(utcDate.getTime())) return null;

  utcDate.setUTCDate(utcDate.getUTCDate() + days);

  const nextYear = utcDate.getUTCFullYear();
  const nextMonth = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
  const nextDay = String(utcDate.getUTCDate()).padStart(2, '0');
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

module.exports = {
  DEFAULT_TIMEZONE,
  getDatePartsInTimeZone,
  getDateKeyInTimeZone,
  getMonthKeyInTimeZone,
  addDaysToDateKey
};
