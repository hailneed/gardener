/**
 * gardener — bulgu düzyazısının iki dilli kataloğu
 *
 * Neden ayrı dosya: `checks.mjs` artık düzyazı üretmez, yalnızca **makine verisi** üretir
 * (`check`, `severity`, konum ve `vars`). Düzyazı burada, raporlama anında uygulanır.
 * Böylece JSON çıktısı dilden bağımsız kalır — CI tüketicisi `check` id'sine bakar,
 * çeviriye değil — ve `--lang` gerçekten tüm raporu çevirir.
 *
 * `why`/`fix` check başına sabittir; `detail` `vars` üzerinden şablonlanır.
 * Kullanıcı metni (direktif satırının kendisi) asla çevrilmez, olduğu gibi geçer.
 */

/** Desteklenen diller. Varsayılan İngilizce: araç İngilizce konuşan bir kitleye çıkıyor. */
export const LANGS = ["en", "tr"];
export const DEFAULT_LANG = "en";

export const normalizeLang = (v) => (String(v || "").toLowerCase() === "tr" ? "tr" : "en");

/** Önem ve puan etiketleri. Anahtarlar İngilizce ve nötr; yalnızca görünen metin çevrilir. */
export const SEVERITY_LABEL = {
  error: { en: "error", tr: "hata" },
  warn: { en: "warn", tr: "uyarı" },
  info: { en: "info", tr: "bilgi" },
};

export const LEVEL_LABEL = {
  poor: { en: "poor", tr: "kötü" },
  fair: { en: "fair", tr: "orta" },
  good: { en: "good", tr: "iyi" },
  clean: { en: "clean", tr: "temiz" },
};

const MESSAGES = {
  "broken-import": {
    detail: {
      en: (v) => `import did not resolve (depth ${v.depth})`,
      tr: (v) => `import çözülemedi (derinlik ${v.depth})`,
    },
    why: {
      en: "An import that fails to resolve is skipped silently, so you believe rules are loading when they are not.",
      tr: "Çözülemeyen import sessizce atlanır; o dosyadaki kuralların yüklendiğini sanırsın.",
    },
    fix: {
      en: "Fix the path, or drop the import line.",
      tr: "Yolu düzelt ya da import satırını kaldır.",
    },
  },
  "hot-file-oversized": {
    detail: {
      en: (v) => `${v.lines} lines · ~${v.tokens} estimated tokens, every request`,
      tr: (v) => `${v.lines} satır · ~${v.tokens} tahmini token, her istekte`,
    },
    why: {
      en: "This size is paid again on every request, and models skip steps in long instruction text.",
      tr: "Bu boyut her istekte yeniden ödenir ve uzun talimat metninde model adımları atlar.",
    },
    fix: {
      en: "Move the reference-style sections into an on-demand file or a skill.",
      tr: "Referans niteliğindeki bölümleri talep üzerine okunan bir dosyaya ya da bir skill'e taşı.",
    },
  },
  "hot-file-large": {
    detail: {
      en: (v) => `${v.lines} lines · ~${v.tokens} estimated tokens`,
      tr: (v) => `${v.lines} satır · ~${v.tokens} tahmini token`,
    },
    why: {
      en: "Every line in hot context is paid for again and again across the session.",
      tr: "Sıcak bağlamdaki her satırın bedeli oturum boyunca tekrarlanır.",
    },
    fix: {
      en: "Split out the sections you rarely need.",
      tr: "Nadiren gereken bölümleri ayır.",
    },
  },
  "hot-budget-exceeded": {
    detail: {
      en: (v) => `${v.files} files · ${v.lines} lines · ~${v.tokens} estimated tokens`,
      tr: (v) => `${v.files} dosya · ${v.lines} satır · ~${v.tokens} tahmini token`,
    },
    why: {
      en: "Every request starts with this budget spent; a meaningful share of the context is full before any work begins.",
      tr: "Her istek bu bütçeyle başlıyor; bağlamın önemli kısmı işe başlamadan doluyor.",
    },
    fix: {
      en: "Start with the largest file: which section is genuinely needed on every request?",
      tr: "En büyük dosyadan başla: hangi bölüm gerçekten her istekte gerekli?",
    },
  },
  "hot-budget-high": {
    detail: {
      en: (v) => `~${v.tokens} estimated tokens, every request`,
      tr: (v) => `~${v.tokens} tahmini token, her istekte`,
    },
    why: {
      en: "As instruction text grows, each individual rule carries less weight.",
      tr: "Talimat metni büyüdükçe tek tek kuralların ağırlığı azalır.",
    },
    fix: {
      en: "Make it a habit: adding a rule means removing an old one.",
      tr: "Yeni kural eklerken bir eskisini çıkarmayı alışkanlık edin.",
    },
  },
  "stale-path": {
    detail: {
      en: (v) => `\`${v.token}\` not found`,
      tr: (v) => `\`${v.token}\` bulunamadı`,
    },
    why: {
      en: "A rule pointing at a file that does not exist quietly makes nothing happen.",
      tr: "Var olmayan bir dosyaya yönlendiren kural sessizce hiçbir şey yaptırmaz.",
    },
    fix: {
      en: "Update the path, or remove the rule.",
      tr: "Yolu güncelle ya da kuralı kaldır.",
    },
  },
  "vague-directive": {
    // detail = direktifin kendi metni; çevrilmez.
    detail: { en: (v) => v.text, tr: (v) => v.text },
    why: {
      en: "A rule whose compliance cannot be judged by reading it produces different behaviour in every reader.",
      tr: "Uygulanıp uygulanmadığı okunarak anlaşılamayan kural, her okuyanda farklı davranış üretir.",
    },
    fix: {
      en: "Write the concrete action: what, when, with which tool.",
      tr: "Somut eylemi yaz: neyi, ne zaman, hangi araçla.",
    },
  },
  "duplicate-directive": {
    detail: {
      en: (v) => `${v.pct}% overlap`,
      tr: (v) => `%${v.pct} örtüşme`,
    },
    why: {
      en: "The same instruction in two places trains the reader to skim, and once one copy is updated and the other is not, they contradict.",
      tr: "Aynı talimatın iki yerde durması okuyanı taramaya alıştırır; biri güncellenip diğeri kalınca da çelişki doğar.",
    },
    fix: {
      en: "Remove one, or if the scopes really do differ, state the difference explicitly.",
      tr: "Birini kaldır, ya da kapsamları gerçekten farklıysa farkı açıkça yaz.",
    },
  },
  "prohibition-seen": {
    detail: {
      en: (v) => `\`${v.token}\` is prohibited but appears in ${v.hits} commands`,
      tr: (v) => `\`${v.token}\` yasaklanmış ama ${v.hits} komutta geçiyor`,
    },
    why: {
      en: "The prohibition is written, yet its subject shows up in real commands — the rule may not be read, or may be worded wrongly.",
      tr: "Yasak yazılmış olmasına rağmen öznesi gerçek komutlarda görünüyor — kural okunmuyor ya da yanlış ifade edilmiş olabilir.",
    },
    fix: {
      en: "Open the examples and check whether they are real violations; if they are, harden the rule or bind it to a hook.",
      tr: "Örnekleri aç ve gerçekten ihlal mi bak; ihlalse kuralı sertleştir ya da bir hook'a bağla.",
    },
  },
  "dead-directive": {
    detail: {
      en: (v) => `\`${v.token}\` never appears in any session`,
      tr: (v) => `\`${v.token}\` hiçbir oturumda geçmiyor`,
    },
    why: {
      en: "A rule whose subject never comes up is dead weight whose cost is paid on every request.",
      tr: "Konusu hiç ortaya çıkmayan kural, her istekte bedeli ödenen ölü ağırlıktır.",
    },
    fix: {
      en: "Ask whether it is genuinely needed; if not, remove it or move it to an on-demand file.",
      tr: "Gerçekten gerekli mi sor; değilse kaldır ya da talep üzerine okunan bir dosyaya taşı.",
    },
  },
};

/** Katalogdaki check id'leri — öz-test bunu bulgu üreticileriyle karşılaştırır. */
export const MESSAGE_KEYS = Object.freeze(Object.keys(MESSAGES));

const pick = (entry, lang) => (entry && (entry[lang] ?? entry[DEFAULT_LANG])) ?? null;

/**
 * Makine bulgusunu seçilen dilde düzyazıyla zenginleştirir.
 * `vars` korunur: JSON tüketicisi çeviriye değil sayılara bakabilsin.
 */
export function renderFinding(finding, lang = DEFAULT_LANG) {
  const L = normalizeLang(lang);
  const m = MESSAGES[finding.check];
  if (!m) return { ...finding };
  const vars = finding.vars || {};
  const detailFn = pick(m.detail, L);
  return {
    ...finding,
    detail: typeof detailFn === "function" ? detailFn(vars) : (finding.detail ?? null),
    why: pick(m.why, L),
    fix: pick(m.fix, L),
  };
}

export const renderFindings = (findings, lang) => findings.map((f) => renderFinding(f, lang));

export const severityLabel = (sev, lang) => pick(SEVERITY_LABEL[sev], normalizeLang(lang)) ?? sev;
export const levelLabel = (lvl, lang) => pick(LEVEL_LABEL[lvl], normalizeLang(lang)) ?? lvl;
