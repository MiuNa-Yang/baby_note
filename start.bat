@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在检查依赖...
if not exist "node_modules" (
    echo 首次运行，正在安装依赖...
    call npm install
    cd client && call npm install && cd ..
)

echo.
echo 正在构建前端...
cd client && call npm run build && cd ..

echo.
echo 正在启动服务（北京时区）...
set TZ=Asia/Shanghai
echo 当前时区: %TZ%
echo 当前时间: %date% %time%
node server/index.js

pause
