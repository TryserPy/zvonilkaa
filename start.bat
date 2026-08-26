@echo off
chcp 65001 >nul
title Zvonilka
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
