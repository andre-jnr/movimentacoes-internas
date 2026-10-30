@echo off
chcp 65001 >nul
title Movimentacoes internas - teste de conexao com o banco
cd /d "%~dp0.."
rem Usa o Python do .venv criado pelo instalar.bat; sem ele, o Python do sistema.
set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
"%PY%" app.py --testar
echo.
pause
