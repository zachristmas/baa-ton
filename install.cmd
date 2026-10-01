@echo off
node "%~dp0src\install.mjs" %*
exit /b %errorlevel%
