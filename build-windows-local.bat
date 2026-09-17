@echo off
setlocal

echo ===================================================
echo   VRCX-K Local Windows Portable Build Script
echo ===================================================
echo.

:: --- [0/4] Check and Auto-Install .NET SDK ---
dotnet --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] .NET SDK not found.
    echo [INFO] Attempting to auto-install .NET 10 SDK via winget...
    echo.
    winget install Microsoft.DotNet.SDK.10 --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] Auto-install failed. Please install .NET 10 SDK manually:
        echo https://dotnet.microsoft.com/download/dotnet/10.0
        pause
        exit /b 1
    )
    echo.
    echo [SUCCESS] .NET 10 SDK installed! 
    echo [IMPORTANT] Windows requires a shell restart to recognize new environment variables.
    echo Please CLOSE this window and RE-RUN the script.
    pause
    exit /b 0
)

:: --- [1/4] Check Node.js ^& npm ---
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js v24 or later from https://nodejs.org/
    pause
    exit /b 1
)

call npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm part of Node.js not found. Please ensure Node.js is correctly installed.
    pause
    exit /b 1
)

:: --- [2/4] Install Node Dependencies ---
if not exist "node_modules\" (
    echo [INFO] node_modules not found. Running "npm install"...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed!
        pause
        exit /b 1
    )
)

:: --- [3/4] Building Frontend ---
echo [INFO] Building Frontend...
call npm run prod
if %errorlevel% neq 0 (
    echo [ERROR] Frontend build failed! Check errors above.
    pause
    exit /b 1
)
echo.

:: --- [4/4] Building Backend ---
echo [INFO] Building Backend...
:: Stop only parent processes. CEF children share the same executable name and
:: must be allowed to exit naturally after their parent process closes.
:: 单行 -Command(双引号包裹):cmd 对双引号内的 | & ( ) 等特殊字符不解析,
:: 避免了旧版多行 ^| 转义在 cmd /c 嵌套调用下失效、PowerShell 收到 ^| 而报
:: 语法错、导致脚本中途退出、后续 xcopy 步骤从未执行的问题。
powershell -NoProfile -ExecutionPolicy Bypass -Command "$exe=[IO.Path]::GetFullPath('%~dp0build\Cef\VRCX-K.exe'); $all=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'VRCX-K.exe' -and $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=' }; $all | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; $deadline=(Get-Date).AddSeconds(10); do { Start-Sleep -Milliseconds 250; $remaining=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'VRCX-K.exe' -and $_.ExecutablePath -eq $exe } } while ($remaining -and (Get-Date) -lt $deadline); if ($remaining) { Write-Error ('CEF processes did not exit: '+($remaining.ProcessId -join ', ')); exit 1 }"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to stop the running CEF test build safely.
    exit /b 1
)

call dotnet build Dotnet\VRCX-Cef.csproj -p:Configuration=Release -p:Platform=x64
if %errorlevel% neq 0 (
    echo [ERROR] Backend build failed!
    pause
    exit /b 1
)
echo.

:: --- Finalize ---
echo [INFO] Merging Resources...
if not exist "build\Cef\html" mkdir "build\Cef\html"
xcopy "build\html" "build\Cef\html" /E /I /H /Y /Q
if %errorlevel% neq 0 (
    echo [ERROR] Resource merge failed!
    pause
    exit /b 1
)
echo.

echo ===================================================
echo [SUCCESS] Local build completed successfully!
echo.
echo You can run the portable executable here:
echo %~dp0build\Cef\VRCX-K.exe
echo ===================================================
pause
