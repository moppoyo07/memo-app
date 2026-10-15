@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo GitHub に反映します...
git add -A
git commit -m "update" > nul 2>&1
git push
if errorlevel 1 (
  echo.
  echo 失敗しました。この画面をClaudeに見せてください。
) else (
  echo.
  echo 完了しました。1-2分後にアプリに反映されます。
)
pause
