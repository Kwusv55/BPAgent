@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BPAgent 服务（调试用网页版）
rem 防止从旧 Claude Code 会话继承到已删除的本地路由地址
set "ANTHROPIC_BASE_URL="
rem 服务就绪后由 node 自己打开浏览器；已经在运行（托盘）时直接打开现有的
node src\server.js --open
if errorlevel 1 pause
