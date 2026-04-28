@echo off
chcp 65001 >nul
title MaaYuan Auto Launcher
echo ========================================
echo  Starting MaaYuan Auto Launch Script...
echo ========================================
echo.

:: Run PowerShell script with Bypass execution policy
powershell -ExecutionPolicy Bypass -WindowStyle Normal -File "%~dp0Start-MaaYuan.ps1"

if %errorlevel% neq 0 (
    echo.
    echo [Error] Script failed with code: %errorlevel%
    pause
    exit /b %errorlevel%
)

echo.
echo Script completed
timeout /t 3 /nobreak >nul