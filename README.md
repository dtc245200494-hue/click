# Campaign Scheduler Dashboard

Node.js dashboard cho **kiểm thử HTTP có ủy quyền**, được thiết kế theo yêu cầu đề tài campaign scheduler: nhiều campaign, phân phối theo thời gian, concurrency, lưu trạng thái, thống kê và phân quyền.

## Chức năng hiện có

- Nhiều campaign chạy độc lập.
- Thời gian bắt đầu/kết thúc chính xác, timezone từ trình duyệt.
- Tổng số request mục tiêu theo campaign.
- 3 chế độ phân phối: **Smart**, **Đồng đều (Even)**, **Custom** theo 7 khung giờ.
- Case chuẩn 750 request từ 07:00–13:00: Even = 125 mỗi giờ; Smart = 86/114/152/161/142/95.
- Worker pool async, giới hạn concurrency theo campaign và **global cap** để phù hợp VPS 1 vCPU / 1 GB RAM.
- Retry có backoff, retry chỉ diễn ra trước giờ kết thúc; không chạy bù sau deadline.
- HTTP keep-alive, response được drain thay vì giữ body trong RAM.
- Persist runtime state vào JSON: restart VPS không làm mất `scheduleIdx`, số lần thử, slot thành công/thất bại và retry đang chờ.
- Sau restart, job đang in-flight được đưa lại vào retry queue thay vì coi như đã hoàn tất.
- Dashboard realtime bằng Socket.IO: success, attempted, failed attempts, retry, active workers, p95 latency.
- Báo cáo `.txt` cho từng campaign.
- Role **admin / guest**: guest chỉ xem, admin được tạo/dừng campaign.
- Telegram notification tùy chọn qua biến môi trường.
- Target ngoài máy local phải nằm trong `ALLOWED_TARGET_HOSTS`.

## Cấu hình VPS 1 core / 1 GB

Bắt đầu với `MAX_CONCURRENCY=20`, mỗi campaign khoảng 10 worker. Nếu CPU/RAM/latency tăng mạnh thì hạ giới hạn. App này dùng HTTP request-only, không mở Chromium.

## Cài đặt

```bash
npm install
cp .env.example .env
npm test
npm start
```

Mặc định bind `127.0.0.1:3005`. Nếu public qua nginx/caddy, bật auth:

```bash
AUTH_ENABLED=true
ADMIN_USER=your-admin
ADMIN_PASSWORD=strong-password
GUEST_USER=viewer
GUEST_PASSWORD=another-password
```

## Target được phép test

```bash
ALLOWED_TARGET_HOSTS=staging.example.com,api.staging.example.com
```

Chỉ thêm hostname mà bạn sở hữu hoặc có quyền kiểm thử.

## Telegram

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_IDS=123456789,-100123456789
```

Token không được hard-code vào source.

## Upstream

Xem `UPSTREAM.md`. Kiến trúc pool/concurrency tham khảo từ `alexfernandez/loadtest` (MIT), sau đó được thay đổi cho scheduler nhiều campaign và global concurrency cap.
