---
name: webbridge-gpt-collab
description: |
  通过 Kimi WebBridge 浏览器插件与打开在浏览器中的 GPT（ChatGPT）进行双向实时协同。
  能力包括：向 GPT 发送文本消息、注入本地图片到 GPT 输入框、读取 GPT 最新回复。
  适用场景：与 GPT 联合调试、让 GPT 审查代码/截图、向 GPT 汇报工作进度或请求设计建议。
  使用前提：浏览器中已打开 ChatGPT 对话页面，Kimi WebBridge 插件已安装并运行。
metadata:
  version: "1.1.0"
  tested_on: "chatgpt.com"
---

# WebBridge × GPT 协同 Skill

本 Skill 记录了在本项目实际协同中验证通过的所有操作方式，依赖 [kimi-webbridge](../kimi-webbridge/SKILL.md) 技能与 `http://127.0.0.1:10086` 本地守护进程。

---

## 0. 【强制】为 Agent 新建专属浏览器窗口

> [!IMPORTANT]
> **每次开始浏览器相关任务，必须先执行此步骤，不可省略。**
>
> 如果 Agent 不主动新建专属窗口，就会操作用户当前正在使用的浏览器窗口，导致两个问题：
> 1. 用户切换窗口 / 操作浏览器时会干扰 Agent 的自动化流程
> 2. Agent 操作的窗口可能失焦，需要用户手动点击激活才能继续
>
> **正确做法**：在任务开始时，用 `navigate` + `newTab: true` + `group_title` 打开一个新标签，
> WebBridge 会自动把这个标签归入一个带颜色标签组（标签组名即为 `group_title`）。
> 用户可在浏览器中将这个标签组拖入新窗口，或者 Agent 开始前口头提示用户「我在新标签中开工，
> 你可以把那个标签组拖出来变成独立窗口」。
> 之后 Agent 只操作本 session 下的标签，**绝不使用 `active: true` 借用用户的当前标签**。

### 命名约定

`group_title` 固定前缀为 `agent:` + session 名称，例如：

| session 名 | group_title |
| :--- | :--- |
| `maa-gpt-collab` | `agent:maa-gpt-collab` |
| `web-research` | `agent:web-research` |

这样用户在浏览器里一眼就能分辨哪个标签组是 Agent 的，方便将其拖入独立窗口。

### 初始化代码

```powershell
# 用目标 URL 新建专属标签（不要用 active:true）
$req = @{
    action  = "navigate"
    args    = @{
        url         = "https://chatgpt.com/c/<your-conversation-id>"
        newTab      = $true
        group_title = "agent:maa-gpt-collab"   # 固定前缀 agent:
    }
    session = "maa-gpt-collab"   # 与 group_title 后缀保持一致
}
$json = $req | ConvertTo-Json -Depth 5 -Compress
$path = "$env:TEMP\webbridge-init.json"
[System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
curl.exe -s -X POST http://127.0.0.1:10086/command -H "Content-Type: application/json" --data-binary "@$path"
Remove-Item -Path $path -ErrorAction SilentlyContinue
```

执行后浏览器会出现一个带颜色标签组（名称为 `agent:maa-gpt-collab`），如下图所示：

```
[ agent:maa-gpt-collab ] [ 开心水族箱Wiki数据采集  ×  +]
```

**之后所有操作都在这个 session 下进行，不需要再用 `find_tab` 或 `active:true`。**

---

## 1. 环境准备（检查 / 启动 WebBridge 守护进程）

```powershell
# 检查守护进程是否在线
curl.exe -s http://127.0.0.1:10086/status

# 若未运行，启动守护进程（前台调试模式）
& "$env:USERPROFILE\.kimi-webbridge\bin\kimi-webbridge.exe" start --foreground
```

> [!IMPORTANT]
> Windows 下必须使用 `curl.exe`，**不能用** PowerShell 内置的 `curl`（它是 `Invoke-WebRequest` 的别名，行为不同）。

---

## 2. 【备用】绑定到用户已打开的 GPT 标签页

> [!WARNING]
> **此方法为应急备用，正常工作流应使用第 0 节的专属窗口方式。**
>
> `active:true` 会借用用户**当前正在看的标签页**，一旦用户切换标签或窗口，Agent 的操作目标就会改变。
> 仅在以下场景使用：用户明确要求「就操作我正在看的这个页面」的一次性快速查看。

```powershell
$req = @{
    action  = "find_tab"
    args    = @{ url = "https://chatgpt.com/c/<your-conversation-id>"; active = $false }
    session = "maa-gpt-collab"
}
$json = $req | ConvertTo-Json -Depth 5 -Compress
$path = "$env:TEMP\webbridge-findtab.json"
[System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
curl.exe -s -X POST http://127.0.0.1:10086/command -H "Content-Type: application/json" --data-binary "@$path"
Remove-Item -Path $path -ErrorAction SilentlyContinue
```

> [!NOTE]
> 注意这里改为 `active: false`（通过 URL 精确匹配），避免借用用户正在看的随机页面。

---

## 3. 向 GPT 发送文本消息（fill + 点击发送）

### 3a. 填写消息内容（`fill` 动作）

ChatGPT 的输入框是 `[contenteditable]` 富文本容器，selector 为 `#prompt-textarea`。

```powershell
# 用 Python 构建包含 Unicode 的 payload，避免 PowerShell 非ASCII编码问题
$script = @'
import json

msg = """你好 GPT！这里是 Antigravity Agent 的汇报：..."""

req = {
    "action": "fill",
    "args": {
        "selector": "#prompt-textarea",
        "value": msg
    },
    "session": "maa-gpt-collab"
}
with open(r"C:\Temp\webbridge-fill.json", "w", encoding="utf-8") as f:
    json.dump(req, f, ensure_ascii=False)
print("Payload built.")
'@
[System.IO.File]::WriteAllText("C:\Temp\build_fill.py", $script, [System.Text.UTF8Encoding]::new($false))
python C:\Temp\build_fill.py

curl.exe -s -X POST http://127.0.0.1:10086/command -H "Content-Type: application/json" --data-binary "@C:\Temp\webbridge-fill.json"
```

> [!IMPORTANT]
> **中文 / 多字节内容必须用 Python 写 JSON**，不能用 PowerShell Here-String 直接写，否则非 ASCII 字符会被截断为 `?`。
>
> `fill` 的返回 `{"ok":true,"data":{"mode":"contenteditable",...}}` 说明成功注入富文本。

### 3b. 点击发送按钮

```powershell
$js = @"
(() => {
  const btn = document.querySelector('button[data-testid="send-button"]')
           || document.querySelector('#composer-submit-button');
  if (btn && !btn.disabled) {
    btn.click();
    return { success: true, method: 'btn.click' };
  }
  return { success: false, disabled: btn ? btn.disabled : true };
})()
"@
$reqObj = @{
    action = "evaluate"
    args   = @{ code = $js }
    session = "maa-gpt-collab"
}
$json = $reqObj | ConvertTo-Json -Depth 5 -Compress
$path = "$env:TEMP\webbridge-send.json"
[System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
curl.exe -s -X POST http://127.0.0.1:10086/command -H "Content-Type: application/json" --data-binary "@$path"
Remove-Item -Path $path -ErrorAction SilentlyContinue
```

> [!TIP]
> 若 `fill` 成功但 send-button 找不到，说明 GPT 有时渲染了 `#composer-submit-button`；上方代码已同时覆盖两个选择器，优先使用 `data-testid="send-button"`。

---

## 4. 向 GPT 注入本地图片

ChatGPT 支持粘贴图片，但**无法直接用 `<input type=file>` 方式上传**（文件选择器对扩展不可见）。
实测可行的方式是：**把图片 base64 编码，通过 `evaluate` 写入 DataTransfer 并 dispatch `paste` 事件到编辑器**。

```python
import base64, json

img_path = r"path\to\your\image.png"
with open(img_path, "rb") as f:
    b64 = base64.b64encode(f.read()).decode("ascii")

js_code = f"""
(() => {{
  try {{
    const b64 = "{b64}";
    const byteCharacters = atob(b64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {{
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }}
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], {{ type: 'image/png' }});
    const file = new File([blob], 'screenshot.png', {{ type: 'image/png' }});

    // 构造 ClipboardEvent 并把图片注入到 GPT 输入框
    const dt = new DataTransfer();
    dt.items.add(file);
    const editor = document.querySelector('#prompt-textarea')
               || document.querySelector('[contenteditable]');
    if (editor) {{
      const pasteEvent = new ClipboardEvent('paste', {{
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      }});
      editor.dispatchEvent(pasteEvent);
      return {{ success: true, method: 'paste_event' }};
    }}
    return {{ success: false, reason: 'editor not found' }};
  }} catch (e) {{
    return {{ error: e.toString() }};
  }}
}})()
"""

req = {
    "action": "evaluate",
    "args": {"code": js_code},
    "session": "maa-gpt-collab"
}
with open(r"C:\Temp\webbridge-inject-img.json", "w", encoding="utf-8") as f:
    json.dump(req, f)

print("Image injection payload built.")
```

然后执行：

```powershell
curl.exe -s -X POST http://127.0.0.1:10086/command -H "Content-Type: application/json" --data-binary "@C:\Temp\webbridge-inject-img.json"
```

> [!WARNING]
> 图片注入后，需要先补充文字消息（用 fill 追加），再点击发送。
> GPT 有时会在粘贴图片后自动聚焦编辑器，此时可以直接 fill + click 发送。
>
> 若图片超过约 800KB，base64 字符串会使 JS 代码体积过大，建议先 resize 到 1280px 宽再注入。

---

## 5. 读取 GPT 最新回复

```powershell
$js = @"
(() => {
  const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
  const lastTurn = turns[turns.length - 1];
  const isStreaming = !!document.querySelector('.result-streaming')
                   || !!document.querySelector('[data-testid="stop-button"]');
  return {
    isStreaming: isStreaming,
    lastTextLength: lastTurn ? lastTurn.innerText.length : 0,
    fullText: lastTurn ? lastTurn.innerText : ''
  };
})()
"@
$reqObj = @{
    action  = "evaluate"
    args    = @{ code = $js }
    session = "maa-gpt-collab"
}
$json = $reqObj | ConvertTo-Json -Depth 5 -Compress
$path = "$env:TEMP\webbridge-read-reply.json"
[System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
curl.exe -s -X POST http://127.0.0.1:10086/command -H "Content-Type: application/json" --data-binary "@$path"
Remove-Item -Path $path -ErrorAction SilentlyContinue
```

> [!TIP]
> 发送消息后，先 `Start-Sleep -Seconds 5`，再轮询 `isStreaming`，直到 `isStreaming: false` 再读取完整回复。
>
> 实测 GPT 复杂问题回复时间 20~60 秒，建议每 8 秒轮询一次。

---

## 6. 完整流程示例（Python 版，推荐）

将发送文字 + 读取回复集成为辅助函数：

```python
import subprocess, json, time, tempfile, os

WEBBRIDGE = "http://127.0.0.1:10086/command"
SESSION = "maa-gpt-collab"

def wb(payload: dict) -> dict:
    """向 WebBridge 发送命令，返回响应 dict"""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    ) as f:
        json.dump(payload, f, ensure_ascii=False)
        path = f.name
    result = subprocess.run(
        ["curl.exe", "-s", "-X", "POST", WEBBRIDGE,
         "-H", "Content-Type: application/json",
         "--data-binary", f"@{path}"],
        capture_output=True, text=True
    )
    os.unlink(path)
    try:
        return json.loads(result.stdout)
    except Exception:
        return {"raw": result.stdout}


def send_to_gpt(text: str) -> bool:
    """填入文字 + 点击发送，返回是否成功"""
    # Step 1: fill
    wb({"action": "fill", "args": {"selector": "#prompt-textarea", "value": text},
        "session": SESSION})
    time.sleep(0.5)

    # Step 2: click send
    js = """(() => {
      const btn = document.querySelector('button[data-testid="send-button"]')
               || document.querySelector('#composer-submit-button');
      if (btn && !btn.disabled) { btn.click(); return {success: true}; }
      return {success: false};
    })()"""
    resp = wb({"action": "evaluate", "args": {"code": js}, "session": SESSION})
    return resp.get("data", {}).get("value", {}).get("success", False)


def wait_for_gpt_reply(timeout=90) -> str:
    """等待 GPT 完成输出，返回最后一条消息全文"""
    js_check = """(() => {
      const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
      const last = turns[turns.length - 1];
      const streaming = !!document.querySelector('.result-streaming')
                     || !!document.querySelector('[data-testid="stop-button"]');
      return {isStreaming: streaming, fullText: last ? last.innerText : ''};
    })()"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(8)
        resp = wb({"action": "evaluate", "args": {"code": js_check}, "session": SESSION})
        data = resp.get("data", {}).get("value", {})
        if not data.get("isStreaming", True):
            return data.get("fullText", "")
    return "(timeout)"


# 用法示例
if __name__ == "__main__":
    send_to_gpt("你好，请确认收到本条测试消息。")
    reply = wait_for_gpt_reply()
    print("GPT 回复:", reply[-200:])  # 只打印末尾 200 字
```

---

## 7. 常见问题排查

| 症状 | 原因 | 解法 |
| :--- | :--- | :--- |
| `fill` 后消息为 `???` 或乱码 | PowerShell 非 ASCII 编码截断 | **改用 Python** 写 JSON payload |
| `fill` 返回 `mode: value` 而非 `contenteditable` | 命中了旧版 textarea（已废弃） | 重试；或检查 selector 是否正确 |
| send-button 返回 `disabled: true` | GPT 正在处理上一条消息 | 等待 `isStreaming: false` 后再发送 |
| 图片注入后 GPT 未显示图片 | GPT 账户无多模态权限，或 `paste` 事件被拦截 | 确认账户有 GPT-4o / Vision 权限 |
| `find_tab` 报 "no tab matching" | ChatGPT URL 与实际标签 URL 不一致 | 用 `list_tabs` 查看实际 URL 再重试 |
| 读不到 `[data-testid^="conversation-turn-"]` | GPT 页面 HTML 结构更新 | 改用 `document.querySelectorAll('[data-message-id]')` 作为后备 |

---

## 8. 关键约束与注意事项

> [!IMPORTANT]
> - **Session 名称全程保持一致**（本项目约定 `"maa-gpt-collab"`），切勿中途更换，否则 WebBridge 会开新标签组。
> - **所有包含中文的 payload 必须用 Python 写 JSON**，不要用 PowerShell Here-String。
> - 推荐使用 Python 原生 `urllib.request` 进行纯内存 HTTP 请求，避免磁盘临时文件与外部进程开销。
> - 图片注入走 `ClipboardEvent('paste')` 而非 `<input type=file>`，后者在扩展中不可用。
> - GPT 页面结构会随版本更新，`data-testid` 属性相对稳定，优先使用。

---

## 9. 极速自动化与实机排查最佳实践 (High-Performance Engine)

在多轮“AI指挥-实机测试-反馈修复”的高频协同中，如果采用常规的低速模拟点击、磁盘中转和频繁重连，单次循环耗时会成倍增加。以下为经过实战验证的核心提速技术：

### 9.1 纯内存 HTTP 请求（urllib.request 代替 curl.exe）
淘汰在磁盘生成临时 JSON 文件并调用 `curl.exe` 的旧方式，改用 Python 标准库 `urllib.request` 直接与守护进程通信：
```python
import urllib.request, json

def call_bridge(action, args=None, session="maa-gpt-collab"):
    payload = {"action": action, "session": session}
    if args:
        payload["args"] = args
    req = urllib.request.Request(
        "http://127.0.0.1:10086/command",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))
```
- **延迟从 200~400ms 降至 10~20ms**；
- 彻底规避 Windows 控制台与 PowerShell 的编码/管道问题；
- 零磁盘垃圾文件，无需清理。

### 9.2 双 Session 并行控制（左侧 GPT + 右侧被测 Web）
WebBridge 支持通过不同的 `session` 标示符同时保持对多个标签页的持久绑定：
- `session: "maa-gpt-collab"`：专控左侧 ChatGPT 对话；
- `session: "auto-dev"`：专控右侧正在开发调试的本地页面（如 `http://127.0.0.1:8000/`）。

在同一个自动化脚本内，可以实现：
1. `call_bridge('screenshot', ..., session='auto-dev')` 截取应用实机；
2. `call_bridge('evaluate', ..., session='auto-dev')` 获取页面诊断；
3. `call_bridge('fill', ..., session='maa-gpt-collab')` 将诊断即时投递给 GPT；
4. 等待 GPT 指令后，直接再次控制 `auto-dev` 页面热加载复测。全程无需切屏、无需重新绑定标签。

### 9.3 聚合整页诊断脚本（All-in-One Evaluate）
避免零碎地多次往返查询。遇到样式/渲染问题时，将所有要采集的指标打包在单个立即执行函数（IIFE）中，单次请求获取全量数据：
```javascript
(() => {
  const wrapper = document.querySelector(".calendar-task-wrapper");
  const card = document.querySelector(".calendar-task-card");
  const boldFace = Array.from(document.fonts).find(f => f.family.includes("Phosphor-Bold"));
  return JSON.stringify({
    wrapperH: wrapper ? wrapper.offsetHeight : 0,
    cardH: card ? card.offsetHeight : 0,
    fontStatus: boldFace ? boldFace.status : "missing",
    hitElements: document.elementsFromPoint(200, 300).map(el => el.className)
  });
})()
```

### 9.4 穿透 React 虚拟 DOM 的确定性极速交互
常规模拟（如模拟鼠标拖拽、长按、多步滑动）不仅容易因 CSS 动画、手势阈值、遮挡层导致失败，且耗时较长。针对现代化前端应用（尤其是 React），可采用以下穿透式直接触发：
1. **直接调用 React 合成事件（React Props 穿透）**：
   ```javascript
   const el = document.querySelector('.icon-item');
   const propKey = Object.keys(el).find(k => k.startsWith('__reactProps'));
   if (propKey && el[propKey].onClick) {
     el[propKey].onClick(); // 绕过所有物理碰撞和动画拦截，0ms 确定性触发
   }
   ```
2. **派发原生确定性事件**：
   - 快速滑动手势/解锁：无需定时器逐步拖拽，直接分发 `new WheelEvent("wheel", { deltaY: 100, bubbles: true })` 瞬间触发解锁逻辑；
   - 手势触发：通过合成 `TouchEvent` 直接传参给 React 事件句柄。

### 9.5 智能流式轮询与响应捕获
通过精确检测 ChatGPT 输出状态与占位符，实现 GPT 完毕即刻返回：
```python
js_check = """(() => {
  const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
  const last = turns[turns.length - 1];
  const streaming = !!document.querySelector('.result-streaming')
                 || !!document.querySelector('[data-testid="stop-button"]');
  return {
    turnCount: turns.length,
    isStreaming: streaming,
    fullText: last ? last.innerText : ''
  };
})()"""
```
轮询间隔设为 5 秒，并且在 `not isStreaming and len(text) > 50 and "正在思考" not in text` 时立即判定生成完毕，无多余等待。
