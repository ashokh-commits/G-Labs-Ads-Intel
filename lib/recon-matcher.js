/**
 * G6 Labs — Ad Spend Reconciliation matcher
 * Pairs Meta ad invoices against credit card statement charges.
 *
 * Unlike matching sales invoices to bank deposits (same currency, exact
 * amounts), Meta may bill in USD while the card statement shows the
 * FX-converted MYR amount plus card markup — so amount is never a hard
 * filter here, only a soft plausibility signal. Date proximity dominates.
 */

const DATE_WINDOW_DAYS_DEFAULT = 5;
const SUGGEST_THRESHOLD = 0.5;
const WEIGHT_DATE = 0.75;
const WEIGHT_AMOUNT = 0.25;

function daysApart(isoA, isoB) {
  const a = new Date(isoA);
  const b = new Date(isoB);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round(Math.abs(a - b) / 86400000);
}

function dateScore(days, windowDays) {
  if (days === null) return 0;
  if (days === 0) return 1.0;
  if (days <= 3) return 0.9;
  if (days <= 7) return 0.7;
  if (days <= windowDays) return 0.4;
  return 0;
}

// Coarse plausibility check, not a currency conversion: covers same-currency
// (~1x) and USD->MYR (~4-5x) charges without needing a live FX rate. A poor
// ratio never excludes a candidate, it only lowers the score.
function amountPlausibilityScore(invoiceAmount, cardAmount) {
  if (!invoiceAmount || !cardAmount) return 0;
  const ratio = cardAmount / invoiceAmount;
  if (ratio >= 1 && ratio <= 10) return 1.0;
  if (ratio >= 0.5 && ratio < 1) return 0.5;
  if (ratio > 10 && ratio <= 15) return 0.5;
  return 0.1;
}

function amountDiffPct(invoiceAmount, cardAmount) {
  if (!invoiceAmount) return null;
  return Math.round((Math.abs(cardAmount - invoiceAmount) / invoiceAmount) * 10000) / 100;
}

/**
 * @param {Array} invoices - rows with {id, invoice_date, amount}
 * @param {Array} cardTxns - rows with {id, txn_date, amount}
 * @param {Object} opts - {dateWindowDays}
 * @returns {Array} [{invoice_id, card_txn_id, score, date_diff_days, amount_diff_pct}]
 */
function runMatcher(invoices, cardTxns, opts = {}) {
  const windowDays = opts.dateWindowDays || DATE_WINDOW_DAYS_DEFAULT;
  const usedCardTxns = new Set();
  const results = [];

  const sortedInvoices = [...invoices].sort(
    (a, b) => new Date(a.invoice_date) - new Date(b.invoice_date)
  );

  for (const inv of sortedInvoices) {
    let best = null;
    for (const txn of cardTxns) {
      if (usedCardTxns.has(txn.id)) continue;
      const days = daysApart(inv.invoice_date, txn.txn_date);
      if (days === null || days > windowDays) continue;
      const dScore = dateScore(days, windowDays);
      const aScore = amountPlausibilityScore(inv.amount, txn.amount);
      const score = WEIGHT_DATE * dScore + WEIGHT_AMOUNT * aScore;
      if (!best || score > best.score) {
        best = {
          invoice_id: inv.id,
          card_txn_id: txn.id,
          score: Math.round(score * 1000) / 1000,
          date_diff_days: days,
          amount_diff_pct: amountDiffPct(inv.amount, txn.amount),
        };
      }
    }
    if (best && best.score >= SUGGEST_THRESHOLD) {
      results.push(best);
      usedCardTxns.add(best.card_txn_id);
    }
  }

  return results;
}

module.exports = runMatcher;
