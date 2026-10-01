@echo off
node "%~dp0src\install.mjs" --remove %*
exit /b %errorlevel%
