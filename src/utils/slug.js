// Turns an admin/manager's name into a short, readable referral alias, e.g.
// "Александра" -> "aleksandra", "Ivan Petrov" -> "ivan-petrov".
const db = require('../db');

const CYRILLIC_MAP = {
  а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'e', ж:'zh', з:'z', и:'i', й:'y',
  к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f',
  х:'h', ц:'ts', ч:'ch', ш:'sh', щ:'sch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya'
};

function transliterate(str) {
  return String(str).toLowerCase().split('').map(ch => {
    if (Object.prototype.hasOwnProperty.call(CYRILLIC_MAP, ch)) return CYRILLIC_MAP[ch];
    return ch;
  }).join('');
}

function slugify(str) {
  return transliterate(str)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 40) || 'manager';
}

// Generates a slug from a name and guarantees it doesn't collide with an
// existing admin's ref_slug (appends -2, -3, ... until it's free).
function generateUniqueSlug(name, excludeUserId) {
  const base = slugify(name);
  let candidate = base;
  let n = 2;
  const check = db.prepare('SELECT id FROM users WHERE ref_slug = ? AND id != ?');
  while (check.get(candidate, excludeUserId || 0)) {
    candidate = base + '-' + n;
    n++;
  }
  return candidate;
}

module.exports = { slugify, generateUniqueSlug };
