**AgentToll proje incelemesi — 8 Eylül 2026**

İncelenen sürüm: `8e387bd`. Kapsam: Express API, veri servisleri, x402 ödeme akışı, MCP sunucusu, tarayıcı ödeme kodu, keşif belgeleri, CI ve bağımlılıklar.

Değerlendirmem: Projenin güçlü tarafı, Base üzerinde yeni havuzu bulma → riskini açıklama → geçmiş sonucu denetleme akışını küçük, ücretli API çağrılarına dönüştürmesi. Birden fazla veri kaynağı, kısmi yanıtların bazı servislerde açıkça işaretlenmesi ve günlük kayıtlar iyi temeller. Öncelik, yeni endpoint eklemeden önce güvenlik kararlarının doğruluğunu ve otomatik ödeme sınırlarını sağlamlaştırmak olmalı.

Uygulama kodunu değiştirmedim. Hata senaryolarında dış servisler sahte yanıtlarla değiştirildi; ödeme denemelerinde yeni üretilen geçici test anahtarları kullanıldı ve gerçek işlem gönderilmedi. Canlı serviste yalnızca iki keşif adresi, sağlık adresi ve imzasız bir 402 fiyat teklifi kontrol edildi. Görsel tarayıcı/erişilebilirlik denetimi ve gerçek ödeme ile uçtan uca işlem bu incelemenin kapsamında çalıştırılmadı.

**Öncelik sırası**

P1: Kullanıcı güvenini, kimlik doğruluğunu veya otomatik harcamayı doğrudan etkiler; ilk düzeltme paketine alınmalı. P2: Veri doğruluğu, kullanılabilirlik veya bakım açısından sıradaki paket. Bağımlılık uyarıları, uygulamada istismar doğrulandığı anlamına gelmez.

| No | Öncelik | Bulgu | Kanıt |
|---|---|---|---|
| 1 | P1 | Eksik güvenlik verisi `clear` sonucuna dönüşebiliyor | Kontrollü servis testi |
| 2 | P1 | MCP ve ödeme yardımcısında fiyat/harcama sınırı yok | Gerçek MCP callback'i, sahte 50 USDC teklifi |
| 3 | P1 | Basename ters çözümleme ileri yönde doğrulanmıyor | Sahte RPC yanıtıyla kimlik testi |
| 4 | P1 | CORS, x402 v2 ödeme başlıklarını desteklemiyor | Yerel OPTIONS ve canlı yanıt başlıkları |
| 5 | P2 | Tarayıcı ödeme hata yolunda kapsam dışı değişken var | TypeScript TS2304; dağıtılan paket kaynakla eşleşiyor |
| 6 | P2 | Wallet watch sayfalama yapmadan imleci ilerletiyor | 51 işlemli kontrollü senaryo |
| 7 | P2 | Scorecard çift sayıda gözlemde medyanı yanlış hesaplıyor | `[0, 100] → 100`, beklenen `50` |
| 8 | P2 | Binance USDT yedeğinde parite yönü ters | `1 USDC = 1.1 USDT` senaryosu |
| 9 | P2 | Özel alıcı cüzdanın istatistiğine başka cüzdanın geçmişi ekleniyor | Gerçekte 0 çağrı, yanıtta 7 çağrı |
| 10 | P2 | Eşzamanlı aynı cache anahtarları upstream çağrılarını birleştirmiyor | 10 istek → 10 yükleme |
| 11 | P2 | Rate limit büyük/küçük harf ve proxy varsayımıyla aşılabiliyor | Yerel 429 → aynı IP ile 200 |
| 12 | P2 | Üretim bağımlılıklarında güvenlik uyarıları var | Root: 2 yüksek + 3 orta; MCP: 1 yüksek + 2 orta |

**1. Eksik veriyle olumlu güvenlik kararı**

Kaynak: `src/services/safety.ts:35`, `:154`, `:178`, `:196`, `:241`, `:498`.

`Number(null)` sıfıra dönüşüyor. Sahip yetkileri alanları hiç gelmese de `flag(undefined)` false oluyor ve boş yetki listesi `pass` sayılıyor. Sadece alış vergisi biliniyorken satış vergisi bilinmese de vergiler kontrolü geçebiliyor. Yüzdeleri eksik holder kayıtları da sıfır pay gibi değerlendirilebiliyor.

Kontrollü örnekte hiçbir owner flag'i yoktu; satış vergisi yoktu; holder ve creator yüzdeleri null idi. Simülasyonun ve kalan kontrollerin başarılı yanıtlarıyla sonuç `verdict: "clear"`, `unchecked: []` oldu. Vergi açıklaması aynı anda `Buy tax 0%, sell tax ?%` diyordu. Bu, eksik verinin hiçbir zaman temiz sonuç üretmeyeceği ürün vaadiyle çelişiyor. Canlı bir tokenın gerçekten yanlış sınıflandığına ilişkin gözlem yapılmadı; kanıt eksik upstream yanıtını işleyen kod yoludur.

Öneri: Kaynak yanıtlarını çalışma anında doğrulayan şemalar kullan; null, boş değer ve bulunmayan alanları sıfıra çevirme. Her kontrol için gerekli alanları tanımla. Yalnızca açıkça tamamlanan kontroller `pass` üretsin. Kabul ölçütü: Bu fixture `insufficient-data` dönmeli ve eksik kontroller `unchecked` içinde görünmeli.

**2. Otomatik ödeme tutarı sınırlandırılmıyor**

Kaynak: `mcp/server.ts:43`, `:55`; `src/pay.ts:21`.

İstemciler uygun ağdaki ödeme teklifini kabul ediyor; endpoint için beklenen azami fiyat, izin verilen alıcı/varlık ve toplam oturum bütçesi kontrol edilmiyor. Tool açıklamasında `$0.001` yazması imzalanacak tutarı sınırlamıyor.

Hem ödeme yardımcısı hem gerçek MCP `get_price` callback'i, sahte bir sunucunun `amount: "50000000"` teklifini 50 USDC olarak imzaladı. Test Base Sepolia kimliği ve geçici bir anahtarla, tüm ağ çağrıları taklit edilerek yapıldı; gerçek tahsilat olmadı. Risk, fiyatın yanlış yapılandırılması, sunucunun ele geçirilmesi veya kontrolsüz agent döngülerinde ortaya çıkar.

Öneri: İmzadan önce endpoint fiyat tavanı, toplam bütçe, ağ, USDC kontratı ve alıcı kontrolü uygula. Bütçeyi eşzamanlı çağrılara karşı atomik ayır; timeout sonrası sonucu belirsiz ödeme yetkilerini hemen serbest bırakma. MCP'de bütçe durumunu ücretsiz okuyabilen bir araç sun. Kabul ölçütü: 50 USDC teklifi imza üretilmeden reddedilmeli. İstemci bütçe yönetimi x402 protokolünün kendi kapsamı dışında; uygulama katmanında yapılmalı. [x402 belirtimi](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)

**3. Basename kimliği doğrulanmadan gösteriliyor**

Kaynak: `src/services/basename.ts:155`.

Adresin reverse resolver'ından gelen isim doğrudan `hasPrimaryName: true` ile dönüyor. Bu ismin tekrar çözülüp aynı adrese işaret ettiği kontrol edilmiyor. Böylece yanlış veya kötü niyetli reverse kayıt, adres ve portföy yanıtlarında başkasının adı gibi görünebilir.

Kontrollü testte bir adresin reverse yanıtı `someone-else.base.eth` olarak verildi. Servis bunu kabul etti; yalnızca iki RPC çağrısı yaptı ve ileri adres çözümlemesi hiç yapmadı.

Öneri: İsim → adres çözümlemesi ilgili ağda başlangıç adresiyle eşleşmedikçe doğrulanmış isim sunma. Eşleşmeyen isim için null veya açık doğrulama durumu kullan. Bu kontrol ENS dokümanında da zorunlu olarak belirtiliyor. [ENS Primary Names](https://docs.ens.domains/web/reverse/)

**4. x402 v2 CORS uyumsuzluğu**

Kaynak: `src/app.ts:159`.

API yalnızca `Content-Type, X-PAYMENT` başlıklarına izin veriyor; yalnızca `X-PAYMENT-RESPONSE` başlığını tarayıcıya açıyor. Kullanılan v2 SDK ise `PAYMENT-SIGNATURE`, `PAYMENT-REQUIRED` ve `PAYMENT-RESPONSE` kullanıyor. [x402 belirtimi](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)

Yerel OPTIONS testinde `payment-signature` talep edildiğinde izin verilen başlıklarda bulunmadı. Canlı serviste de aynı eski CORS başlıkları görüldü. Sonuç: Farklı bir web origin'inden çalışan istemci 402 teklifini okuyamaz ve imzalı tekrar isteğini gönderemez. Aynı origin'deki ana sayfa demosu bu CORS sorunundan etkilenmez.

Öneri: V2 başlıklarını allow/expose listelerine ekle; v1 desteği isteniyorsa eski başlıkları koru. İki farklı origin arasında gerçek tarayıcı entegrasyon testi ekle.

**5. Tarayıcı ödeme hata yolu derlenemiyor**

Kaynak: `web/demo.ts:160`; `tsconfig.json:14`; `.github/workflows/consistency.yml`.

`wallet`, try bloğunda tanımlanıyor fakat catch bloğunda kullanılıyor. Ayrı web typecheck'i `TS2304: Cannot find name 'wallet'` hatası verdi. İmza doğrulama hatasının bu dalında asıl kullanıcı hatası yerine ReferenceError oluşabilir.

Ana TypeScript yapılandırması yalnızca `src` klasörünü kapsıyor. Web paketi esbuild ile üretildiği için bu kapsam hatası paket üretimini engellemiyor. Bellekte yeniden ürettiğim paket, repodaki `public/demo.js` ile aynı hash'e sahip: sorun yalnızca kullanılmayan kaynakta değil, mevcut pakette de bulunuyor.

Öneri: Catch'in ihtiyaç duyduğu adresi uygun kapsamda tut. CI'a API, MCP ve web için ayrı typecheck; ardından web bundle doğrulaması ekle. İmza reddi, hatalı ağ, yetersiz bakiye ve facilitator hatası senaryolarını kontrol et.

**6. Wallet watch işlem kaybedebiliyor**

Kaynak: `src/services/watch.ts:36`, `:45`, `:63`.

Blockscout'un sadece ilk işlem sayfası okunuyor; `next_page_params` atılıyor. İmleç en yeni işleme taşındığı için okunmayan eski sayfalardaki işlemler sonraki çağrılarda da dışarıda kalıyor.

51 yeni işlem içeren testte ilk cevap 50 işlem verdi. Bu cevabın imleciyle ikinci çağrı 0 işlem verdi; 51. işlem hiç teslim edilmedi. Ayrıca yalnız timestamp kullanan imleç aynı blok/zamandaki gecikmeli indekslenen işlemleri ayırt edemiyor. Radar watch da sınırlı, hacme göre sıralanan radar listesinden beslendiği için eksiksiz olay akışı garantisi sunmuyor.

Öneri: Blok numarası + işlem/log konumu içeren imleç ve sayfalama kullan. Bir cevapta sınıra ulaşılırsa devam imleci ve `hasMore`/`partial` döndür; okunmamış aralığın ötesine ilerleme. Gecikmeli indeksleme ve reorg için küçük örtüşme aralığı ile tekilleştirme uygula.

**7. Scorecard medyanı yanlış**

Kaynak: `src/services/history.ts:176`.

Sıralı listenin `floor(n/2)` elemanı her durumda medyan kabul ediliyor. Çift sayıda gözlemde ortadaki iki elemanın ortalaması alınmalı. Testte değişimler `[0, 100]` iken `medianChangePct` 100 döndü; doğru değer 50.

Öneri: Boş, tek, tek sayılı ve çift sayılı grupları kapsayan küçük bir medyan fonksiyonu kullan. Bu istatistik ürünün kendi başarı değerlendirmesinde yer aldığı için doğruluğu öncelikli.

**8. USDT fiyatında parite yönü hatası**

Kaynak: `src/services/prices.ts:77`.

USDT için Binance yedeği `USDCUSDT` paritesini seçiyor fakat `lastPrice` değerini doğrudan USDT'nin USD fiyatı diye döndürüyor. Bu parite bir USDC'nin kaç USDT olduğunu verir. Testte `1 USDC = 1.1 USDT` geldiğinde API 1 USDT için `$1.1` döndü. USDC'nin $1 olduğu varsayımı altında ters oran yaklaşık `$0.9091` olurdu.

Öneri: Doğru yöndeki gerçek USD kotasyonunu kullan veya çapraz kuru doğru yönde hesapla; 24 saatlik değişimi de aynı dönüşüme tabi tut. Genel USDT kotasyonlarını da USD ile birebir kabul ediyorsan bu varsayımı yanıtta açıkça belirt. Bu hata TRY spread ve fiyat alarmına da taşınabilir.

**9. İstatistik geçmişi alıcı ve ağa bağlanmıyor**

Kaynak: `src/services/stats.ts:108`, `:214`, `:221`, `:288`.

Başlangıç geçmişi sabit AgentToll GitHub dosyasından alınıyor. Dosyadaki `network` ve `payTo` alanları doğrulanmıyor; geçmiş sayaçlar parametreyle gelen başka bir alıcı için de kopyalanıyor. Üstelik o yabancı geçmiş, doğru Blockscout yanıtını eksik sayıp fallback'e zorlayabiliyor.

Kontrollü testte özel alıcı cüzdan için hiç transfer yoktu. Sabit geçmiş başka alıcıya ait 7 çağrı içeriyordu. `getStats` özel cüzdan için yine 7 çağrı döndürdü. Bu özellikle self-hosting ve testnet kurulumlarını etkiliyor.

Öneri: Geçmiş dosyasının ağ/alıcı eşleşmesini zorunlu yap; eşleşmiyorsa doğru başlangıç bloğundan hesapla veya bu kurulum için baseline olmadığını açıkça bildir. Cache anahtarlarını da ağ ve alıcıyla oluştur.

**10. Cache, eşzamanlı istekleri birleştirmiyor**

Kaynak: `src/services/cache.ts:6`.

Cache'e yalnızca tamamlanmış sonuç yazılıyor. Aynı anahtar için sonuç gelmeden başlayan her istek ayrı upstream yüklemesi yapıyor. Testte aynı anahtara 10 eşzamanlı çağrı 10 yükleme üretti. Bu durum özellikle cold start ve TTL bitişinde sağlayıcı kotasını hızla tüketebilir.

Öneri: Devam eden Promise'leri anahtar bazında paylaş; hata sonrası kaydı temizle. Sonraki adımda ölçümler gerektiriyorsa instance'lar arasında ortak cache/sağlayıcı kotası ekle. `getGas` gibi cache dışı sık çağrılan akışları da maliyet ölçümüne dahil et.

**11. Rate limit normalizasyonu ve proxy güveni**

Kaynak: `src/app.ts:67`, `:143`, `:146`.

Express rota eşleştirmesi varsayılan olarak büyük/küçük harfe duyarsız; rate limit'in `/api/` kontrolü duyarlı. Yerel testte `/api/health` için 61. istek 429 dönerken aynı IP'nin `/API/health` isteği 200 döndü. Ücretsiz rotaların sondaki slash varyantları da farklı limit sınıfına düşüyor.

`trust proxy: true` doğrudan çalışan yerel/self-hosted sunucuda istemcinin X-Forwarded-For değerini güvenilir sayıyor. Testte bu başlığı değiştirerek aynı 429 sınırından 200 yanıtına geçilebildi. Vercel'in gerçek proxy katmanında IP başlığı sahteciliği ayrıca denenmedi; oradaki etkisi proxy'nin başlıkları nasıl temizlediğine bağlı. [Express proxy rehberi](https://expressjs.com/en/guide/behind-proxies/)

Öneri: Rota normalizasyonunu limiter ve logger için ortak yap; güvenilen proxy kapsamını dağıtıma göre belirle. Instance içi limitin toplam servis kotası garantisi vermediğini operasyon metriklerinde hesaba kat.

**12. Bağımlılık ve güvenlik dokümanı güncelliği**

`npm audit --omit=dev`: root pakette 2 yüksek, 3 orta uyarı. `npm audit --prefix mcp --omit=dev`: MCP paketinde 1 yüksek, 2 orta uyarı. Bu iki ağaç örtüşüyor; toplamları ayrı açık sayısı gibi toplanmamalı.

Root ağacında `axios@1.16.0`, Coinbase SDK üzerinden; `fast-uri@3.1.4`, MCP SDK → AJV üzerinden; `qs@6.15.3`, Express üzerinden geliyor. Dolayısıyla SECURITY.md'deki bütün uyarıların yalnızca opsiyonel wallet UI bağımlılıklarında olduğu açıklaması güncel durumu anlatmıyor. Audit düzeltme bulunduğunu bildiriyor; uygulamadaki istismar edilebilirlik ayrıca incelenmeli. [fast-uri duyurusu](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7), [Axios duyurusu](https://github.com/advisories/GHSA-pmv8-rq9r-6j72)

Öneri: İki lockfile'ı kontrollü güncelle; typecheck ve ödeme/servis hata senaryolarını ardından çalıştır. Doğrudan kullanılmayan bağımlılıkları ayır. SECURITY.md'deki testnet aşaması, sunucuda hiç secret olmadığı ve ödeme rate limit'i açıklamalarını mevcut mainnet/CDP yapılandırmasına göre düzelt.

**Ek bakım ve veri modeli eksikleri**

| Alan | Gözlem ve öneri |
|---|---|
| Tek kaynak | Endpoint, fiyat ve şema bilgisi app, discovery, OpenAPI, MCP ve metinlerde tekrar ediyor. Mevcut regex kontrolleri yararlı, ancak eşit sayılar doğru eşleşme garantisi vermiyor. Tipli bir endpoint kayıt tablosundan üretim yap. |
| Sürüm ve metinler | `mcp/package.json` 0.13.0 iken MCP handshake sürümü `mcp/server.ts:61` içinde 0.7.0. README'nin MCP araç listesi ve `public/run.js` içindeki 20 endpoint ifadesi de mevcut 21 endpoint'in gerisinde. |
| Parametreler | `src/services/fresh.ts:293` yalnızca tam `false` değerini false sayıyor; `banana`, `0` ve `False` true oluyor. Belirlenmiş boolean değerleri kabul et, diğerlerini 400 yap. |
| Kurulum | ADDRESS, NETWORK ve URL'leri başlangıçta şemayla doğrula. Agent card ödeme ağı sabit mainnet; watch ise NETWORK'e göre testnet'e geçiyor, diğer bazı veri servisleri mainnet'te kalıyor. Ödeme ağı ile veri ağını açıkça ayır. |
| Scorecard metodolojisi | Fiyat sağlayıcısında bulunmayan kayıt doğrudan `liquidityGone` sayılıyor. `priceUnavailable` ile doğrulanmış likidite kaybını ayır. null safety ve ulaşılamayan snapshot'ların kapsama etkisini görünür kıl. |
| Geçmiş doğrulama | Snapshot'lar güncel `main` URL'sinden okunuyor. Daha güçlü kanıt için commit SHA ve yanıt özeti/signed receipt kullan. Ödeme tx'si tek başına yanıt içeriğini kriptografik olarak bağlamaz. |
| Zaman ve kalite | Yanıtlarda `observedAt`, `servedAt`, `ageSeconds`, kaynak, blok numarası ve tamamlanan kontrol oranını ortak biçimde sun. Snapshot zamanı ile verinin gözlendiği zamanı ayır. |
| Hata sözleşmesi | `code`, `retryable`, `retryAfter`, `requestId` alanları olan tek hata yapısı kullan. Sağlık kontrolü yalnızca süreç canlılığını söylüyor; ödeme ve upstream hazırlığını ayrı kontrol et. MCP çağrılarına açık toplam süre sınırı ekle. |

**Geliştirmeye değer ürün fikirleri**

1. **Yeni havuzdan izlemeye tek akış.** Mevcut `fresh → safety → watch → scorecard` yeteneklerini belgelerde ve geliştirici deneyiminde birleştir. `scout` şu anda radar tabanlı; `fresh` tabanlı, kaynak ve yaş bilgisi taşıyan isteğe bağlı bir araştırma akışı ayrı değer sunabilir. İlk başarı ölçütü: geliştiricinin ilk anlamlı yanıtı almasına kadar geçen süre.

2. **Bütçesi belli MCP.** Çağrı başına tavan, oturum bütçesi, kalan bütçeyi okuma ve sadece fiyat teklifi alma seçenekleri sun. Kullanıcı her çağrıda müdahale etmeden sınırları belirleyebilsin. Bu, otonom kullanım için doğrudan ürün özelliği olabilir.

3. **Açıklanabilir güvenlik çıktısı.** Sadece verdict yerine hangi kaynağın hangi kontrolü ne zaman yapabildiğini göster. Birleşik, belirsiz bir güven puanı yerine eksik veriyi ayrı boyut olarak koru. Böylece agent kendi risk politikasını uygulayabilir.

4. **Sabit vadeli scorecard.** İlk gözlemden +24 saat ve +72 saat sonraki sonuçları kaydet; farklı yaşlardaki tokenları aynı 'şimdi' fiyatıyla karşılaştırmaya bağımlılığı azalt. Medyanın yanında örnek sayısı, kapsanan/verisi eksik token sayısı ve likidite kaybını göster.

5. **Kullanımı kolay SDK ve deneme ortamı.** Tipli TypeScript/Python istemcisi, geçerli testnet örneği, quote-only modu ve ortak hata kodları sun. Demo fiyatı okuduktan sonra ağı tekliften seçsin; mevcut tarayıcı ödeme kodu Base mainnet'e sabitlenmiş.

6. **Endpoint başına gerçek operasyon metriği.** 402 teklifinden imzalı çağrıya ve başarılı tahsilata dönüşüm; upstream hata oranı, p95 süre, cache isabeti, dış servis çağrı adedi ve tahsilat başına maliyet ölç. İstatistiklerde farklı cüzdan sayısını doğrudan farklı kullanıcı/agent sayısıyla eşitleme.

7. **Tek kayıt tablosundan yayın.** Fiyat, rota, parametre doğrulaması ve örnekleri aynı tanım üzerinden API, MCP ve OpenAPI'ye taşı. Mevcut Express yapısını koruyarak bakım maliyetini azaltmak yeterli; bu bulgular yeni framework gerektirmiyor.

Yerel kayıtlar 6 Ağustos–7 Eylül arasında 33 günlük snapshot, 131 havuz gözlemi ve 129 farklı token içeriyor. Havuz gözlemlerinin dağılımı: 34 high-risk, 88 caution, 6 insufficient-data, 3 kontrolsüz; clear yok. Bunlar gözlem sayılarıdır, bağımsız kullanıcı veya doğrulanmış tahmin başarısı sayıları değildir. Örneklem, kapsam ve eksik kontrol oranlarını ürün içinde göstermek için kullanılabilir.

**Önerdiğim uygulama sırası**

| Paket | İşler | Tamamlanma ölçütü |
|---|---|---|
| 1 — Güven ve ödeme | Eksik veri semantiği, MCP fiyat/bütçe politikası, Basename doğrulaması, CORS | Eksik veri clear olmaz; pahalı teklif imzalanmaz; yanlış isim kabul edilmez; farklı origin ödeme akışı çalışır |
| 2 — Doğruluk ve CI | Web hatası/typecheck, watch imleci, medyan, USDT oranı, stats baseline kimliği, bağımlılık güncellemeleri | Bu rapordaki kontrollü hata senaryoları regresyon kontrolleri olarak geçer |
| 3 — Dayanıklılık | Aynı anahtardaki çağrıları birleştirme, limiter normalizasyonu, ortak deadline ve metrikler | Burst altında upstream yükü sınırlı kalır; kaynak hataları ve gecikmeler ölçülebilir |
| 4 — Ürün | Bütçeli MCP deneyimi, sabit vadeli scorecard, tek kayıt tablosu, odaklı onboarding | İlk başarılı entegrasyon kolaylaşır; verinin kapsamı ve maliyeti anlaşılır olur |

**Çalıştırılan kontroller**

| Kontrol | Sonuç |
|---|---|
| `npm run build -- --noEmit` | Geçti |
| MCP TypeScript `--noEmit` | Geçti |
| `node scripts/consistency.mjs` | Geçti: 21 ücretli rota, 21 MCP aracı |
| `node --import tsx scripts/openapi-examples.mjs --check` | Geçti: 21 örnek güncel |
| Web TypeScript, ES2022/NodeNext/strict/skipLibCheck | Başarısız: `web/demo.ts(160,56) TS2304` |
| Bellekte web bundle üretimi ve hash karşılaştırması | Üretildi; `public/demo.js` ile aynı |
| Root ve MCP production dependency audit | Yukarıdaki uyarılar bulundu; paketler değiştirilmedi |
| Kontrollü güvenlik, harcama, Basename, watch, medyan, USDT, stats, cache ve limiter senaryoları | Yukarıdaki davranışlar tekrar üretildi |
| Canlı `/.well-known/x402`, `/.well-known/agent-card.json`, `/api/health` | 200; sağlık yanıtı mainnet `base` |
| Canlı imzasız `/api/base/fresh` | Beklenen 402; CORS uyumsuzluğu görüldü |
| Yerel büyük/küçük harf ve trailing slash ödeme kapısı kontrolleri | Denenen ücretli rota varyantları 402 kaldı; ödeme kapısını aşma gözlenmedi |
| Git'e dahil secret dosyaları ve basit literal taraması | `.env` ve test cüzdanı dosyası takip edilmiyor; basit taramada literal secret adayı çıkmadı; geçmişi kapsayan tam secret audit yapılmadı |

Bu rapor dışında uygulama veya yapılandırma dosyası değiştirilmedi. İnceleme başında var olan `brand-out/` içeriğine dokunulmadı.
