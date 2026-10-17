'use strict';

// Display only: group the integer digits and retain the fractional text verbatim.
// Never parse a visitor's amount through Number, rounding or a fixed currency scale.
function formatReviewAmount(amount) {
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount)) return null;
  let parts = amount.split('.');
  return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (parts.length === 2 ? '.' + parts[1] : '');
}

module.exports = { formatReviewAmount: formatReviewAmount };
