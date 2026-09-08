# AgentToll düzeltme raporu — 8 Eylül 2026

[İlk incelemedeki](PROJECT_REVIEW_2026-09-08.md) 12 hata ve ilgili somut bakım eksikleri giderildi. Değişiklikler `fix/audit-findings-20260908` dalındaki yerel çalışma ağacında. İlk inceleme kaydı ve önceden bulunan `brand-out/` içeriği korundu.

Son tam test çalışması Node **22.23.2** üzerinde **148 geçti, 0 başarısız, 0 atlandı** sonucunu verdi. API, web, MCP, örnekler ve testlerin tip kontrolleri; derlemeler; üretilen dosyaların tutarlılığı ve gerçek MCP paketinin çalıştırılması doğrulandı. Root ve MCP bağımlılık denetimlerinin ikisi de **0 güvenlik uyarısı** bildirdi.

## 12 bulgunun çözümü

| No | Düzeltme | Doğrulama |
| --- | --- | --- |
| 1 | Güvenlik sağlayıcılarının eksik, null, bozuk ve çelişkili verileri doğrulanıyor. Tamamlanmayan kontrol `pass` olmuyor; bilinen risk korunuyor. Her kontrolün eksikleri, kaynakları ve kapsamı görünür. | [safety.test.ts](tests/safety.test.ts): eksik fixture `insufficient-data`; tümü ölçülmüş temiz fixture `clear`; eksik alanlar yüksek riski gizlemiyor. |
| 2 | Ödeme istemcisi imzadan önce endpoint fiyat tavanını, ağı, USDC kontratını, alıcıyı, origin'i ve teklif süresini kontrol ediyor. Varsayılan oturum bütçesi 1 USDC; eşzamanlı çağrılarda atomik rezervasyon var. | [payment.test.ts](tests/payment.test.ts): 50 USDC teklif imzalanmıyor; iki eşzamanlı çağrı bütçeyi aşamıyor; belirsiz imzalı ödemelerin rezervasyonu tutuluyor. |
| 3 | Reverse Basename yalnız ileri çözümleme başlangıç adresiyle eşleşirse doğrulanmış isim olarak dönüyor. İleri/ters cache anahtarları ayrıldı; RPC denemeleri ve toplam süre sınırlı. | [basename.test.ts](tests/basename.test.ts): yanlış isim, farklı adres, bozuk cache kaydı ve yanıt vermeyen RPC senaryoları. |
| 4 | CORS artık x402 v2 imza, teklif ve makbuz başlıklarını destekliyor; eski başlıklar korunuyor. OPTIONS ve hata yanıtları da doğru başlıkları içeriyor. | [api.test.ts](tests/api.test.ts): farklı Origin ile preflight ve allow/expose başlıkları; 21 rotanın ödeme teklifleri. |
| 5 | Tarayıcı hata yolundaki kapsam dışı `wallet` kullanımı düzeltildi. Ağ gösterilen tekliften seçiliyor; kullanıcıya gösterilen ödeme koşulları imza anında yeniden doğrulanıyor. Özel kurulumun alıcısı agent card üzerinden aktarılıyor. | [browser-payment.test.ts](tests/browser-payment.test.ts), [public-app.test.ts](tests/public-app.test.ts): iptal, ağ değişimi, hatalı teklif, bakiye/facilitator hatası ve özel alıcı; web tip kontrolü ve bundle eşleşmesi. |
| 6 | Wallet watch, adresle ilişkili devam imleciyle sayfaları tüketiyor; okunmamış sayfaların ötesine atlamıyor. Örtüşme, tekilleştirme ve açık `hasMore`/`partial`/`coverage` bilgisi eklendi. | [watch.test.ts](tests/watch.test.ts): 51 işlem kayıpsız teslim ediliyor; gerçek biçimdeki üç Blockscout sayfası 101 işlemi tamamlıyor; gecikmeli ve yinelenen kayıtlar ele alınıyor. |
| 7 | Çift sayıda gözlemde medyan ortadaki iki ham değerin ortalaması; yuvarlama toplulaştırma sonrasında yapılıyor. Eksik fiyat, eksik snapshot ve gözlenen düşük likidite birbirinden ayrılıyor. | [history.test.ts](tests/history.test.ts): `[0, 100] → 50`; boş/tek/tek sayılı gruplar, yuvarlama sınırı ve veri yokluğu. |
| 8 | Binance `USDCUSDT` yedeğinde USDT fiyatı ve 24 saatlik değişim ters oranla hesaplanıyor. Geçersiz fiyat reddediliyor; kotasyon para birimi ve dolar paritesi varsayımı açıklanıyor. | [prices.test.ts](tests/prices.test.ts): `1.1 → 0.9090909…`; fiyat alarmı kaynak ve kur varsayımını koruyor. |
| 9 | İstatistik baseline'ı ve cache ağ/alıcı ile eşleştiriliyor. Başka kuruluma ait geçmiş kullanılmıyor; snapshot betiği mainnet ağını açıkça geçiriyor. | [stats.test.ts](tests/stats.test.ts): özel alıcı 0, uyumlu geçmiş 7; testnet ayrımı ve yabancı baseline için gereksiz RPC yapılmaması. |
| 10 | Aynı cache anahtarındaki devam eden yüklemeler paylaşılıyor. Hatalı/iptal edilmiş yükleme başarı olarak cache'e yazılmıyor; bir istemcinin iptali bağımsız bekleyeni bozmuyor. Gas için kısa cache eklendi. | [cache.test.ts](tests/cache.test.ts): 10 eşzamanlı istek → 1 yükleme; [gas.test.ts](tests/gas.test.ts): 10 istek → aynı gas/blok gözlemi için toplam 2 RPC çağrısı. |
| 11 | Limiter ve günlüklerde rota normalizasyonu ortak. Yerelde proxy güveni varsayılan olarak kapalı; dağıtım için sınırlandırılabiliyor. Dolu limiter eski aktif kayıtları silerek kotayı sıfırlamıyor. | [api.test.ts](tests/api.test.ts): büyük/küçük harf, sondaki slash ve sahte forwarded IP ile limit aşılamıyor; [config.test.ts](tests/config.test.ts). |
| 12 | İki lockfile güncellendi; Coinbase SDK'nın etkilenen axios sürümü override ile düzeltildi. Kullanılmayan root bağımlılıkları ayrıldı; `esbuild` doğrudan geliştirme bağımlılığı oldu. Güvenlik belgesi ve CI güncellendi. | Root ve MCP için tam ve üretim bağımlılık denetimleri: 0 uyarı; ödeme regresyonları, derlemeler ve paket kontrolü başarılı. |

## Tamamlanan bakım ve ürün iyileştirmeleri

- **Tek endpoint kaydı:** [src/endpoints.ts](src/endpoints.ts) fiyat, rota ve keşif tanımlarının kaynağı. API ödeme kapısı, katalog, istemci tavanları ve OpenAPI buradan besleniyor. Tutarlılık kontrolü yalnız sayıları değil, 21 rota/fiyat/MCP aracı eşleşmesini denetliyor.
- **MCP kullanımı:** 21 ücretli araca ücretsiz `get_payment_budget` ve `get_payment_quote` eklendi. Anahtar olmadan teklif modu açılıyor; paket ve handshake sürümü birlikte `0.13.0`. İptal sinyali gerçek MCP callback'inden ödeme HTTP isteğine taşınıyor.
- **Başlangıç doğrulaması:** Alıcı adresi, ödeme ağı, URL, port, proxy ve süre sınırları başlangıçta doğrulanıyor. Varsayılan mainnet facilitator'ı için eksik CDP kimlik bilgileri erken hata veriyor. Piyasa/zincir verisi Base mainnet'te kalırken ödeme ağı ayrıca belirtiliyor.
- **Parametreler:** `fundedOnly` yalnız belirlenmiş true/false değerlerini kabul ediyor; rastgele değerler 400 dönüyor.
- **Hata ve süre sözleşmesi:** Hatalarda `code`, `retryable`, `retryAfter`, `requestId` alanları var. Toplam süre doğrulama, veri yükleme ve tahsilatı kapsıyor. Upstream tanılama metni dışarı sızdırılmıyor. Doğrulanmış ödeme reddi 402 olarak kalıyor; tahsilat sonucu belirsizse otomatik yeniden deneme önerilmiyor.
- **Hazırlık ve gözlem:** `/api/health` süreç canlılığını, yeni `/api/ready` facilitator ve Base RPC hazırlığını bildiriyor. Yanıtlara zaman/ağ bilgileri; günlüklere istek süresi, ödeme aşaması, upstream çağrı ve cache sayaçları eklendi. Bilinmeyen gözlem zamanı null kalıyor.
- **Geçmişin kökeni:** History index'i ve snapshot'lar aynı doğrulanmış git commit SHA'sına sabitleniyor. Kapsanan/verisi eksik snapshot ve token sayıları gösteriliyor. Ödeme işleminin tek başına yanıt içeriğini doğrulamadığı açıkça belirtiliyor.
- **Kurulum ve yayın kontrolleri:** README, SECURITY, `.env.example`, MCP belgeleri, örnek istemciler ve demo metinleri güncellendi. CI API/web/MCP/test tip kontrollerini, regresyonları, üretilen dosyaları, derlemeleri, paket açılışını ve bağımlılık denetimlerini çalıştırıyor. MCP yayınında etiket/sürüm eşleşmesi de zorunlu.

## Bağımsız incelemede bulunan ek durumlar

Uygulamayı yazmayan ayrı inceleyicinin bulguları da düzeltildi ve regresyonlara eklendi:

- Tam olduğu iddia edilen holder/LP listesinin toplam payının tutarsız olması; payları erken yuvarlamanın yanlış eksiklik üretmesi.
- Büyük/küçük harf dönüşümüyle ileri/ters Basename cache anahtarlarının çakışması ve eksik kimlik kanıtının enrichment'te kabul edilmesi.
- Blockscout devam yanıtındaki ek alanların geçerli sayfalamayı engellemesi; üç sayfalık gerçek biçimin işlenmesi.
- Scorecard medyanında gözlem başına erken yuvarlama; iptal edilen snapshot isteğinin eksik sonuç olarak uzun süre cache'e alınması.
- MCP çağrısı iptal edildikten sonra geç gelen teklifin imzalanabilmesi; imza sonrası iptalde rezervasyonun korunması.
- Özel barındırmada demo alıcısının yanlış varsayılması ve facilitator URL'sinin sondaki slash nedeniyle yanlış seçilmesi.
- SDK'nın ayrı timeout'larının toplam ödeme süresini sınırlamaması; bozuk facilitator yanıtında iç tanılama metninin dönmesi; geçerli HTTP 400 ödeme reddinin yanlışlıkla 502 olması.

Son ödeme regresyonu gerçek x402 middleware'i üzerinden normal tahsilatı, hatalı girdide tahsilata geçilmemesini, bozuk yanıtları, doğrulama/tahsilat retlerini ve toplam süre sonunda belirsiz ödeme durumunu test ediyor. Dış ödeme ve RPC yanıtları taklit ediliyor.

**Bağımsız son inceleme: kabul.** İnceleyici açık kalan önemli hata bulmadı; kendi çalıştırdığı `npm test` **148/148**, ödeme yaşam döngüsü **9/9**, tüm tip kontrolleri ve `check:generated` başarılı. Derleme ve tarball smoke kanıtı entegrasyon çalıştırmasına ait.

## Doğrulama kaydı

| Komut / kontrol | Sonuç |
| --- | --- |
| `npx --yes --package=node@22 node scripts/test.mjs` | Node 22.23.2; **148/148 geçti**, yaklaşık 12.9 saniye |
| `node --import tsx --test tests/api-payment.test.ts` | Son facilitator düzeltmesinden sonra Node 24.13.0 üzerinde **9/9 geçti** |
| `npm run typecheck` | API, web, MCP, örnekler ve testler geçti |
| `npm run build` | API ve web derlendi; paylaşılan tanımlar eşleşti |
| `npm run build --prefix mcp` | MCP derlendi |
| `npm run check:generated` | 21 endpoint eşleşmesi, OpenAPI, MCP sürümü/paylaşılan politika ve tarayıcı bundle'ı güncel |
| `npm run smoke:mcp` | Gerçek `npm pack` çıktısı açılıp çalıştırıldı; 0.13.0 handshake, 23 araç ve anahtarsız bütçe sorgusu geçti |
| `npm audit --json` / `npm audit --prefix mcp --json` | Her iki tam bağımlılık ağacında 0 uyarı |
| Root ve MCP `npm audit --omit=dev` | Her iki üretim ağacında 0 uyarı |
| `git -c core.safecrlf=false diff --check` | Boşluk/patch hatası yok |

Testler geçici anahtarlar ve taklit dış HTTP/RPC/tahsilat sınırları kullanıyor. Gerçek ödeme yapılmadı. CORS HTTP entegrasyonu ve tarayıcı kodunun taklit wallet/DOM senaryoları doğrulandı; gerçek cüzdan eklentisiyle tarayıcı uçtan uca testi veya canlı üretim tahsilatı çalıştırılmadı. CI dosyaları yerelde hazırlandı; uzak GitHub Actions çalıştırması iddia edilmiyor.

## Uyumluluk ve kalan sınırlar

- Wallet watch'ın döndürdüğü opak imleç değiştirilmeden geri gönderilmeli. İlk ISO zamanı hâlâ kabul ediliyor. Tüketiciler `hasMore` bitene kadar devam etmeli; 120 saniye/100 hash örtüşmesi tüm indexer gecikmelerini veya eski reorg'ları kapsamaz. Radar izleme kapsamı açıkça kısmi.
- Özel origin kullanan ödeme istemcilerinde güvenilen alıcı açıkça verilmeli. Varsayılan 1 USDC bütçe istemci örneğine ait; süreçler veya yeniden başlatmalar arasında ortak, kalıcı cüzdan limiti değildir. İmzalanmış yetki istemciyi kapatmakla iptal olmaz.
- Güvenlik ve scorecard yanıtlarında bilinmeyen bazı değerler artık null. `unchecked` ile tespit edilmiş riskler birlikte bulunabilir. Tüketiciler eksikliği riskin yokluğu olarak yorumlamamalı.
- Rate limit ve cache instance içi. Ortak depolama, çoklu instance kotası veya bir metrik panosu bu değişikliğe eklenmedi. Mevcut gözlem alanları bunların daha sonra kurulmasına veri sağlar.
- Scorecard hâlâ yayımlanmış seçili snapshot'ları bugünkü fiyatla karşılaştırıyor; bekleme süreleri değişken. +24/+72 saatlik yeni veri toplama hattı, ayrı Python/TypeScript SDK ürünü ve yeni fresh tabanlı araştırma akışı ilk rapordaki daha geniş ürün fikirleri olarak kaldı. Bütçeli MCP, teklif modu, açıklanabilir kontrol kapsamı ve tek endpoint kaydı bu çalışmada uygulandı.
- Commit SHA geçmiş okumayı sabitler; ayrıca imzalı içerik makbuzu üretilmiyor. Dış kaynakların doğruluğu, erişilebilirliği veya herhangi bir tokenın güvenliği bu testlerle garanti edilmiyor.

Değişiklikler yerelde bırakıldı; commit, push, paket yayını ve dağıtım yapılmadı. Üretimde etkin olmaları için ayrıca yayınlanmaları gerekir.
