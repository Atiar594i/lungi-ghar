@echo off
chcp 65001 >nul
echo ========================================
echo লুঙ্গি ঘর - সার্ভার ও টানেল বন্ধ করা হচ্ছে
echo ========================================
echo.

echo Cloudflare Tunnel বন্ধ করা হচ্ছে...
taskkill /F /IM cloudflared.exe >nul 2>&1

echo Node.js পোর্ট ৩০০০ সার্ভার বন্ধ করা হচ্ছে...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo ========================================
echo ওয়েবসাইট ও টানেল সফলভাবে বন্ধ করা হয়েছে!
echo আবার চালু করতে চাইলে 'start.bat' রান করুন।
echo ========================================
pause
