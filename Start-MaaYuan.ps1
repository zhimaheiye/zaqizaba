# ============================================
# 游戏日常自动启动脚本 - Start-MaaYuan.ps1
# 功能：开机时自动启动 MuMu 模拟器 + MaaYuan 脚本
# ============================================

param(
    [string]$LogPath = "$PSScriptRoot\MaaYuan_Launcher.log",
    [int]$MaxLogSizeMB = 10,
    [switch]$CheckOnly
)

# 配置路径
$script:MaaYuanPath = "C:\Users\Administrator\Desktop\MaaYuan-win-x86_64-v0.9.13-beta.7\MaaYuan.exe" # 我的脚本文件夹是放在桌面的，这里需要根据实际情况修改，下面模拟器的路径同理
$script:MuMuPath = "C:\Program Files\Netease\MuMu Player 12\nx_main\MuMuNxMain.exe"
$script:MuMuArgs = "-v 0"  # 启动参数，从快捷方式获取。默认只创建一个模拟器的话编号就是0,多开我没用过
$script:MuMuProcessName = "MuMuNxMain"
$script:MaaYuanProcessName = "MaaYuan"

# 等待时间配置（秒）
$script:WaitTimes = @{
    MuMuStartup = 30        # MuMu启动等待时间
    MuMuReady = 60          # MuMu完全加载等待时间
    MaaYuanStartup = 10     # MaaYuan启动等待时间
    CheckInterval = 5       # 检查间隔
}

# ============================================
# 日志函数
# ============================================
function Write-Log {
    param(
        [Parameter(Mandatory)]
        [string]$Message,
        
        [ValidateSet("INFO", "WARN", "ERROR", "SUCCESS")]
        [string]$Level = "INFO"
    )
    
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    
    # 控制台输出带颜色
    switch ($Level) {
        "INFO"    { Write-Host $logEntry -ForegroundColor Cyan }
        "WARN"    { Write-Host $logEntry -ForegroundColor Yellow }
        "ERROR"   { Write-Host $logEntry -ForegroundColor Red }
        "SUCCESS" { Write-Host $logEntry -ForegroundColor Green }
    }
    
    # 写入日志文件
    try {
        # 检查日志文件大小，超过则轮转
        if (Test-Path $LogPath) {
            $logSize = (Get-Item $LogPath).Length / 1MB
            if ($logSize -gt $MaxLogSizeMB) {
                $backupPath = "$LogPath.$(Get-Date -Format 'yyyyMMddHHmmss').bak"
                Move-Item $LogPath $backupPath -Force
                Write-Host "[日志轮转] 旧日志已备份到: $backupPath" -ForegroundColor Gray
            }
        }
        Add-Content -Path $LogPath -Value $logEntry -Encoding UTF8
    } catch {
        Write-Host "[警告] 无法写入日志文件: $_" -ForegroundColor Yellow
    }
}

# ============================================
# 检查 MuMu 模拟器是否真正运行（有窗口）
# ============================================
function Test-MuMuRunning {
    # 方法1: 检查主进程是否存在且响应
    $mainProcess = Get-Process -Name $script:MuMuProcessName -ErrorAction SilentlyContinue
    if (-not $mainProcess) {
        return $false
    }
    
    # 方法2: 检查是否有模拟器设备进程（真正的安卓模拟器）
    $deviceProcess = Get-Process -Name "MuMuNxDevice" -ErrorAction SilentlyContinue
    if (-not $deviceProcess) {
        Write-Log "MuMu 主进程存在，但模拟器设备未启动" "WARN"
        return $false
    }
    
    # 方法3: 检查是否有可见窗口（通过查找窗口标题）
    # 使用 Win32 API 检查是否有 MuMu 的窗口
    try {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
    
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
"@
        $found = $false
        $callback = [Win32+EnumWindowsProc] {
            param($hWnd, $lParam)
            if ([Win32]::IsWindowVisible($hWnd)) {
                $title = New-Object System.Text.StringBuilder 256
                [Win32]::GetWindowText($hWnd, $title, 256) | Out-Null
                $windowTitle = $title.ToString()
                # 检查窗口标题是否包含 MuMu 相关字样
                if ($windowTitle -match "MuMu|模拟器|Android") {
                    $script:foundWindow = $true
                }
            }
            return $true
        }
        $script:foundWindow = $false
        [Win32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
        
        if (-not $script:foundWindow) {
            Write-Log "MuMu 进程存在，但未找到可见窗口" "WARN"
            return $false
        }
    } catch {
        # Win32 API 调用失败，回退到进程检测
        Write-Log "窗口检测失败，使用进程检测回退" "WARN"
    }
    
    return $true
}

# ============================================
# 检查 MaaYuan 是否运行
# ============================================
function Test-MaaYuanRunning {
    $process = Get-Process -Name $script:MaaYuanProcessName -ErrorAction SilentlyContinue
    return ($null -ne $process)
}

# ============================================
# 启动 MuMu 模拟器
# ============================================
function Start-MuMuEmulator {
    Write-Log "正在启动 MuMu 模拟器..." "INFO"
    
    if (-not (Test-Path $script:MuMuPath)) {
        Write-Log "MuMu 路径不存在: $script:MuMuPath" "ERROR"
        return $false
    }
    
    try {
        # 启动 MuMu（带参数 -v 0 启动模拟器实例）
        Start-Process -FilePath $script:MuMuPath -ArgumentList $script:MuMuArgs -WindowStyle Normal
        Write-Log "MuMu 已启动（参数: $($script:MuMuArgs)），等待 $($script:WaitTimes.MuMuStartup) 秒..." "INFO"
        
        Start-Sleep -Seconds $script:WaitTimes.MuMuStartup
        
        # 等待 MuMu 完全加载
        $maxWait = $script:WaitTimes.MuMuReady
        $elapsed = 0
        
        while ($elapsed -lt $maxWait) {
            if (Test-MuMuRunning) {
                Write-Log "MuMu 模拟器已成功启动并运行" "SUCCESS"
                return $true
            }
            Start-Sleep -Seconds $script:WaitTimes.CheckInterval
            $elapsed += $script:WaitTimes.CheckInterval
            Write-Log "等待 MuMu 加载中... ($elapsed/$maxWait 秒)" "INFO"
        }
        
        Write-Log "MuMu 启动超时（等待了 $maxWait 秒）" "ERROR"
        return $false
        
    } catch {
        Write-Log "启动 MuMu 时出错: $_" "ERROR"
        return $false
    }
}

# ============================================
# 启动 MaaYuan
# ============================================
function Start-MaaYuanApp {
    Write-Log "正在启动 MaaYuan..." "INFO"
    
    if (-not (Test-Path $script:MaaYuanPath)) {
        Write-Log "MaaYuan 路径不存在: $script:MaaYuanPath" "ERROR"
        return $false
    }
    
    try {
        # 切换到 MaaYuan 目录并启动
        $maaDir = Split-Path $script:MaaYuanPath -Parent
        Set-Location $maaDir
        
        Start-Process -FilePath $script:MaaYuanPath -WorkingDirectory $maaDir
        Write-Log "MaaYuan 已启动" "SUCCESS"
        
        Start-Sleep -Seconds $script:WaitTimes.MaaYuanStartup
        
        if (Test-MaaYuanRunning) {
            Write-Log "MaaYuan 运行状态: 正常" "SUCCESS"
            return $true
        } else {
            Write-Log "MaaYuan 可能未正常运行" "WARN"
            return $false
        }
        
    } catch {
        Write-Log "启动 MaaYuan 时出错: $_" "ERROR"
        return $false
    }
}

# ============================================
# 发送通知（可选）
# ============================================
function Send-Notification {
    param(
        [string]$Title,
        [string]$Message,
        [ValidateSet("Info", "Warning", "Error")]
        [string]$Type = "Info"
    )
    
    try {
        # Windows 10/11 原生通知
        Add-Type -AssemblyName System.Windows.Forms
        $global:balloon = New-Object System.Windows.Forms.NotifyIcon
        $path = (Get-Process -id $pid).Path
        $balloon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
        $balloon.BalloonTipIcon = $Type
        $balloon.BalloonTipText = $Message
        $balloon.BalloonTipTitle = $Title
        $balloon.Visible = $true
        $balloon.ShowBalloonTip(5000)
    } catch {
        Write-Log "发送通知失败: $_" "WARN"
    }
}

# ============================================
# 主程序
# ============================================
function Main {
    Write-Log "========================================" "INFO"
    Write-Log "游戏日常自动启动脚本开始运行" "INFO"
    Write-Log "========================================" "INFO"
    
    $results = @{
        MuMuRunning = $false
        MuMuStarted = $false
        MaaYuanRunning = $false
        MaaYuanStarted = $false
    }
    
    # 1. 检查 MuMu 是否已运行
    Write-Log "检查 MuMu 模拟器状态..." "INFO"
    $results.MuMuRunning = Test-MuMuRunning
    
    if ($results.MuMuRunning) {
        Write-Log "MuMu 模拟器已在运行" "SUCCESS"
    } else {
        Write-Log "MuMu 模拟器未运行" "WARN"
        if (-not $CheckOnly) {
            $results.MuMuStarted = Start-MuMuEmulator
            if (-not $results.MuMuStarted) {
                Write-Log "MuMu 启动失败，终止后续操作" "ERROR"
                Send-Notification "游戏日常启动失败" "MuMu 模拟器启动失败，请检查" "Error"
                exit 1
            }
        }
    }
    
    # 2. 检查 MaaYuan 是否已运行
    Write-Log "检查 MaaYuan 状态..." "INFO"
    $results.MaaYuanRunning = Test-MaaYuanRunning
    
    if ($results.MaaYuanRunning) {
        Write-Log "MaaYuan 已在运行" "SUCCESS"
    } else {
        Write-Log "MaaYuan 未运行" "WARN"
        if (-not $CheckOnly) {
            $results.MaaYuanStarted = Start-MaaYuanApp
        }
    }
    
    # 3. 重新检测最终状态
    Start-Sleep -Seconds 2
    $finalMuMu = Test-MuMuRunning
    $finalMaaYuan = Test-MaaYuanRunning
    
    Write-Log "========================================" "INFO"
    Write-Log "启动检查结果:" "INFO"
    Write-Log "  MuMu 运行状态: $finalMuMu" $(if($finalMuMu){"SUCCESS"}else{"WARN"})
    Write-Log "  MaaYuan 运行状态: $finalMaaYuan" $(if($finalMaaYuan){"SUCCESS"}else{"WARN"})
    Write-Log "  MuMu 本次启动: $($results.MuMuStarted)" "INFO"
    Write-Log "  MaaYuan 本次启动: $($results.MaaYuanStarted)" "INFO"
    Write-Log "========================================" "INFO"
    
    # 4. 发送通知
    if ($finalMaaYuan) {
        Send-Notification "游戏日常已启动" "MuMu 和 MaaYuan 已成功启动" "Info"
    }
    
    # 5. 返回状态码
    if ($finalMaaYuan -and $finalMuMu) {
        Write-Log "脚本执行完成，状态: 成功" "SUCCESS"
        exit 0
    } else {
        Write-Log "脚本执行完成，状态: 失败" "ERROR"
        exit 1
    }
}

# 运行主程序
Main