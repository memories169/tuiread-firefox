# TuiRead

Extension Chrome / Edge (Manifest V3) đọc raw truyện tiếng Trung và hiện bản convert tiếng Việt
ngay trên trang truyện, theo từ điển VietPhrase. Mọi thứ chạy **hoàn toàn local** trong trình duyệt
của bạn: không server trung gian, không gửi nội dung trang ra ngoài.

- Dịch tại chỗ trên `uukanshu.cc`, `piaotia.com` và **site bạn tự thêm** lúc đang chạy.
- Hai kiểu hiển thị: chỉ tiếng Việt, hoặc tiếng Việt + gốc Hán bên dưới.
- Bấm vào một cụm đã dịch để **sửa nghĩa** ngay trên trang; bản vá áp dụng cho mọi lần đọc sau.
- "Từ điển của tôi": sửa trực tiếp, nhập / xuất file `.txt`, hoặc **tải từ URL** (ví dụ file raw trên
  GitHub của bạn) để đồng bộ bản vá cá nhân hóa giữa các máy.
- Từ điển đầy đủ (~1 triệu mục) nạp một lần cho cả trình duyệt, chương đã đọc được cache lại.

---

## Cài đặt

Yêu cầu: Chrome hoặc Edge bản hỗ trợ Manifest V3 (Chrome/Edge 109 trở lên). Không cần Node,
không cần `npm install` — extension là JavaScript thuần; `npm` chỉ dành cho bộ kiểm thử của dev.

1. Tải mã nguồn về máy: `git clone <url-repo-này>` hoặc bấm **Code → Download ZIP** rồi giải nén.
2. Mở trang quản lý extension: `chrome://extensions` (Chrome) hoặc `edge://extensions` (Edge).
3. Bật **Developer mode** (Công cụ dành cho nhà phát triển) ở góc trang.
4. Bấm **Load unpacked** (Tải tiện ích đã giải nén) → chọn thư mục `vietphrase-reader/`
   (thư mục chứa `manifest.json`).
5. Ghim icon TuiRead lên thanh công cụ nếu muốn bấm nhanh popup.

Lưu ý khi cài:

- **Giữ nguyên đường dẫn thư mục** sau khi cài. ID của extension unpacked tính từ đường dẫn tuyệt
  đối; đổi tên / dời thư mục là trình duyệt coi như extension mới và mất settings, bản vá, cache.
  Muốn dời thư mục: xuất bản vá ra file `.txt` trước (Options → Xuất file), rồi nhập lại sau.
- Cập nhật bản mới: giải nén / pull đè lên thư mục cũ rồi bấm **Reload** ở trang extensions.
- Lần đầu mở trang truyện, engine nạp từ điển khoảng 4 giây; các lần sau nhanh hơn nhờ cache.

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

- **Popup báo "Engine chưa sẵn sàng"**: bấm **Nạp lại từ điển**; nếu vẫn vậy, Reload extension ở
  trang extensions rồi tải lại trang truyện.
- **Site mới không dịch**: đã bấm Thêm và chấp nhận quyền chưa? Nếu có chữ Hán còn sót trong thân
  truyện, dán selector đúng cho miền đó ở mục Selector.
- **Đổi thư mục / cài lại máy và mất bản vá**: nhập lại file `.txt` đã xuất, hoặc dán URL GitHub
  của bạn vào ô tải từ URL.
- **uukanshu.cc hiện trang xác minh Cloudflare**: đó là chặn của site với trình duyệt lạ, không phải
  lỗi extension — mở bằng cửa sổ trình duyệt thường bạn vẫn đọc được.

