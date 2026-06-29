# Grindly Android APK Setup + Build Script (Windows PowerShell)
# Run: powershell -ExecutionPolicy Bypass -File scripts\setup-android-and-build.ps1
#
# This script:
#   1. Downloads Android command-line tools if SDK not found
#   2. Installs required SDK packages
#   3. Builds the debug APK
#   4. Copies APK to public/grindly.apk for website download

$ErrorActionPreference = "Stop"
$SDK_ROOT = "$env:LOCALAPPDATA\Android\Sdk"
$CMDTOOLS = "$SDK_ROOT\cmdline-tools\latest\bin"

Write-Host "=== Grindly Android Build ===" -ForegroundColor Cyan

# Ensure JAVA_HOME is set (auto-detect Microsoft JDK if needed)
if (-not $env:JAVA_HOME) {
    $candidate = "C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot"
    if (Test-Path "$candidate\bin\java.exe") { $env:JAVA_HOME = $candidate }
}
if ($env:JAVA_HOME) { $env:PATH = "$env:JAVA_HOME\bin;$env:PATH" }

# Check Java
try {
    $javaVersion = (& java -version 2>&1)[0]
    Write-Host "Java: $javaVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Java not found. Set JAVA_HOME or install JDK 11+." -ForegroundColor Red
    exit 1
}

# Install Android SDK if missing
if (-not (Test-Path "$CMDTOOLS\sdkmanager.bat")) {
    Write-Host "Downloading Android command-line tools..." -ForegroundColor Yellow
    $zip = "$env:TEMP\cmdline-tools.zip"
    Invoke-WebRequest `
        -Uri "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip" `
        -OutFile $zip
    New-Item -ItemType Directory -Force "$SDK_ROOT\cmdline-tools\latest" | Out-Null
    Expand-Archive -Path $zip -DestinationPath "$env:TEMP\cmdtools-extract" -Force
    Copy-Item "$env:TEMP\cmdtools-extract\cmdline-tools\*" "$SDK_ROOT\cmdline-tools\latest\" -Recurse -Force
    Remove-Item $zip -Force
    Write-Host "Android command-line tools installed." -ForegroundColor Green
}

# Accept licenses and install packages
Write-Host "Installing Android SDK packages (build tools, platform)..." -ForegroundColor Yellow
$env:ANDROID_SDK_ROOT = $SDK_ROOT
$env:ANDROID_HOME = $SDK_ROOT
"yes" | & "$CMDTOOLS\sdkmanager.bat" --licenses
& "$CMDTOOLS\sdkmanager.bat" "platform-tools" "platforms;android-34" "build-tools;34.0.0"

Write-Host "Android SDK ready." -ForegroundColor Green

# Build APK
Write-Host "Building APK..." -ForegroundColor Yellow
$androidDir = "$PSScriptRoot\..\android"
Push-Location $androidDir
& ".\gradlew.bat" assembleDebug
Pop-Location

# Copy to public/
$apkPath = "$androidDir\app\build\outputs\apk\debug\app-debug.apk"
$destPath = "$PSScriptRoot\..\public\grindly.apk"
if (Test-Path $apkPath) {
    Copy-Item $apkPath $destPath -Force
    $size = [math]::Round((Get-Item $destPath).Length / 1MB, 1)
    Write-Host ""
    Write-Host "APK built: public/grindly.apk ($size MB)" -ForegroundColor Green
    Write-Host "Users can download it from: /grindly.apk" -ForegroundColor Cyan
} else {
    Write-Host "Build complete but APK not found at expected path." -ForegroundColor Yellow
    Write-Host "Check: android/app/build/outputs/apk/" -ForegroundColor Yellow
}
