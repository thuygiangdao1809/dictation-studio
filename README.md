# Dictation Studio

Web app luyện nghe chép chính tả (dictation): phát audio, tự tách câu theo dấu `.` `!` `?`, chấm điểm theo từng câu, đánh dấu mốc bắt đầu/kết thúc cho từng câu, tùy chọn bản dịch tiếng Việt, và lưu lại toàn bộ tiến độ.

## Tính năng

- Thêm bài học (tên + transcript + audio + bản dịch tiếng Việt tùy chọn), hoặc thêm hàng loạt nhiều bài cùng lúc.
- Transcript và bản dịch nhập chung 1 ô, ngăn cách bằng dòng `---` (transcript ở trên, bản dịch ở dưới; nếu không có bản dịch chỉ cần bỏ qua phần `---`).
- Tự động tách câu trong transcript theo dấu `.` `!` `?` (không cần mỗi câu một dòng).
- Phát audio bằng Web Audio API (không dùng `<audio src>`) để tránh các giới hạn phát lại trên một số môi trường sandbox.
- Đánh dấu **điểm bắt đầu** và **điểm kết thúc** cho từng câu ngay trên thanh phát (hiển thị vạch màu trực quan), lưu lại cho các lần luyện sau.
- Phím tắt: `Shift` — nghe lại đúng đoạn đã đánh dấu của câu hiện tại; `Enter` — kiểm tra đáp án / chuyển câu tiếp.
- Khi chuyển sang câu tiếp theo, điểm audio đang dừng tự động trở thành mốc bắt đầu của câu kế tiếp.
- Chấm điểm theo từ (bỏ qua hoa/thường, dấu câu, và nội dung trong dấu ngoặc `()`), hiển thị phần đúng/thiếu/thừa.
- Phải sửa đúng 100% mới chuyển sang câu tiếp theo.
- Lưu lịch sử kết quả từng lần luyện tập (độ chính xác tổng thể + chi tiết từng câu).
- Sắp xếp danh sách bài học theo **A–Z** hoặc theo **thời gian thêm**.
- Toàn bộ dữ liệu (bài học, audio, mốc, lịch sử) lưu trong `localStorage` của trình duyệt — không cần server hay tài khoản.

## Yêu cầu

- [Node.js](https://nodejs.org/) phiên bản 18 trở lên.

## Cài đặt & chạy thử (local)

```bash
npm install
npm run dev
```

Mở địa chỉ mà terminal in ra (mặc định `http://localhost:5173`).

## Build bản production

```bash
npm run build
```

Kết quả nằm trong thư mục `dist/`. Xem thử bản build bằng:

```bash
npm run preview
```

## Đưa dự án lên GitHub

```bash
git init
git add .
git commit -m "Initial commit: Dictation Studio"
git branch -M main
git remote add origin https://github.com/<ten-user>/<ten-repo>.git
git push -u origin main
```

## Deploy miễn phí bằng GitHub Pages

1. Cài gói hỗ trợ deploy:
   ```bash
   npm install --save-dev gh-pages
   ```
2. Thêm vào `package.json` (trong `"scripts"`):
   ```json
   "predeploy": "npm run build",
   "deploy": "gh-pages -d dist"
   ```
3. Chạy:
   ```bash
   npm run deploy
   ```
4. Vào **Settings → Pages** của repo trên GitHub, chọn nguồn là nhánh `gh-pages`.

Vite đã được cấu hình `base: "./"` trong `vite.config.js` nên bản build chạy được ngay cả khi host ở một thư mục con (ví dụ `https://<user>.github.io/<repo>/`).

## Cấu trúc dự án

```
.
├── index.html
├── package.json
├── vite.config.js
├── README.md
└── src/
    ├── main.jsx      # điểm khởi chạy React
    ├── App.jsx       # toàn bộ logic + giao diện ứng dụng
    ├── storage.js     # lớp lưu trữ dựa trên localStorage
    └── index.css      # reset CSS tối giản
```

## Lưu ý về giới hạn dung lượng

Audio được lưu dưới dạng base64 trực tiếp trong `localStorage`, giới hạn dung lượng thường vào khoảng 5–10MB tùy trình duyệt cho toàn bộ dữ liệu của trang. App giới hạn mỗi file audio tối đa khoảng 4.5MB (đủ cho các đoạn hội thoại/luyện nghe ngắn đến trung bình). Nếu cần lưu nhiều bài với audio dài hơn, cân nhắc thay `src/storage.js` bằng một backend (ví dụ IndexedDB hoặc một API lưu trữ phía server).
