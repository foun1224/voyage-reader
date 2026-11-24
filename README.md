# 航海書庫 · VoyageReader

專為無網路環境（郵輪、長途飛航）打造的 **iPhone 離線 PDF & EPUB 電子書閱讀器（PWA）**。

## 特色與技術設計
- **100% 離線可用**：內建 Service Worker 預先快取 App 介面、PDF.js（iOS 相容 legacy 版）與中文字型對照表（CMaps），完全不依賴外部 CDN。
- **隱私優先、零雲端上傳**：本專案僅包含閱讀器程式碼，**不含任何書籍內容或私人書單**；所有匯入的 PDF、EPUB、閱讀進度與筆記僅儲存於你自己的裝置本機（IndexedDB）。
- **大檔低記憶體架構（針對 iPhone Safari 最佳化）**：
  - 採用 **4 MB 分塊儲存（Chunked IndexedDB）** + 自訂 `PDFDataRangeTransport`，開啟 100–205 MB 掃描版 PDF 僅需讀取數百 KB、記憶體佔用低於 20 MB，不閃退。
  - 內建零相依 **ZIP32 / ZIP64 串流讀取器**，支援未壓縮（`ZIP_STORED`）分類書包以 `File.slice()` 逐本寫入，900 MB 書包也能在手機上穩定匯入。
- **掃描版 PDF 閱讀強化**：
  - **智慧自動切白邊（Auto Margin Crop）**：自動偵測頁面內容邊界，讓掃描中文書字體填滿 iPhone 螢幕寬度。
  - **日間紙質 / 護眼米黃 / 郵輪夜讀（柔化反色）** + **文字對比度增強**。
  - **純文字重排模式**（適用於含文字層之 PDF）與完整 **EPUB2/EPUB3 離線閱讀引擎**。

## iPhone 離線使用步驟（出發前設定）
1. 用 iPhone **Safari** 開啟本閱讀器的 HTTPS 網址。
2. 點擊底部「分享」按鈕 → **加入主畫面**，並從主畫面圖示開啟。
3. 切換到「**匯入**」分頁，從 iPhone「檔案」App 選擇你的分類 `.zip` 書包（或單本 `.pdf` / `.epub` / 書目 `.json`）。
4. 點擊「**執行離線檢測**」並開啟「**鎖定本機儲存防清除**」。
5. 開啟 iPhone **飛航模式** 試開一本書，確認翻頁與切白邊正常即可安心上船！

## 部署方式
本專案為純靜態 HTML/CSS/ES Modules，可直接部署到任一 HTTPS 靜態託管：
- **GitHub Pages**：在 Repo Settings → Pages 選擇 `main` 分支根目錄即可。
- **Firebase Hosting**：已內附 `firebase.json`，執行 `firebase init` / `firebase deploy` 即可上線。
