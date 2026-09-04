# zhimaheiye/zaqizaba

存放跨设备共用的小工具、脚本和 Antigravity Agent skill 文件。

---

## 目录结构

```
skills/                          ← Agent skill 文件目录
  webbridge-gpt-collab/
    SKILL.md                     ← Kimi WebBridge x GPT 实时协同 Skill
```

---

## 给另一台电脑的 Agent 的说明

### 如何取用 webbridge-gpt-collab Skill

这个 skill 用于让 Antigravity Agent 通过 **Kimi WebBridge 浏览器插件**与浏览器中打开的 **ChatGPT** 进行双向实时通信。

**前提条件（目标机必须满足）**：
1. 浏览器已安装并启动 Kimi WebBridge 插件
2. 浏览器中已打开 ChatGPT 对话页面
3. WebBridge 本地守护进程正在运行（`http://127.0.0.1:10086`）

**操作步骤**：

1. 下载 skill 文件到目标机器：

```powershell
$dest = "$env:USERPROFILE\.gemini\config\skills\webbridge-gpt-collab"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
curl.exe -L -o "$dest\SKILL.md" "https://raw.githubusercontent.com/zhimaheiye/zaqizaba/main/skills/webbridge-gpt-collab/SKILL.md"
```

2. 在 Antigravity 对话中告诉 Agent 激活 skill：

```
请阅读 skill 文件 C:\Users\<用户名>\.gemini\config\skills\webbridge-gpt-collab\SKILL.md 并按说明与 GPT 协作。
```

**Skill 能力摘要**：
- 向 GPT 输入框注入文字消息并发送（支持中文，走 Python JSON 避免 PowerShell 编码问题）
- 向 GPT 注入本地截图（base64 ClipboardEvent paste 方式）
- 读取 GPT 最新回复（支持流式等待输出完成）
- 管理专属 session / 标签组，不干扰用户当前浏览窗口
- 支持双 Session 并行控制（同时控制 GPT 页 + 被测页）
- 提供纯内存 `urllib.request` 高速方案（延迟 10~20ms，无磁盘临时文件）

**Skill 文件直链**：
`https://raw.githubusercontent.com/zhimaheiye/zaqizaba/main/skills/webbridge-gpt-collab/SKILL.md`

---

## 其他文件说明

| 文件 | 说明 |
| :--- | :--- |
| `Start-MaaYuan.ps1` | MaaYuan 启动脚本 |
| `run.bat` | 通用运行批处理 |
| `universal_sync.user.js` | 油猴脚本：通用同步 |
| `universal_sync_via.user.js` | 油猴脚本：通用同步（via 版） |
| `小手机表情包管理工具.html` | 本地表情包管理工具 |
