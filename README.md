# TuiRead — bản port Firefox

Extension **Firefox / Firefox for Android** (Manifest V3) đọc raw truyện tiếng Trung và hiện bản
convert tiếng Việt ngay trên trang truyện, theo từ điển VietPhrase. Mọi thứ chạy **hoàn toàn local**
trong trình duyệt của bạn: không server trung gian, không gửi nội dung trang ra ngoài.

Repo này là fork của [ppptran/tuiread](https://github.com/ppptran/tuiread) (bản Chrome/Edge), port
sang Firefox với thay đổi kiến trúc tối thiểu — cùng bộ engine, từ điển, popup, options, tests.

- Dịch tại chỗ trên `uukanshu.cc`, `piaotia.com` và **site bạn tự thêm** lúc đang chạy.
- Hai kiểu hiển thị: chỉ tiếng Việt, hoặc tiếng Việt + gốc Hán bên dưới.
- Bấm vào một cụm đã dịch để **sửa nghĩa** ngay trên trang; bản vá áp dụng cho mọi lần đọc sau.
- "Từ điển của tôi": sửa trực tiếp, nhập / xuất file `.txt`, hoặc **tải từ URL** để đồng bộ bản vá.
- Từ điển đầy đủ (~1 triệu mục) nạp một lần cho cả trình duyệt, chương đã đọc được cache lại.

Yêu cầu: **Firefox 140+** trên máy tính, **Firefox for Android 142+** trên điện thoại
(`strict_min_version` trong manifest; Firefox 128 ESR đã hết hỗ trợ).

---

## So với bản Chrome, đã đổi gì

| | Chrome / Edge (gốc) | Firefox (repo này) |
|---|---|---|
| Background | `background.service_worker` | `background.scripts` — event page ([Firefox không hỗ trợ service worker](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)) |
| Engine sống ở đâu | `chrome.offscreen` document | **iframe ẩn chèn vào background page** — Firefox không có API `chrome.offscreen` |
| Giữ engine sống khi đọc trang | offscreen document luôn tồn tại | iframe view + port keep-alive `vp:keepalive` từ content script (event page không unload khi còn [message ports mở](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)) |
| Gọi API async | `await chrome.xxx(...)` (promise) | wrapper **callback** — namespace `chrome.*` của [Firefox hỗ trợ callback](https://extensionworkshop.com/documentation/develop/browser-compatibility/), callback là giao diện gốc của cả hai trình duyệt |
| Inject CSS/JS khi "Thêm site" | đường dẫn tương đối | đường dẫn **tuyệt đối** `/content.js`, `/styles/content.css` ([Firefox resolve theo trang, không theo extension](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities)) |
| Identity | không cần | `browser_specific_settings.gecko.id` + `strict_min_version` (bắt buộc cho AMO/Android) |

Manifest giờ khai **cả hai** `background.service_worker` (Chrome 121+ bỏ qua `scripts`) và
`background.scripts` (Firefox bỏ qua `service_worker`) — một gói chạy được trên cả hai.
Lưu ý `web-ext lint` báo `BACKGROUND_SERVICE_WORKER_IGNORED` + `UNSUPPORTED_API (offscreen.*)`
là **đúng dự kiến**: chúng là nhánh Chrome, được guard runtime (`hasOffscreen()`).

Khi không còn tab truyện nào mở, event page unload theo → engine giải phóng RAM; lần đọc sau
content script tự `vp:ensure` dựng lại engine (trả lời ngay nếu iframe đã có).

---

## Cài trên Firefox máy tính (PC)

### Cách 1 — Temporary (dev, biến mất khi khởi động lại Firefox)

1. Tải mã nguồn: `git clone https://github.com/memories169/tuiread-firefox.git` hoặc
   **Code → Download ZIP** rồi giải nén.
2. Mở `about:debugging` → **This Firefox** (Đây là Firefox).
3. **Load Temporary Add-on** (Tải tiện ích tạm thời) → chọn `manifest.json` trong thư mục vừa giải nén.

Extension chỉ sống tới lần khởi động lại Firefox — hợp cho dev/review. Muốn cài **vĩnh viễn** →

### Cách 2 — Cài `.xpi` đã ký (vĩnh viễn, dùng được mọi phiên bản)

Firefox **chỉ cho cài extension đã ký** (bản thường); chữ ký lấy miễn phí từ [AMO](https://addons.mozilla.org/developers/)
qua kênh **unlisted** (không hiện công khai, duyệt tự động trong vài phút — [chi tiết](https://extensionworkshop.com/documentation/publish/self-distribution/)):

```bash
# 1) Lấy API key: https://addons.mozilla.org/developers/addon/api/  (Key: Generate credentials)
export WEB_EXT_API_KEY="..."; export WEB_EXT_API_SECRET="..."

# 2) Ký (chạy trong thư mục repo; cài web-ext trước nếu chưa có)
npm i -g web-ext
web-ext sign --channel=unlisted
# -> web-ext-artifacts/tuiread-<ver>.xpi
```

Cài trên máy:

1. Lưu file `.xpi` vào máy.
2. Mở `about:addons` (Tiện ích và giao diện) → bánh răng **⚙** góc phải →
   **Install Add-on From File…** (Cài tiện ích từ tệp) → chọn file `.xpi` → **Add**.

([Nguồn chính thức](https://extensionworkshop.com/documentation/publish/install-self-distributed/))

> Chỉ dùng khi **tự phân phối riêng mình**. Muốn đăng công khai thì nộp **listed** trên AMO
> ([submitting-an-add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)),
> cần sửa lại manifest theo yêu cầu review.

### Cách 3 — Dev không cần chữ ký (Firefox Developer Edition / Nightly / ESR)

Firefox Developer Edition: `about:config` → `xpinstall.signatures.required` = `false` → cài `.xpi`
thường qua `about:addons`. Lưu ý: chỉ 3 phiên bản trên mới đổi được pref này, Firefox bản thường thì không
([Add-on signing in Firefox](https://support.mozilla.org/en-US/kb/add-on-signing-in-firefox)).

---

## Cài trên Firefox for Android

Firefox Android **không cài `.xpi` tùy ý**; extension phải **đã ký AMO** (giống Cách 2 ở trên) rồi cài từ tệp:

1. Ký `.xpi` như Cách 2, rồi đưa file vào điện thoại (kéo qua cáp USB / Drive / trình duyệt tải về —
   file tải về nằm ở `Downloads/`).
2. Mở **Firefox for Android** → **Settings** → **About Firefox**.
3. Bấm **logo Firefox 5 lần liên tiếp** — mở khóa menu ẩn.
4. Về **Settings** → **Install Extension from File…** (Cài tiện ích từ tệp).
5. Chọn file `.xpi` → khi được hỏi, bấm **Add**.

([Nguồn chính thức: Installing self-distributed extensions](https://extensionworkshop.com/documentation/publish/install-self-distributed/))

Lưu ý Android:

- **Firefox bản thường (release)** chỉ hiện danh sách extension đã chọn trên AMO; đường **cài từ file** ở
  trên là lối vào chính thức cho self-distribution.
- **Lưu ý riêng của bản port này (chưa test thật trên máy):** engine giữ ~150–300 MB heap khi đọc.
  Điện thoại yếu có thể bị Firefox kill tab/renderer giữa chừng — extension tự phục hồi (bấm
  "Nạp lại từ điển" ở popup / F5 trang), nhưng hãy coi mobile là **beta**.
- `about:debugging` không mở được trên Android. Muốn **dev** trực tiếp thì cắm USB,
  `web-ext run -t firefox-android --adb-device <id> --firefox-apk org.mozilla.fenix`
  (cần bật USB debugging + Settings Firefox → *Remote debugging via USB* —
  [hướng dẫn](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/)).

---

## Sử dụng

### Đọc truyện

Mở một chương truyện trên `uukanshu.cc` hoặc `piaotia.com` — thân truyện tự chuyển sang tiếng Việt.
Bấm icon TuiRead để mở popup:

| Nút / ô | Tác dụng |
|---|---|
| Công tắc bật / tắt | Bật tắt dịch riêng cho trang đang mở |
| Kiểu hiển thị | Chỉ tiếng Việt, hoặc Việt + Hán gốc bên dưới |
| Dịch lại trang | Áp dụng lại sau khi đổi tùy chọn / bản vá |
| Nạp lại từ điển | Ép engine đọc lại từ điển và bản vá |
| Tùy chọn | Mở trang cài đặt đầy đủ |

### Thêm site truyện khác

Popup → ô "thêm site" → gõ tên miền (ví dụ `truyenexample.com`) → **Thêm** → chấp nhận quyền
truy cập miền đó. Site mới tự chọn khối chứa nhiều chữ Hán nhất làm thân truyện; nếu chọn nhầm
khối, vào **Tùy chọn → Selector khu vực truyện theo trang** dán selector CSS đúng cho miền đó.

> Firefox ghi host permission dạng **optional** (`optional_host_permissions`): trang đã cấp ở popup
> lưu lại tới lần tắt Firefox, rồi Firefox hỏi lại ở lần sau — đó là hành vi chuẩn, không phải lỗi.

### Vá nghĩa sai

Cách nhanh: bấm vào cụm đã dịch trên trang → card hiện chữ Hán gốc → sửa nghĩa → **Lưu**.
Bản vá thắng mọi mục của từ điển gốc và áp dụng ở mọi trang. Mẹo: vá **cụm tên đầy đủ**
(`秦江=Tần Giang`), đừng vá một chữ (`江=Giang` sẽ hỏng cả 江南 / 长江).

Cách hàng loạt: **Tùy chọn → Từ điển của tôi** — ô văn bản tự lưu khi bạn ngừng gõ ~1 giây;
mỗi dòng một mục dạng `Hán=nghĩa`. Nút **Xuất file .txt** / **Nhập file .txt** để mang bản vá
sang máy khác hoặc cộng dồn vào từ điển riêng.

### Đồng bộ bản vá qua URL (GitHub cá nhân)

1. Xuất bản vá hiện tại ra file `.txt` (Options → Xuất file), hoặc tự soạn file cùng định dạng.
2. Đẩy file đó lên repo GitHub của bạn (repo private càng tốt), mở file bấm **Raw** rồi chép URL
   dạng `https://raw.githubusercontent.com/<bạn>/<repo>/<nhánh>/<file>.txt`.
3. Options → Từ điển của tôi → dán URL vào ô **Hoặc tải bản vá từ URL** → **Tải từ URL**.
4. Xong: bản vá được nạp và URL được nhớ cho lần sau; sửa file trên GitHub rồi bấm tải lại là đồng bộ.

Tải từ URL **thay toàn bộ** bản vá hiện tại (đúng ngữ nghĩa Nhập file). Chỉ đọc file (GET);
không gửi dữ liệu của bạn lên mạng. Server không mở CORS thì extension xin quyền riêng miền đó
một lần rồi tải lại; raw GitHub mở CORS sẵn nên không cần cấp gì thêm.

### Tùy chọn khác

- **Cách chọn nghĩa**: chỉ lấy nghĩa đầu trước dấu `/`, bỏ chữ thừa 的 / 了 / 着 / 著, bật rule
  số-giờ-ngày-đơn vị, bật nhận diện tên riêng.
- **Dịch cả menu / header / footer** của trang (thân truyện luôn được dịch trước).
- **Selector khu vực truyện** theo từng miền, như mục Thêm site ở trên.

## Sự cố hay gặp

- **Popup báo "Engine: engine page không trả lời"**: bấm **Nạp lại từ điển**; nếu vẫn vậy, tắt/bật
  extension ở `about:addons`, hoặc xem console thật: `about:debugging` → This Firefox → **Inspect**
  của TuiRead (in tab **Background** + tab **Engine**). Firefox không cho mở console iframe trực tiếp
  như `chrome://extensions` của Chrome.
- **Mới mở trang thấy chữ Hán vài giây rồi mới dịch**: lần đầu engine nạp từ điển (~2–5s);
  chương đã đọc thì hiện Việt ngay nhờ cache IndexedDB.
- **Site mới không dịch**: đã bấm Thêm và chấp nhận quyền chưa? Nếu có chữ Hán còn sót trong thân
  truyện, dán selector đúng cho miền đó ở mục Selector. Đã thêm mà chưa F5? — F5 một lần là chạy.
- **Đổi thư mục / cài lại máy và mất bản vá**: nhập lại file `.txt` đã xuất, hoặc dán URL GitHub
  của bạn vào ô tải từ URL.
- **uukanshu.cc hiện trang xác minh Cloudflare**: đó là chặn của site với trình duyệt lạ, không phải
  lỗi extension — mở bằng cửa sổ trình duyệt thường bạn vẫn đọc được.

## Dev: chạy test

```bash
npm install         # chỉ cài jsdom cho bộ test (extension là JS thuần, không build)
npm run check       # 171 kiểm tra: engine, golden, DOM, manifest, wiring, background/iframe
npm run offscreen   # integration background.js + engine.js trên message bus giả lập
npm run audit       # bảo mật: XSS sink, network, ReDoS rule, iframe engine nội bộ
npx web-ext lint    # lint theo addons-linter (0 error; warning dual-background là dự kiến)
```
