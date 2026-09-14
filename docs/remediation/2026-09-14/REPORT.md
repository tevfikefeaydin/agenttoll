# AgentToll — 14 Eylül 2026 düzeltme ve yayın kaydı

Bu çalışma, aynı günkü ayrıntılı incelemede doğrulanan AgentToll kaynaklı eksikleri kapatır. Kullanıcının düzeltme talimatı üzerine uygulama, MCP dağıtımı, ilk kullanım, veri kalitesi ve işletim kontrolleri birlikte ele alındı. İlk incelemenin cüzdan ve ham günlük kanıtları mevcut çalışma alanındaki `docs/audit/2026-09-14/` altında korunuyor.

**Bu commit hazırlanırken durum:** uygulama ve paket düzeltmeleri yerelde tamamlandı; 271 test geçti. Canlı npm/Registry yayını, Hetzner dağıtımı ve saatlik monitor kurulumu henüz doğrulanmış değil. Aşağıdaki yayın bölümü bu adımların gerçek sonuçlarıyla güncellenecek. Hazırlanmış dosya, çalışan servis veya yayımlanmış paket sayılmadı.

## Kapatılan uygulama eksikleri

| Bulgu | Yapılan düzeltme | Doğrulama / sınır |
|---|---|---|
| npm 0.13.0 ile güncel kaynak ve kurulum belgeleri ayrışmıştı | Yeni 0.14.0; package, lock, Registry metadata ve handshake sürümü eşitlendi. Kurulum örnekleri sürüme sabitlendi; eski istemci için yükseltme ve yeniden başlatma açıklandı. | Anahtarsız gerçek stdio süreci, 23 araç, teklif ve bütçe araçları. [Paket kanıtı](mcp-remediation.md). |
| Paket testi depo bağımlılıklarını kullanıyor, yayımlanacak paketi bağımsız sınamıyordu | Tarball ayrı geçici projeye taze bağımlılıklarla kurulur. CI aynı doğrulanmış dosyayı yayımlar; kamuya açık npm sürümünü tekrar indirip SHA-512 ve davranışı karşılaştırır. | Yedi gerçek süreç senaryosu; sıfır bütçe, yanlış alıcı, 100 kat fiyat, timeout ve iptalde sıfır imzalı tekrar. Ağ engelli, geçici fonlanmamış anahtar; gerçek ödeme değil. [Makine çıktısı](mcp-artifact/verification.json). |
| Resmî MCP Registry kaydı yoktu | npm sonrası çalışan OIDC yayın işi ve yalnızca Registry için tekrar çalıştırılabilen ayrı iş eklendi. Kamuya açık paket ve tam aktif kayıt doğrulanır. | 22 çevrimdışı API akış testi. Gerçek dizin kabulü yayın aşamasına bağlıdır. [Registry kaydı](mcp-registry-remediation.md). |
| MCP adres/uyarı şemaları hatalı girdiyi erken durdurmuyordu | Beş adres şemasına tam 20 byte adres koşulu; pozitif referans fiyatı ve negatif olmayan eşik. | Geçersiz girdi HTTP çağrısından önce reddediliyor. |
| Ödeme retlerinin hangi aşamada olduğu bilinmiyordu | Protokol/başlık nesli, parse/match/verify/handler/settle aşaması, sınırlı neden kodları, facilitator çağrı ve süreleri, güvenli istemci sürümü eklendi. | Gerçek Express/x402 middleware ile sahte facilitator senaryoları. [Alanlar ve testler](payment-diagnostics.md). |
| Bağlantısı erken kapanan istekler görünmüyordu | Tam olarak bir finish veya abort kaydı; yerel 499 işareti, iptal nedeni, teslimat ile settlement ayrımı. | İptal yarışları, geç cevaplar, bilinmeyen settlement ve tekrar etmeme davranışı test edildi. |
| Başarılı ödeme ile zincir kimliği ilişkilendirilemiyordu | Yalnızca başarılı doğrulamadan gelen biçimi kontrol edilmiş açık payer adresi ve başarılı settlement işlem hash'i kaydedilir. | İstemcinin doğrulanmamış iddiaları, imza, yetkilendirme verisi ve anahtarlar kaydedilmez. Geçmiş kayıp kayıtları geri getirmez. |
| SDK tanılama mesajı keyfi sağlayıcı içeriğini loglayabiliyordu | Yalnızca ödeme bağlamındaki belirli x402 extension-response mesajı bastırıldı; diğer loglar korundu. | Kurulu gerçek SDK üzerinden hassas alan içeren başlık regresyonu. SDK yükseltmelerinde tekrar incelenecek. |
| Eski X-PAYMENT/v1 istemcileri açık yönlendirme almıyordu | PAYMENT_UPGRADE_REQUIRED ve v2 geçiş açıklaması; bozuk ödeme için MALFORMED_PAYMENT. | Bu retler facilitator'a veya tahsilata ulaşmaz. Geçerli v2 akışı korunur. |
| İlk sayfa açılışında Pay düğmesi erkenden görünüyordu | hidden niteliğini geçersiz kılan CSS düzeltildi; teklif koşulu cüzdan kitaplığı yüklenmeden önce kontrol edilir. | 1280 px masaüstü ve 390 px mobil; teklif öncesi gizli, gerçek imzasız teklif sonrası görünür. [Tarayıcı ve işletim kaydı](site-operations.md). |
| Scorecard sağlayıcı token indeksi birçok bilinen havuzu atlıyordu | Snapshot'ta zaten bilinen Base havuzları için kimlik/token ilişkisi doğrulanan, en çok dört paralel istekle sınırlı bağımsız fiyat/likidite kaynağı eklendi. | Aynı 26 token: önce 5 fiyatlı / 21 belirsiz; sonra 11 fiyatlı / 15 gözlenen düşük likidite / 0 belirsiz. Düşük likidite satırlarına hayalî getiri yazılmadı. [Önce/sonra](data-quality-report.md). |
| Safety aynı başarısız explorer'ı tekrar bekliyor, eksik RPC kapsamını tam gösterebiliyordu | Gereksiz ikinci explorer denemesi kaldırıldı; eksik fallback alanları açık partial olarak işaretlendi. | USDC hâlâ 5/8 kontrol ve caution; dış kaynakların vermediği kontroller başarılı sayılmıyor. |
| Basename ağ çalışması sayaç ve iptal kapsamı dışındaydı | Gerçek RPC denemeleri sayılır ve çağıranın iptali alttaki isteğe taşınır. | Önce başarısız olan sayaç/iptal regresyonları düzeltme sonrası geçti. |
| Başarılı cron sonucu veri tazeliği sanılabiliyordu | Gerçek snapshot zamanı/yaşı/gecikmesi, fiyat kapsamı ve safety kapsamını kontrol eden ödeme yapmayan ops:data ve saatlik host monitor hazırlandı. | 25 saniye veri bütçesi, bayat/gelecek/tutarsız kayıt reddi, atomic rapor, sağlayıcı hatalarını sızdırmama. Kurulum kanıtı yayın bölümüne eklenecek. |
| Kurulum, gizlilik ve veri iddiaları gerçek davranıştan sapmıştı | Website, llms.txt, README, Security, Operations, privacy ve terms güncellendi; opaque cursor, v2, Hetzner ve gerçek log alanları açıklandı. | Dış cüzdanın tekil müşteri olmadığı, partial verinin sınırları ve belirsiz settlement sonrası otomatik tekrar yapılmaması belirtildi. Docker log sınırı aktif container'da 3 × 10 MB olarak okundu. |

## Kontroller

- Başlangıç: 211/211 test. Son bütünleşik çalıştırma: **271/271**, sıfır hata/atlama; yaklaşık 29,5 saniye. [Tam çıktı](full-tests.log).
- API, web, MCP ve test tür kontrolleri başarılı. [Çıktı](full-typecheck.log).
- Üretilen metadata, 21 endpoint/fiyat eşlemesi ve tarayıcı bundle kontrolü; API/web ve MCP build başarılı.
- Deployment/controller/monitor Python paketi: **30/30**. [Çıktı](deployment-tests.log).
- API ve MCP bağımlılık denetimleri: **0 bilinen advisory** (çalıştırma anında). [API](dependency-api.json), [MCP](dependency-mcp.json).
- Kod yazmayan ayrı son incelemeci uygulama, gerçek paket ve monitor sınırlarını kontrol etti; bulduğu bozuk snapshot tokeni edge case'i düzeltildi ve yeniden test edildi. [Bağımsız inceleme](independent-review.md).
- Yerel tarayıcı ölçümü: 1280 ve 390 px'de belge genişliği viewport ile aynı; teklif öncesi düğme gizli, teklif sonrası görünür. Cüzdan bağlanmadı.
- Gerçek sağlayıcılardan salt okunur veri kontrolü: `ok:true`, `degraded:true`; 11 fiyatlı, 15 düşük likidite, 0 belirsiz; safety 5/8. [Ham rapor](live-data-monitor.json).

Bu sayılar birbiriyle örtüşen alt testlerin toplamı değildir. Canlı ödeme imzalanmadı, yeni ücretli görev eklenmedi ve gerçek settlement bu düzeltme çalışmasında sınanmadı.

## Yayın ve geri dönüş kimlikleri

| Yüzey | Kayıt |
|---|---|
| Kaynak başlangıcı | d7d03360514aaabd5b004698f926b7c29f0e1b0b |
| Önceki canlı kaynak | c83262b68141a1451ff1fd4ab884ac60c449decd |
| Önceki canlı container | agenttoll-r-20260912t223818z-c83262b68141 |
| Önceki release dizini | /opt/agenttoll/releases/20260912T223818Z-c83262b68141 |
| Önceki image digest | sha256:fe0634bc2017fd80666834a0100d7fd00ddd33cda86ee6e093e73f6937fc972f |
| Yeni npm/Registry | Yayın ve kamuya açık doğrulama bekleniyor |
| Yeni canlı kaynak | Başarılı main CI ve mevcut Hetzner denetleyicisi bekleniyor |
| Saatlik monitor | İncelenen dosyalar hazır; kurulum ve ilk gerçek servis sonucu bekleniyor |

Önce npm paketinin gerçekten erişilebilir olması doğrulanacak, sonra bu sürümü öneren site main üzerinden mevcut CI kapısından dağıtılacak. Fiyat, alıcı, ödeme ağı ve mevcut ücretli iş takvimleri değiştirilmedi. Önceki doğrulanmış uygulama sürümü denetleyicinin normal geri dönüş yolu için korunur.

## Kontrolümüz dışındaki ve tarihsel sınırlar

Bu düzeltmeler ilk kullanım ve teşhis eksiklerini kapatır; azalan cüzdanların nedenini geriye dönük kesinleştirmez. c9'un 13 Eylül sonrası yetersiz USDC bakiyesi istemci tarafında bir engeldir; 12 Eylül'deki ilk atlaması bununla açıklanamaz. 89c'nin bakiye varken AgentToll'i atlama nedeni eski istemci/facilitator kaydı olmadan belirsiz kalır. Bu cüzdanların yazılımını yeniden başlatamayız veya dönüşünü garanti edemeyiz.

Üçüncü taraf veri kapsamı, token likiditesi, GitHub cron gecikmesi ve kullanıcıların eski sabitlenmiş MCP süreçleri uygulama yayınıyla ortadan kalkmaz. Yeni monitor bu sınırları açıkça kaydeder. Bağımsız dizinlerin eski örneklerini kanonik belgelerimizde düzelttik; sahip olmadığımız sayfaların içeriği değişmiş gibi raporlanmadı. Karşı taraflara mesaj gönderilmedi.
