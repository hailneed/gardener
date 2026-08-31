# gardener

> Talimat dosyalarının **bağlam hijyeni**. `CLAUDE.md`, `AGENTS.md` ve import ettikleri her
> şeyi tek bir sıcak bağlam envanterine çevirir, **her istekte** ne kadara mal olduğunu
> ölçer, kırık import / bayat atıf / yinelenen talimat bulur ve kuralları gerçek oturumlarda
> çalıştırılmış komutlarla karşılaştırır.
> Ağ çağrısı yok, kota harcanmaz, talimat dosyana asla yazmaz.
>
> *English summary below.*

**Site:** https://hailneed.github.io/gardener/

Talimat dosyası deponun **en pahalı metnidir**: her satırın bedeli bir kez değil, her
istekte yeniden ödenir. Ama bakımını kimse yapmaz — büyür, çelişir, olmayan dosyalara atıf
yapar ve hiç kimse hangi kuralın gerçekten uygulandığını bilmez.

## Ne yapar?

| Komut | Ne verir |
|---|---|
| `/gardener:audit` | **Ne yükleniyor**: import zinciri çözülmüş dosya listesi, satır ve tahmini token maliyeti, kırık import, bayat yol, yinelenen talimat |
| `/gardener:compliance` | **Uygulanıyor mu**: yasakların gerçek komutlarla karşılaştırması ve konusu hiç ortaya çıkmayan ölü kurallar |
| `/gardener:prune` | **Ne çıkarılabilir**: satır satır `cut` / `move` / `fix` / `rewrite` / `enforce` planı, gerekçesiyle |

## Sıcak bağlam nedir?

Yalnızca **her istekte** yüklenen metin:

- `~/.claude/CLAUDE.md` · `~/.codex/AGENTS.md` · `~/.gemini/GEMINI.md`
- deponun `CLAUDE.md` · `AGENTS.md` · `GEMINI.md` · `.claude/CLAUDE.md` dosyaları
- bunların `@yol` ile çektiği her şey, **özyinelemeli olarak**

**Kapsam dışı:** skill gövdeleri ve `references/` dosyaları. Onlar talep üzerine yüklenir;
ölçümleri `skillbench`'in işidir. İkisini karıştırmak, geniş bir skill kütüphanesini bağlam
sorunu gibi gösterirdi.

Import çözümü ciddi bir iş: bir dosya başka birini, o da başkasını çekebilir. Rapor
**gerçekten yüklenen** listeyi verir, üstteki dosyanın söylediğini değil. Çözülemeyen import
sessizce atlanmaz — `⚠` ile işaretlenir, çünkü "o kurallar yükleniyor" sanmak en pahalı
yanılgıdır.

## Bütçe

| Eşik | Değer |
|---|---|
| dosya, uyarı / hata | 300 / 600 satır |
| toplam, uyarı / hata | 4.000 / 8.000 tahmini token |

Token sayısı gerçek tokenizer'dan değil, **bayt/4 kestiriminden** gelir. Dosyaları
birbiriyle karşılaştırmaya ve zaman içindeki değişimi izlemeye yeter; kesin değildir ve
rapor bunu her seferinde söyler.

## Uyum nasıl ölçülüyor?

Yasak içeren bir kuralın öznesi (`git push --force` gibi bir komut), gerçek oturum
kayıtlarındaki komutlarla karşılaştırılır. Eşleşme varsa **ihlal adayı** üretilir.

> Bu bir aday üreticisidir, kanıt değil. Kural bir konumu ya da bağlamı yasaklıyor olabilir;
> eşleştirici bunu göremez. Skill her satırı açıp doğrular ve kaç tanesini elediğini söyler.

Gürültüyü kesmek için yalnızca **komut biçimli** özneler denetlenir: yapılandırma anahtarı
(`trusted: false`), kod ifadesi (`window.PageContext.messages`) ve SQL parçaları dışarıda
kalır. Şablonlu komutlar kararlı çekirdeğinden aranır — `claude plugin validate <repo>
--strict`, gerçek `claude plugin validate . --strict` çağrısıyla eşleşir.

Bir de tersi var: konusu **hiçbir** oturumda geçmeyen kurallar. Burada iki durum veride
birebir aynı görünür ve skill bunları ayırmakla yükümlüdür:

- **İş hiç ortaya çıkmadı** → ölü ağırlık, bedeli boşuna ödeniyor.
- **Kural işe yaradı** → sıfır sayı bir başarıdır. Sıfır sayıya bakıp bir güvenlik kuralını
  silmek, hatayı geri getirmenin en kestirme yoludur.

## Gizlilik ve güvenlik

- Script **ağ çağrısı yapmaz** ve **hiçbir dosyayı düzenlemez**. Plan üretir.
- `prune` skill'i de kendiliğinden `CLAUDE.md`'ye dokunmaz — satırları gösterir, onay ister,
  tek seferde tek dosya düzenler.
- Okunamayan oturum gizlenmez; kaynak notunda sayısı yazar.

## Kurulum

```
# Claude Code içinde, bir kez marketplace ekle:
/plugin marketplace add hailneed/plugins
/plugin install gardener@hailneed
```

Sonra dene:

```
/gardener:audit
```

Gereksinim: Claude Code + Node.js 18+. Bağımlılık yok, API anahtarı yok.

## Plugin'siz kullanım

```
git clone https://github.com/hailneed/gardener
cd gardener

node scripts/gardener.mjs --audit --repo ../my-project --md
node scripts/gardener.mjs --compliance --days 90 --md
node scripts/gardener.mjs --prune --repo ../my-project --md
node scripts/gardener.mjs --selftest
```

Bayraklar: `--agent all|claude-code|codex|gemini-cli` · `--repo DIZIN` · `--days N` ·
`--lang tr|en` · `--out DOSYA` · `--limit N` · `--ignore kural1,kural2`.

CI'da `--audit --out audit.json` çalıştırıp `totals.tokens` ya da `score.raw` değerini eşiğe
bağlayabilirsin; çıktı formatı sabittir ve `--selftest` ağ gerektirmez.

## Yol haritası (ve nasıl para kazanır)

- **v0.1 (bu repo):** 3 skill + bağımlılıksız tarayıcı + 10 denetim, MIT.
- **v0.2:** gerçek tokenizer ile kesin sayım, çelişki adayları (aynı özneye zıt iki kural),
  hafıza dosyası hijyeni, zaman içinde bağlam bütçesi grafiği, `--format sarif`.
- **Gardener Cloud (ücretli, opsiyonel):** ekip talimat dosyaları için sürekli bütçe takibi,
  kural değişikliğinin davranışa etkisinin öncesi/sonrası karşılaştırması, yeni gelen için
  "bu depoda gerçekten geçerli kurallar" özeti. Plugin ücretsiz kalır.
  Bekleme listesi: https://hailneed.github.io/gardener/#cloud

Bu depo `agentlens` ailesinin parçası: adaptör katmanı `agent-blackbox` ile paylaşılır,
kanonik kopya orada durur.

---

## English summary

**gardener** is context hygiene for agent instruction files.

- **`/gardener:audit`** — resolves `CLAUDE.md`, `AGENTS.md` and their `@path` imports
  transitively into one inventory, prices what loads on **every request** in lines and
  estimated tokens, and flags broken imports, stale references and duplicated instructions.
- **`/gardener:compliance`** — cross-references prohibitions against the commands really run
  in local sessions to surface violation *candidates*, and lists rules whose subject never
  came up. It insists on the distinction between a rule that is dead weight and a rule that
  is quietly working.
- **`/gardener:prune`** — a line-by-line plan marking each flagged directive cut, move, fix,
  rewrite or enforce, plus the structural split between what belongs in the always-loaded
  file and what belongs in an on-demand one.

**Honest by construction:** token counts are a bytes/4 estimate and labelled as such;
compliance produces candidates that must be verified; a prohibition with zero occurrences is
reported as a possible success, never as dead weight.

**Nothing leaves your machine and nothing is edited.** No network calls, no API key, no
quota. Node.js 18+, no dependencies.

```
/plugin marketplace add hailneed/plugins
/plugin install gardener@hailneed
```

Or standalone: `node scripts/gardener.mjs --audit --repo . --md --lang en`. MIT.
