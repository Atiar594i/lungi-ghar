@echo off
chcp 65001 >nul
echo ========================================
echo লুঙ্গি ঘর - E-Commerce Setup
echo ========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js ইনস্টল নেই! nodejs.org থেকে ডাউনলোড করুন।
    pause
    exit /b 1
)

set NODE_OPTIONS=--dns-result-order=ipv4first

if not exist node_modules (
    echo [1/3] Dependencies ইনস্টল হচ্ছে...
    call npm install --no-audit --no-fund
    if %errorlevel% neq 0 (
        echo ERROR: ইনস্টল ব্যর্থ হয়েছে!
        pause
        exit /b 1
    )
) else (
    echo [1/3] Dependencies ইতিমধ্যেই ইনস্টল আছে।
)

echo.
echo [2/3] ডেটাবেস সেটআপ হচ্ছে...
node setup.js

echo.
echo [3/4] ক্লাউডফ্লেয়ার টানেল চালু হচ্ছে (https://atiar.dpdns.org)...
start /b node start_tunnel.js

echo.
echo [4/4] ওয়েব সার্ভার চালু হচ্ছে...
echo.
echo ========================================
echo লোকাল:     http://localhost:3000
echo লাইভ ডোমেন: https://atiar.dpdns.org
echo অ্যাডমিন:   https://atiar.dpdns.org/admin
echo লগইন:      admin / admin123
echo ========================================
echo.
npm start
pause
