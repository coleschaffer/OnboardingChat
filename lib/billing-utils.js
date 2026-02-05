function parseMoney(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const cleaned = value.toString().replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;

  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCurrency(value) {
  const amount = parseMoney(value);
  if (amount == null) return null;

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(amount);
}

function buildGrandfatheredLine(amount) {
  const numericAmount = parseMoney(amount);
  if (numericAmount == null) return null;

  if (numericAmount === 5000 || numericAmount === 50000) {
    return null;
  }

  const monthly = formatCurrency(numericAmount);
  const pif = formatCurrency(numericAmount * 10);

  if (!monthly || !pif) return null;
  return `However, as an existing member, you are grandfathered in at ${pif} or ${monthly} a month.`;
}

function formatFullName(firstName, lastName) {
  return [firstName, lastName].filter(Boolean).join(' ').trim();
}

module.exports = {
  parseMoney,
  formatCurrency,
  buildGrandfatheredLine,
  formatFullName
};
