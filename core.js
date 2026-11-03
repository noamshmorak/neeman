/* Shared domain logic: dates, pets, consumption estimate, phone numbers. Used by the store app and the sign-up page. */
const DAY = 86400000;
const ymd = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const parseD = s => { const [y,m,d] = String(s).slice(0,10).split('-').map(Number); return new Date(y, m-1, d); };
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate()+n); return ymd(d); };
const diff = (a, b) => Math.round((parseD(a) - parseD(b)) / DAY);
const DOW = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
const fmtD = s => { const d = parseD(s); return d.getDate()+'.'+(d.getMonth()+1); };
const fmtLong = s => { const d = parseD(s); return 'יום '+DOW[d.getDay()]+', '+d.getDate()+'.'+(d.getMonth()+1); };
const ago = s => { const n = diff(today(), s); return n===0?'היום':n===1?'אתמול':'לפני '+n+' ימים'; };
const money = n => '₪'+Math.round(n).toLocaleString('he-IL');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const PETS = {
  dog:   {label:'כלב',          size:'משקל הכלב (ק"ג)', def:15, weight:true,  the:'הכלב'},
  cat:   {label:'חתול',         size:'משקל החתול (ק"ג)', def:4, weight:true,  the:'החתול'},
  rabbit:{label:'ארנב',         size:'כמה ארנבים',        def:1, weight:false, the:'הארנב'},
  hens:  {label:'תרנגולות',     size:'כמה תרנגולות',      def:6, weight:false, the:'התרנגולות'},
  bird:  {label:'תוכים/ציפורים', size:'כמה ציפורים',      def:2, weight:false, the:'הציפורים'}
};
const KINDS = {dog:'מזון לכלב', cat:'מזון לחתול', litter:'חול לחתול', rabbit:'מזון לארנב', hens:'מזון לתרנגולות', bird:'מזון לתוכים'};
const kindsFor = pet => pet==='cat' ? ['cat','litter'] : [pet];

/* grams per day: a starting estimate; real purchase intervals replace it after two purchases */
function dailyGrams(c, p){
  const n = Number(c.size)||1, cnt = Number(c.count)||1;
  switch(p.kind){
    case 'dog': return 30*Math.pow(n,0.75)*cnt;
    case 'cat': return 13*n*cnt;
    case 'litter': return 280*cnt;
    case 'rabbit': return 60*n;
    case 'hens': return 120*n;
    case 'bird': return 30*n;
  }
  return 100;
}
const baseDays = (c, p) => Math.max(3, Math.round(p.kg*1000 / dailyGrams(c, p)));

const normPhone = s => String(s||'').replace(/\D/g,'').replace(/^972/, '0');
const validPhone = s => /^05\d{8}$/.test(normPhone(s));
const intl = s => { const n = normPhone(s); return n.startsWith('0') ? '972'+n.slice(1) : n; };
const prettyPhone = s => { const n = normPhone(s); return n.length===10 ? n.slice(0,3)+'-'+n.slice(3) : n; };

const LOGO_SVG = '<svg class="logo" viewBox="0 0 40 40" aria-hidden="true"><path d="M11 7h18l4 7v19a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V14z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 14h26" stroke="currentColor" stroke-width="1.6"/><circle cx="20" cy="25" r="6.5" fill="none" stroke="#c9a45c" stroke-width="1.6"/><path d="M20 21v4l2.8 1.8" stroke="#c9a45c" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';

function makeClient(){
  const cfg = window.LSN_CONFIG || {};
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT') || !window.supabase) return null;
  return window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
}
function videoPublicUrl(sb, path){ return path ? sb.storage.from('store-videos').getPublicUrl(path).data.publicUrl : null; }
