@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules" (
    echo 首次运行，正在安装依赖...
    call npm install
    cd client && call npm install && cd ..
)

echo.
echo 开发模式：前端 http://localhost:5173  后端 http://localhost:3000
echo 局域网访问请用本机IP:5173
echo.
call npm run dev
