'use strict';

/** Public copy configuration only; never authority or a financial product setting. */
function publicInfo(raw) {
  let contactUrl = null,
    retentionNotice = null;
  if (raw && typeof raw.contactUrl === 'string' && raw.contactUrl.length <= 2048) {
    try {
      let parsed = new URL(raw.contactUrl);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) contactUrl = parsed.href;
      if (parsed.protocol === 'mailto:' && /^[^\s?&#]+@[^\s?&#]+\.[^\s?&#]+$/.test(parsed.pathname) && !parsed.search && !parsed.hash)
        contactUrl = parsed.href;
    } catch (e) {}
  }
  if (raw && typeof raw.retentionNotice === 'string' && raw.retentionNotice.trim().length > 0 && raw.retentionNotice.length <= 1000)
    retentionNotice = raw.retentionNotice.trim();
  return { contactUrl: contactUrl, retentionNotice: retentionNotice };
}
module.exports = { publicInfo: publicInfo };
