# AgentToll — 14 Eylül 2026 düzeltme ve yayın kaydı

Bu çalışma, aynı günkü ayrıntılı incelemede doğrulanan AgentToll kaynaklı eksikleri kapatır. Kullanıcının düzeltme talimatı üzerine uygulama, MCP dağıtımı, ilk kullanım, veri kalitesi ve işletim kontrolleri birlikte ele alındı. İlk incelemenin cüzdan ve ham günlük kanıtları mevcut çalışma alanındaki `docs/audit/2026-09-14/` altında korunuyor.

**Sonuç:** doğrulanan AgentToll kaynaklı eksikler giderildi ve canlıya alındı. MCP **0.14.0** npm ve resmî Registry'de yayımlandı; kamuya açık paket bağımsız kurulumla doğrulandı. Site/API yeni sürümde, saatlik izleyici aktif. **284 yazılım testi, 30 deployment testi ve 49 canlı API/proxy kontrolü başarılı.** Dış sağlayıcılardaki eksik veriler ve geçmiş cüzdan atlamalarının kesinleşmeyen nedenleri aşağıda açık bırakıldı.

## Kapatılan uygulama eksikleri

| Bulgu | Yapılan düzeltme | Doğrulama / sınır |
|---|---|---|
| npm 0.13.0 ile güncel kaynak ve kurulum belgeleri ayrışmıştı | Yeni 0.14.0; package, lock, Registry metadata ve handshake sürümü eşitlendi. Kurulum örnekleri sürüme sabitlendi; eski istemci için yükseltme ve yeniden başlatma açıklandı. | Anahtarsız gerçek stdio süreci, 23 araç, teklif ve bütçe araçları. [Paket kanıtı](mcp-remediation.md). |
| Paket testi depo bağımlılıklarını kullanıyor, yayımlanacak paketi bağımsız sınamıyordu | Tarball ayrı geçici projeye taze bağımlılıklarla kurulur. CI aynı doğrulanmış dosyayı yayımlar; kamuya açık npm sürümünü tekrar indirip SHA-512 ve davranışı karşılaştırır. | Yedi gerçek süreç senaryosu; sıfır bütçe, yanlış alıcı, 100 kat fiyat, timeout ve iptalde sıfır imzalı tekrar. Ağ engelli, geçici fonlanmamış anahtar; gerçek ödeme değil. [Makine çıktısı](mcp-artifact/verification.json). |
| Resmî MCP Registry kaydı yoktu | npm sonrası çalışan OIDC yayın işi ve yalnızca Registry için tekrar çalıştırılabilen ayrı iş eklendi. Kamuya açık paket ve tam aktif kayıt doğrulanır. | 22 çevrimdışı API akış testi; gerçek OIDC yayını başarılı, kayıt active/isLatest. [Canlı kayıt](public-mcp-registry.json). |
| Eski paket kurulumları bilinen hataya ilişkin uyarı almıyordu | Yalnızca doğrudan incelenen 0.13.0 sürümüne 0.14.0'a yükseltme ve yeniden başlatma uyarısı eklendi. | Uyarıdan önce yeni paketin gerçek kurulumu ve CI hash'i tekrar doğrulandı. Paket silinmedi, sürüm yeniden yayımlanmadı. [Kamuya açık uyarı](public-legacy-warning.json). |
| MCP adres/uyarı şemaları hatalı girdiyi erken durdurmuyordu | Beş adres şemasına tam 20 byte adres koşulu; pozitif referans fiyatı ve negatif olmayan eşik. | Geçersiz girdi HTTP çağrısından önce reddediliyor. |
| Ödeme retlerinin hangi aşamada olduğu bilinmiyordu | Protokol/başlık nesli, parse/match/verify/handler/settle aşaması, sınırlı neden kodları, facilitator çağrı ve süreleri, güvenli istemci sürümü eklendi. | Gerçek Express/x402 middleware ile sahte facilitator senaryoları. [Alanlar ve testler](payment-diagnostics.md). |
| Bağlantısı erken kapanan istekler görünmüyordu | Tam olarak bir finish veya abort kaydı; yerel 499 işareti, iptal nedeni, teslimat ile settlement ayrımı. | İptal yarışları, geç cevaplar, bilinmeyen settlement ve tekrar etmeme davranışı test edildi. |
| Başarılı ödeme ile zincir kimliği ilişkilendirilemiyordu | Yalnızca başarılı doğrulamadan gelen biçimi kontrol edilmiş açık payer adresi ve başarılı settlement işlem hash'i kaydedilir. | İstemcinin doğrulanmamış iddiaları, imza, yetkilendirme verisi ve anahtarlar kaydedilmez. Geçmiş kayıp kayıtları geri getirmez. |
| SDK tanılama mesajı keyfi sağlayıcı içeriğini loglayabiliyordu | Yalnızca ödeme bağlamındaki belirli x402 extension-response mesajı bastırıldı; diğer loglar korundu. | Kurulu gerçek SDK üzerinden hassas alan içeren başlık regresyonu. SDK yükseltmelerinde tekrar incelenecek. |
| Eski X-PAYMENT/v1 istemcileri açık yönlendirme almıyordu | PAYMENT_UPGRADE_REQUIRED ve v2 geçiş açıklaması; bozuk ödeme için MALFORMED_PAYMENT. | Bu retler facilitator'a veya tahsilata ulaşmaz. Geçerli v2 akışı korunur. |
| İlk sayfa açılışında Pay düğmesi erkenden görünüyordu | hidden niteliğini geçersiz kılan CSS düzeltildi; teklif koşulu cüzdan kitaplığı yüklenmeden önce kontrol edilir. | 1280 px masaüstü ve 390 px mobil; teklif öncesi gizli, gerçek imzasız teklif sonrası görünür. [Tarayıcı ve işletim kaydı](site-operations.md). |
| Scorecard sağlayıcı token indeksi birçok bilinen havuzu atlıyordu | Snapshot'ta zaten bilinen Base havuzları için kimlik/token ilişkisi doğrulanan, en çok dört paralel istekle sınırlı bağımsız fiyat/likidite kaynağı eklendi. | Aynı 26 token: önce 5 fiyatlı / 21 belirsiz; sonra 11 fiyatlı / 15 gözlenen düşük likidite / 0 belirsiz. Düşük likidite satırlarına hayalî getiri yazılmadı. [Önce/sonra](data-quality-report.md). |
| Safety aynı başarısız explorer'ı tekrar bekliyor, eksik RPC kapsamını tam gösterebiliyordu | Gereksiz ikinci explorer denemesi kaldırıldı; eksik fallback alanları açık partial olarak işaretlendi. | Yerel ilk örnek 5/8, canlı host kontrolü 6/8 ve caution. Ortam/zaman farkı nedeniyle bu farkı kodun etkisi saymıyoruz; verilmeyen kontroller başarılı sayılmıyor. |
| Basename ağ çalışması sayaç ve iptal kapsamı dışındaydı | Gerçek RPC denemeleri sayılır ve çağıranın iptali alttaki isteğe taşınır. | Önce başarısız olan sayaç/iptal regresyonları düzeltme sonrası geçti. |
| Başarılı cron sonucu veri tazeliği sanılabiliyordu | Gerçek snapshot zamanı/yaşı/gecikmesi, fiyat kapsamı ve safety kapsamını kontrol eden ödeme yapmayan ops:data ve saatlik host monitor kuruldu. | 25 saniye veri bütçesi, bayat/gelecek/tutarsız kayıt reddi, atomic rapor, sağlayıcı hatalarını sızdırmama. Gerçek systemd çalıştırması başarılı. [Canlı rapor](monitor-latest.json). |
| Kurulum, gizlilik ve veri iddiaları gerçek davranıştan sapmıştı | Website, llms.txt, README, Security, Operations, privacy ve terms güncellendi; opaque cursor, v2, Hetzner ve gerçek log alanları açıklandı. | Dış cüzdanın tekil müşteri olmadığı, partial verinin sınırları ve belirsiz settlement sonrası otomatik tekrar yapılmaması belirtildi. Docker log sınırı aktif container'da 3 × 10 MB olarak okundu. |

## Kontroller

- Başlangıç: 211/211 test. Son bütünleşik çalıştırma: **284/284**, sıfır hata/atlama; yaklaşık 27,8 saniye. [Tam çıktı](full-tests.log).
- API, web, MCP ve test tür kontrolleri başarılı. [Çıktı](full-typecheck.log).
- Üretilen metadata, 21 endpoint/fiyat eşlemesi ve tarayıcı bundle kontrolü; API/web ve MCP build başarılı.
- Deployment/controller/monitor Python paketi: **30/30**. [Çıktı](deployment-tests.log).
- API ve MCP bağımlılık denetimleri: **0 bilinen advisory** (çalıştırma anında). [API](dependency-api.json), [MCP](dependency-mcp.json).
- Kod yazmayan ayrı son incelemeci uygulama, gerçek paket ve monitor sınırlarını kontrol etti; bulduğu bozuk snapshot tokeni edge case'i düzeltildi ve yeniden test edildi. [Bağımsız inceleme](independent-review.md).
- Yerel ve kanonik canlı tarayıcı ölçümü: 1280 ve 390 px'de belge genişliği viewport ile aynı; yeni belge yüklenince düğme gizli, imzasız teklif sonrası görünür. Canlı teklif 0.004 USDC, Base mainnet ve doğru alıcı. Cüzdan bağlanmadı. [Tarayıcı kanıtı](browser-verification.json), [masaüstü](browser/live-desktop.png), [mobil](browser/live-mobile.png).
- Gerçek sağlayıcılardan salt okunur veri kontrolü: `ok:true`, `degraded:true`; 11 fiyatlı, 15 düşük likidite, 0 belirsiz; safety 5/8. [Ham rapor](live-data-monitor.json).
- Canlı API/teklif **24/24**, TLS/static/proxy **25/25**. Bunlar settlement testi değildir. [API](live-api.json), [proxy](live-proxy.json).
- Canlı legacy ve bozuk ödeme isteği beklenen 402/koduyla döndü. İki requestId'nin gerçek container kayıtları schemaVersion 2, parse aşaması, doğru neden, tek finish ve sıfır verify/settle çağrısı gösteriyor; payload/payer/receipt kaydı yok. İstemci etiketi bu iki denemede bilinçli sentetik metadata'dır. [Yanıtlar](live-diagnostic-probes.json), [günlükler](live-diagnostic-logs.json).

Bu sayılar birbiriyle örtüşen alt testlerin toplamı değildir. Canlı ödeme imzalanmadı, yeni ücretli görev eklenmedi ve gerçek settlement bu düzeltme çalışmasında sınanmadı.

## Yayın ve geri dönüş kimlikleri

| Yüzey | Kayıt |
|---|---|
| Kaynak başlangıcı | d7d03360514aaabd5b004698f926b7c29f0e1b0b |
| Önceki canlı kaynak | c83262b68141a1451ff1fd4ab884ac60c449decd |
| Önceki canlı container | agenttoll-r-20260912t223818z-c83262b68141 |
| Önceki release dizini | /opt/agenttoll/releases/20260912T223818Z-c83262b68141 |
| Önceki image digest | sha256:fe0634bc2017fd80666834a0100d7fd00ddd33cda86ee6e093e73f6937fc972f |
| Yeni npm | agenttoll-mcp@0.14.0; mcp-v0.14.0 etiketi, kaynak 68e19a53019339f6eb95e40de67f6d1149a02399; yayın 16:45:44 UTC, kamuya açık tüketici doğrulaması 16:49:53 UTC |
| Yayımlanan tarball | sha512-/O0JPa9AKEDGqj2gDc+RjvJviWPmriFKfWkq02lg8fycWcXqKRWV4dDRXOp0rPKUpQNBa2a2J6wHi/NIZ70dhA== |
| Resmî Registry | io.github.tevfikefeaydin/agenttoll, 0.14.0; active/isLatest, yayın 16:54:32 UTC |
| Yeni canlı kaynak | e28d8dc1983e0120890fc7bcb8b43b55920a5e6f; mevcut denetleyiciyle geçiş 16:56:26 UTC / 19:56:26 İstanbul |
| Yeni canlı container | agenttoll-r-20260914t165547z-e28d8dc1983e |
| Yeni image digest | sha256:4be352fad58c7a315bc4b1db53005025016105a5fd7630e1b5fb85e772d6af04 |
| Saatlik monitor | agenttoll-monitor.timer active; incelenen üç dosyanın hash'leri doğrulanarak kuruldu; başarılı gerçek servis sonucu 17:00:07 UTC |

Önce kamuya açık npm paketi doğrulandı, sonra site main üzerinden mevcut CI kapısından dağıtıldı. Fiyat, alıcı, ödeme ağı ve mevcut ücretli iş takvimleri korundu. [Önceki durum](release-before.json) ve [son durum](release-after.json) geri dönüş kimliklerini saklar; pending/cleanup/failed boş. Sonraki yalnızca doküman/yayın işi commit'leri uygulama girdilerini değiştirmediğinden canlı container'ın e28d8dc kalması beklenir. Kullanıcının asıl çalışma alanı fast-forward ile güncellendi; önceden değişmiş validation dosyası byte düzeyinde korundu, mevcut audit ve diğer yerel dosyalar bırakıldı.

Kanıtlı iş sonuçları: [ana sürüm CI](https://github.com/tevfikefeaydin/agenttoll/actions/runs/34871411023), [Registry yayını](https://github.com/tevfikefeaydin/agenttoll/actions/runs/34871447346), [eski paket uyarısı](https://github.com/tevfikefeaydin/agenttoll/actions/runs/34872171878), [uyarı/doküman commit'i CI](https://github.com/tevfikefeaydin/agenttoll/actions/runs/34872150934) başarılı.

## Yayında yakalanan iki durum

İlk npm işinde publish başarılı oldu; yaklaşık yarım saniye sonraki indirme kontrolü npm'in işleme gecikmesinde ETARGET döndürdü. Bu ilk iş **başarısız olarak kalır**; yeşile çevrilmiş gibi raporlanmadı. Paket tekrar yayımlanmadı. Saklanan CI arşivi indirildi, ZIP SHA-256 doğrulandı; kamuya açıldıktan sonra npm tarball SHA-512 birebir karşılaştırıldı ve yedi gerçek tüketici senaryosu geçti. Gelecek yayınlara beş dakika toplam / 15 saniye istek sınırıyla yalnızca 404 veya henüz görünmeyen sürümü bekleyen salt okunur kontrol eklendi; 13 yeni regresyon geçti. [Yayın/kurtarma kaydı](npm-publication.json), [CI paketi](ci-mcp-artifact/verification.json), [kamuya açık paket](published-mcp-artifact/verification.json). Yerelde daha önce oluşturulan arşivin hash'i farklıdır; yayın karşılaştırmasının referansı CI'nın gerçekten yayımladığı arşivdir.

İzleyicinin ilk gerçek çalıştırması API 24/24 sağlıklıyken ilk GitHub snapshot isteğinde sekiz saniyelik timeout kaydetti. Hata başarıya çevrilmedi; [ilk başarısız rapor](monitor-first-run.json) saklandı. Aynı kaynakla tekrar çalıştırma başarılı: snapshot 680 ms, scorecard 1.714 ms, 7/7 snapshot, 11 fiyatlı / 15 düşük likidite / 0 belirsiz; safety 6/8. Ayrı incelemeci aynı container'dan GitHub'a 200/299 ms, raw index'e 200/276 ms ve deployment içindeki history/scorecard'a başarılı yanıt aldı; rate limitte 55 istek vardı. Tek seferlik sağlayıcı gecikmesinden kalıcı uygulama hatası sonucu çıkarılmadı. [Başarılı rapor](monitor-latest.json), [izleyici kurulum bilgisi](monitor-installation.json).

Saatlik zamanlayıcı aktif; ilk kontrol elle aynı systemd servisi üzerinden yapıldı. Son gözlemde sonraki planlanan tetikleme 17:37:49 UTC idi; bu gelecekteki tetikleme gerçekleşmiş gibi sayılmadı. Kapsam kısmi olduğunda `degraded:true` korunur. Yeni imzalı ödeme, ücretli görev veya dışarıya mesaj eklenmedi.

## Kontrolümüz dışındaki ve tarihsel sınırlar

Bu düzeltmeler ilk kullanım ve teşhis eksiklerini kapatır; azalan cüzdanların nedenini geriye dönük kesinleştirmez. c9'un 13 Eylül sonrası yetersiz USDC bakiyesi istemci tarafında bir engeldir; 12 Eylül'deki ilk atlaması bununla açıklanamaz. 89c'nin bakiye varken AgentToll'i atlama nedeni eski istemci/facilitator kaydı olmadan belirsiz kalır. Bu cüzdanların yazılımını yeniden başlatamayız veya dönüşünü garanti edemeyiz.

Üçüncü taraf veri kapsamı, token likiditesi, GitHub cron gecikmesi ve kullanıcıların eski sabitlenmiş MCP süreçleri uygulama yayınıyla ortadan kalkmaz. Yeni monitor bu sınırları açıkça kaydeder. Bağımsız dizinlerin eski örneklerini kanonik belgelerimizde düzelttik; sahip olmadığımız sayfaların içeriği değişmiş gibi raporlanmadı. Karşı taraflara mesaj gönderilmedi.
