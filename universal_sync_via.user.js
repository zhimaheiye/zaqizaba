// ==UserScript==
// @name         Universal Web Cache Sync (Via 版)
// @namespace    https://viayoo.com/universal-cache-sync
// @version      1.0
// @description  一键同步网页的 LocalStorage 和 IndexedDB 缓存至坚果云 WebDAV（适配 Via 浏览器）
// @author       Antigravity
// @match        *://*/*
// @match        file:///*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      dav.jianguoyun.com
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Via / 油猴 API 兼容层（GM 不可用时回退到 localStorage，跨域请求需 GM_xmlhttpRequest）
    const STORAGE_PREFIX = '__ucs_sync__';
    const GM = {
        getValue(key, defaultValue) {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(key, defaultValue);
            }
            try {
                const val = localStorage.getItem(STORAGE_PREFIX + key);
                return val !== null ? val : defaultValue;
            } catch (e) {
                return defaultValue;
            }
        },
        setValue(key, value) {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, value);
                return;
            }
            try {
                localStorage.setItem(STORAGE_PREFIX + key, String(value));
            } catch (e) {}
        },
        xmlhttpRequest(details) {
            if (typeof GM_xmlhttpRequest === 'function') {
                return GM_xmlhttpRequest(details);
            }
            const err = new Error('当前环境不支持跨域 WebDAV 请求，请在 Via 脚本设置中确认已声明 @grant GM_xmlhttpRequest');
            if (details.onerror) details.onerror(err);
            else throw err;
        }
    };

    // ==========================================
    // 1. 唯一标识符生成
    // ==========================================
    function getIdentifier() {
        if (window.location.protocol === 'file:') {
            const path = window.location.pathname;
            const filename = path.substring(path.lastIndexOf('/') + 1);
            const cleanName = decodeURIComponent(filename).replace(/\.[^/.]+$/, "");
            return 'local_' + (cleanName || 'unnamed_file');
        } else {
            let path = window.location.hostname + window.location.pathname;
            path = path.replace(/\/$/, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
            return 'web_' + path;
        }
    }

    const IDENTIFIER = getIdentifier();
    const BACKUP_FILENAME = `sync_${IDENTIFIER}.json`;

    // ==========================================
    // 2. 数据读取与恢复核心逻辑 (IndexedDB & LocalStorage)
    // ==========================================

    // 获取所有 IndexedDB 数据
    async function exportIndexedDB(customDbNames = []) {
        let dbInfos = [];
        if (window.indexedDB && window.indexedDB.databases) {
            try {
                dbInfos = await window.indexedDB.databases();
            } catch (e) {
                console.warn("[Sync] 无法自动列出 IndexedDB 数据库:", e);
            }
        }

        // 合并用户手动指定的数据库名
        customDbNames.forEach(name => {
            if (name && !dbInfos.some(db => db.name === name)) {
                dbInfos.push({ name: name });
            }
        });

        const backupData = [];

        for (const dbInfo of dbInfos) {
            if (!dbInfo.name) continue;
            try {
                const db = await new Promise((resolve, reject) => {
                    const req = indexedDB.open(dbInfo.name);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });

                const version = db.version;
                const storeNames = Array.from(db.objectStoreNames);
                const stores = [];

                if (storeNames.length > 0) {
                    const tx = db.transaction(storeNames, 'readonly');
                    for (const storeName of storeNames) {
                        const store = tx.objectStore(storeName);
                        
                        // 导出索引配置
                        const indexes = [];
                        for (const indexName of store.indexNames) {
                            const idx = store.index(indexName);
                            indexes.push({
                                name: indexName,
                                keyPath: idx.keyPath,
                                unique: idx.unique,
                                multiEntry: idx.multiEntry
                            });
                        }

                        // 导出数据
                        const items = [];
                        await new Promise((resolve, reject) => {
                            const req = store.openCursor();
                            req.onsuccess = (e) => {
                                const cursor = e.target.result;
                                if (cursor) {
                                    items.push({ key: cursor.key, value: cursor.value });
                                    cursor.continue();
                                } else {
                                    resolve();
                                }
                            };
                            req.onerror = () => reject(req.error);
                        });

                        stores.push({
                            name: storeName,
                            keyPath: store.keyPath,
                            autoIncrement: store.autoIncrement,
                            indexes: indexes,
                            data: items
                        });
                    }
                }
                db.close();

                backupData.push({
                    name: dbInfo.name,
                    version: version,
                    stores: stores
                });
            } catch (e) {
                console.error(`[Sync] 备份数据库 ${dbInfo.name} 失败:`, e);
            }
        }
        return backupData;
    }

    // 还原 IndexedDB 数据
    async function importIndexedDB(dbData) {
        for (const dbBackup of dbData) {
            try {
                let activeDb = null;
                let currentVersion = 0;
                let needsUpgrade = false;

                // 探针：无版本要求打开，探测当前数据库状态
                activeDb = await new Promise((resolve, reject) => {
                    const req = indexedDB.open(dbBackup.name);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                
                currentVersion = activeDb.version;
                
                // 检查是否缺少必要的表 (比如新设备上首次还原)
                for (const storeBackup of dbBackup.stores) {
                    if (!activeDb.objectStoreNames.contains(storeBackup.name)) {
                        needsUpgrade = true;
                        break;
                    }
                }
                
                if (needsUpgrade) {
                    activeDb.close(); // 关闭连接，准备升级
                    activeDb = null;
                    
                    // 需要建表，使用比当前版本更高的版本号
                    const newVersion = Math.max(currentVersion + 1, dbBackup.version);
                    
                    activeDb = await new Promise((resolve, reject) => {
                        const req = indexedDB.open(dbBackup.name, newVersion);
                        
                        req.onupgradeneeded = (e) => {
                            const tempDb = req.result;
                            for (const storeBackup of dbBackup.stores) {
                                if (!tempDb.objectStoreNames.contains(storeBackup.name)) {
                                    const opt = {};
                                    if (storeBackup.keyPath !== undefined) opt.keyPath = storeBackup.keyPath;
                                    if (storeBackup.autoIncrement !== undefined) opt.autoIncrement = storeBackup.autoIncrement;
                                    
                                    const os = tempDb.createObjectStore(storeBackup.name, opt);
                                    if (storeBackup.indexes) {
                                        for (const idx of storeBackup.indexes) {
                                            os.createIndex(idx.name, idx.keyPath, { unique: idx.unique, multiEntry: idx.multiEntry });
                                        }
                                    }
                                }
                            }
                        };
                        
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => reject(req.error);
                        req.onblocked = () => {
                            console.warn(`[Sync] 建表被阻塞！放弃建表，尝试原地覆盖...`);
                            resolve(null);
                        };
                    });
                }

                if (!activeDb) {
                    // 如果建表被阻塞，最后尝试降级到不升级版本直接打开
                    activeDb = await new Promise((resolve, reject) => {
                        const req = indexedDB.open(dbBackup.name);
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => reject(req.error);
                    });
                }

                if (!activeDb) continue;

                // 3. 原地覆盖填充数据
                if (dbBackup.stores.length > 0) {
                    const storeNames = dbBackup.stores.map(s => s.name).filter(name => activeDb.objectStoreNames.contains(name));
                    
                    if (storeNames.length > 0) {
                        const tx = activeDb.transaction(storeNames, 'readwrite');
                        
                        for (const storeBackup of dbBackup.stores) {
                            if (!storeNames.includes(storeBackup.name)) continue;
                            
                            const os = tx.objectStore(storeBackup.name);
                            // 先清空该表里的旧数据
                            os.clear();
                            
                            for (const item of storeBackup.data) {
                                if (storeBackup.keyPath) {
                                    os.put(item.value);
                                } else {
                                    os.put(item.value, item.key);
                                }
                            }
                        }

                        await new Promise((resolve) => {
                            tx.oncomplete = () => resolve();
                            tx.onerror = () => {
                                console.error(`[Sync] 写入 ${dbBackup.name} 数据失败:`, tx.error);
                                resolve();
                            };
                        });
                    }
                }
                activeDb.close();
            } catch (e) {
                console.error(`[Sync] 还原数据库 ${dbBackup.name} 失败:`, e);
            }
        }
    }

    // 备份 LocalStorage
    function exportLocalStorage() {
        const data = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            data[key] = localStorage.getItem(key);
        }
        return data;
    }

    // 还原 LocalStorage
    function importLocalStorage(data) {
        localStorage.clear();
        for (const [key, value] of Object.entries(data)) {
            localStorage.setItem(key, value);
        }
    }

    // 一键导出全部数据为 JSON 对象
    async function getFullBackupPayload(customDbNames = []) {
        const localData = exportLocalStorage();
        const idbData = await exportIndexedDB(customDbNames);
        return {
            timestamp: Date.now(),
            identifier: IDENTIFIER,
            localStorage: localData,
            indexedDB: idbData
        };
    }

    // 一键还原全部数据
    async function restoreFromPayload(payload) {
        if (!payload) return;
        if (payload.localStorage) {
            importLocalStorage(payload.localStorage);
        }
        if (payload.indexedDB) {
            await importIndexedDB(payload.indexedDB);
        }
    }

    // ==========================================
    // 3. WebDAV 坚果云同步协议适配
    // ==========================================
    class WebDAVClient {
        constructor() {
            this.updateConfig();
        }

        updateConfig() {
            this.url = GM.getValue("webdav_url", "https://dav.jianguoyun.com/dav/");
            this.user = GM.getValue("webdav_user", "");
            this.pass = GM.getValue("webdav_pass", "");
            if (!this.url.endsWith("/")) this.url += "/";
            
            // 确保同步文件夹存在
            this.syncFolderUrl = this.url + "UniversalSync/";
        }

        getAuthHeader() {
            return "Basic " + btoa(this.user + ":" + this.pass);
        }

        isConfigured() {
            return this.user && this.pass;
        }

        // 初始化文件夹 (如果不存在则创建)
        async initDirectory() {
            return new Promise((resolve) => {
                GM.xmlhttpRequest({
                    method: "MKCOL",
                    url: this.syncFolderUrl,
                    headers: {
                        "Authorization": this.getAuthHeader()
                    },
                    onload: (res) => {
                        // 201 Created 或者 405 Method Not Allowed (说明已存在) 都算成功
                        if (res.status === 201 || res.status === 405) {
                            resolve(true);
                        } else {
                            resolve(false);
                        }
                    },
                    onerror: () => resolve(false)
                });
            });
        }

        // 上传备份文件
        async upload(payload) {
            if (!this.isConfigured()) throw new Error("请先配置坚果云账号密码！");
            
            await this.initDirectory();

            return new Promise((resolve, reject) => {
                GM.xmlhttpRequest({
                    method: "PUT",
                    url: this.syncFolderUrl + BACKUP_FILENAME,
                    headers: {
                        "Authorization": this.getAuthHeader(),
                        "Content-Type": "application/json; charset=utf-8"
                    },
                    data: JSON.stringify(payload, null, 2),
                    onload: (res) => {
                        if (res.status === 201 || res.status === 204 || res.status === 200) {
                            resolve(true);
                        } else {
                            reject(new Error(`上传失败，WebDAV 返回状态码: ${res.status}`));
                        }
                    },
                    onerror: (err) => reject(err)
                });
            });
        }

        // 下载备份文件
        async download() {
            if (!this.isConfigured()) throw new Error("请先配置坚果云账号密码！");

            return new Promise((resolve, reject) => {
                GM.xmlhttpRequest({
                    method: "GET",
                    url: this.syncFolderUrl + BACKUP_FILENAME,
                    headers: {
                        "Authorization": this.getAuthHeader(),
                        "Cache-Control": "no-cache"
                    },
                    onload: (res) => {
                        if (res.status === 200) {
                            try {
                                const data = JSON.parse(res.responseText);
                                resolve(data);
                            } catch (e) {
                                reject(new Error("解析云端备份数据失败，可能数据已损坏"));
                            }
                        } else if (res.status === 404) {
                            resolve(null); // 无备份
                        } else {
                            reject(new Error(`下载失败，WebDAV 返回状态码: ${res.status}`));
                        }
                    },
                    onerror: (err) => reject(err)
                });
            });
        }
    }

    const davClient = new WebDAVClient();

    // ==========================================
    // 4. 悬浮窗 UI & 交互构建 (使用 Shadow DOM 保证隔离)
    // ==========================================
    const shadowHost = document.createElement('div');
    shadowHost.id = 'universal-cache-sync-root';
    shadowHost.style.position = 'fixed';
    shadowHost.style.zIndex = '9999999';
    document.body.appendChild(shadowHost);

    const shadow = shadowHost.attachShadow({ mode: 'open' });

    // CSS 样式注入 (极简高级感，深色微光玻璃态)
    const style = document.createElement('style');
    style.textContent = `
        :host {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            color: #e0e0e0;
        }

        /* 悬浮球 */
        .sync-badge {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 42px;
            height: 42px;
            background: rgba(30, 30, 35, 0.85);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 16px rgba(0,0,0,0.3);
            transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            user-select: none;
            z-index: 1000;
            touch-action: none;
            -webkit-tap-highlight-color: transparent;
        }
        .sync-badge:hover {
            transform: scale(1.08) translateY(-2px);
            background: rgba(45, 45, 50, 0.95);
            border-color: rgba(74, 132, 193, 0.6);
            box-shadow: 0 6px 20px rgba(74, 132, 193, 0.3);
        }
        .sync-badge svg {
            width: 20px;
            height: 20px;
            fill: #a0c0ff;
            transition: transform 0.5s ease;
        }
        .sync-badge.syncing svg {
            animation: spin 1s infinite linear;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* 控制面板 */
        .sync-panel {
            position: fixed;
            bottom: 75px;
            right: 20px;
            width: 320px;
            background: rgba(20, 20, 25, 0.92);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.5);
            display: none;
            flex-direction: column;
            overflow: hidden;
            z-index: 999;
            transform: translateY(10px);
            opacity: 0;
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .sync-panel.show {
            display: flex;
            transform: translateY(0);
            opacity: 1;
        }

        /* 头部 */
        .panel-header {
            padding: 16px;
            background: rgba(255,255,255,0.03);
            border-bottom: 1px solid rgba(255,255,255,0.05);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .panel-title {
            margin: 0;
            font-size: 14px;
            font-weight: 600;
            color: #ffffff;
            letter-spacing: 0.5px;
        }
        .close-btn {
            background: none;
            border: none;
            color: #888;
            cursor: pointer;
            font-size: 16px;
            padding: 0;
            line-height: 1;
        }
        .close-btn:hover { color: #fff; }

        /* 选项卡 */
        .tabs {
            display: flex;
            background: rgba(0,0,0,0.2);
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .tab-btn {
            flex: 1;
            padding: 10px;
            background: none;
            border: none;
            color: #888;
            font-size: 12px;
            cursor: pointer;
            text-align: center;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
        }
        .tab-btn.active {
            color: #a0c0ff;
            border-bottom-color: #4A84C1;
            background: rgba(255,255,255,0.01);
        }

        /* 内容区 */
        .panel-body {
            padding: 16px;
            max-height: 320px;
            overflow-y: auto;
        }
        .tab-content { display: none; }
        .tab-content.active { display: block; }

        /* 信息展示 */
        .info-item {
            margin-bottom: 12px;
            font-size: 12px;
            color: #aaa;
        }
        .info-label {
            font-weight: bold;
            color: #ccc;
            margin-bottom: 4px;
        }
        .info-value {
            word-break: break-all;
            background: rgba(255,255,255,0.05);
            padding: 6px 10px;
            border-radius: 6px;
            font-family: monospace;
            color: #8faeff;
        }

        /* 按钮 */
        .btn {
            width: 100%;
            padding: 10px;
            margin-top: 8px;
            border: none;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: all 0.2s;
        }
        .btn-primary {
            background: #4A84C1;
            color: white;
        }
        .btn-primary:hover { background: #3570ad; }
        .btn-secondary {
            background: rgba(255,255,255,0.08);
            color: #ccc;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .btn-secondary:hover {
            background: rgba(255,255,255,0.15);
            color: #fff;
        }

        /* 表单 */
        .form-group {
            margin-bottom: 12px;
        }
        .form-label {
            display: block;
            font-size: 12px;
            color: #ccc;
            margin-bottom: 6px;
        }
        .form-input {
            width: 100%;
            box-sizing: border-box;
            background: rgba(0,0,0,0.3);
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 6px;
            padding: 8px;
            color: white;
            font-size: 12px;
            outline: none;
            transition: border 0.2s;
        }
        .form-input:focus {
            border-color: #4A84C1;
        }

        /* 提示提示框 */
        .tip-box {
            font-size: 11px;
            line-height: 1.5;
            color: #ffb86c;
            background: rgba(255, 184, 108, 0.1);
            border-left: 2px solid #ffb86c;
            padding: 8px;
            border-radius: 4px;
            margin-bottom: 12px;
        }

        /* 状态文字 */
        .status-msg {
            font-size: 11px;
            text-align: center;
            margin-top: 10px;
            color: #888;
            min-height: 16px;
        }
        .status-msg.success { color: #50fa7b; }
        .status-msg.error { color: #ff5555; }

        @media (max-width: 480px) {
            .sync-panel {
                width: calc(100vw - 40px);
                max-width: 360px;
                right: 20px;
                left: auto;
            }
            .panel-body {
                max-height: 50vh;
            }
            .btn {
                padding: 12px;
                font-size: 14px;
            }
        }
    `;
    shadow.appendChild(style);

    // HTML 结构
    const container = document.createElement('div');
    container.innerHTML = `
        <div class="sync-badge" id="syncBadge" title="网页缓存同步助手">
            <svg viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.53c-.26-.81-1-1.4-1.9-1.4h-1v-3c0-.55-.45-1-1-1h-6v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.4z"/>
            </svg>
        </div>

        <div class="sync-panel" id="syncPanel">
            <div class="panel-header">
                <h3 class="panel-title">📦 Universal Cache Sync</h3>
                <button class="close-btn" id="closeBtn">×</button>
            </div>
            
            <div class="tabs">
                <button class="tab-btn active" data-tab="sync">同步</button>
                <button class="tab-btn" data-tab="settings">设置</button>
            </div>

            <div class="panel-body">
                <!-- 同步选项卡 -->
                <div class="tab-content active" id="tab-sync">
                    <div class="info-item">
                        <div class="info-label">备份标识 (云端文件名):</div>
                        <div class="info-value" id="valIdentifier"></div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">最后本地备份时间:</div>
                        <div class="info-value" id="valLastSync">暂无</div>
                    </div>

                    <button class="btn btn-primary" id="btnUpload">
                        📤 上传当前缓存至云端
                    </button>
                    <button class="btn btn-secondary" id="btnDownload">
                        📥 从云端覆盖恢复本地
                    </button>
                    <div class="status-msg" id="syncStatus"></div>
                </div>

                <!-- 设置选项卡 -->
                <div class="tab-content" id="tab-settings">
                    <div class="tip-box">
                        <strong>坚果云设置引导：</strong><br/>
                        1. 登录坚果云网页版 -> 账户信息 -> 安全选项<br/>
                        2. 在“第三方应用管理”添加应用，生成<b>应用密码</b><br/>
                        3. 这里的密码请填生成的应用密码，而非坚果云登录密码。
                    </div>

                    <div class="form-group">
                        <label class="form-label">WebDAV 地址</label>
                        <input type="text" class="form-input" id="inputUrl" value="https://dav.jianguoyun.com/dav/">
                    </div>
                    <div class="form-group">
                        <label class="form-label">坚果云账号 (邮箱)</label>
                        <input type="text" class="form-input" id="inputUser" placeholder="your_email@domain.com">
                    </div>
                    <div class="form-group">
                        <label class="form-label">应用密码</label>
                        <input type="password" class="form-input" id="inputPass" placeholder="xxxxxx">
                    </div>
                    <div class="form-group">
                        <label class="form-label">高级：自定义指定数据库名 (逗号隔开)</label>
                        <input type="text" class="form-input" id="inputDbs" placeholder="例如: EVEChatDB, yuyuDB (防自动检测失效)">
                    </div>

                    <button class="btn btn-primary" id="btnSaveSettings">保存配置</button>
                    <div class="status-msg" id="settingsStatus"></div>
                </div>
            </div>
        </div>
    `;
    shadow.appendChild(container);

    // ==========================================
    // 5. UI 交互逻辑绑定
    // ==========================================
    const badge = shadow.getElementById('syncBadge');
    const panel = shadow.getElementById('syncPanel');
    const closeBtn = shadow.getElementById('closeBtn');
    const tabBtns = shadow.querySelectorAll('.tab-btn');
    const tabContents = shadow.querySelectorAll('.tab-content');

    const valIdentifier = shadow.getElementById('valIdentifier');
    const valLastSync = shadow.getElementById('valLastSync');
    const syncStatus = shadow.getElementById('syncStatus');

    const inputUrl = shadow.getElementById('inputUrl');
    const inputUser = shadow.getElementById('inputUser');
    const inputPass = shadow.getElementById('inputPass');
    const inputDbs = shadow.getElementById('inputDbs');
    const btnSaveSettings = shadow.getElementById('btnSaveSettings');
    const settingsStatus = shadow.getElementById('settingsStatus');

    const btnUpload = shadow.getElementById('btnUpload');
    const btnDownload = shadow.getElementById('btnDownload');

    // 初始化显示
    valIdentifier.innerText = BACKUP_FILENAME;
    const lastBackupTime = GM.getValue(`last_backup_time_${IDENTIFIER}`, "");
    if (lastBackupTime) {
        valLastSync.innerText = new Date(lastBackupTime).toLocaleString();
    }

    // 填充配置输入框
    inputUrl.value = GM.getValue("webdav_url", "https://dav.jianguoyun.com/dav/");
    inputUser.value = GM.getValue("webdav_user", "");
    inputPass.value = GM.getValue("webdav_pass", "");
    inputDbs.value = GM.getValue(`custom_dbs_${IDENTIFIER}`, "YuyuChatDB, ClothingRecommendDB");

    // 悬浮球拖拽逻辑 (支持鼠标与触摸)
    let isDragging = false;
    let dragStartX, dragStartY;
    let badgeStartX, badgeStartY;

    function startDrag(clientX, clientY) {
        isDragging = false;
        dragStartX = clientX;
        dragStartY = clientY;
        const rect = badge.getBoundingClientRect();
        badgeStartX = rect.left;
        badgeStartY = rect.top;
    }

    function moveDrag(clientX, clientY) {
        const dx = clientX - dragStartX;
        const dy = clientY - dragStartY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
            isDragging = true;
        }
        if (isDragging) {
            const x = badgeStartX + dx;
            const y = badgeStartY + dy;
            badge.style.left = `${x}px`;
            badge.style.top = `${y}px`;
            badge.style.right = 'auto';
            badge.style.bottom = 'auto';

            const panelWidth = panel.offsetWidth || 320;
            const panelHeight = panel.offsetHeight || 400;
            panel.style.left = `${Math.max(10, x - panelWidth + 42)}px`;
            panel.style.top = `${Math.max(10, y - panelHeight - 10)}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }
    }

    function onMouseMove(e) {
        moveDrag(e.clientX, e.clientY);
    }

    function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }

    badge.addEventListener('mousedown', (e) => {
        startDrag(e.clientX, e.clientY);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    badge.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        startDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    badge.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        moveDrag(e.touches[0].clientX, e.touches[0].clientY);
        if (isDragging) e.preventDefault();
    }, { passive: false });

    badge.addEventListener('touchend', () => {
        isDragging = false;
    });

    // 点击球打开/关闭面板
    badge.addEventListener('click', (e) => {
        if (isDragging) return;
        panel.classList.toggle('show');
    });

    closeBtn.addEventListener('click', () => {
        panel.classList.remove('show');
    });

    // 选项卡切换
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            shadow.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
        });
    });

    // 保存设置
    btnSaveSettings.addEventListener('click', () => {
        GM.setValue("webdav_url", inputUrl.value.trim());
        GM.setValue("webdav_user", inputUser.value.trim());
        GM.setValue("webdav_pass", inputPass.value.trim());
        GM.setValue(`custom_dbs_${IDENTIFIER}`, inputDbs.value.trim());

        davClient.updateConfig();

        settingsStatus.className = "status-msg success";
        settingsStatus.innerText = "配置已保存！";
        setTimeout(() => { settingsStatus.innerText = ""; }, 3000);
    });

    // 一键上传 (导出并上传)
    btnUpload.addEventListener('click', async () => {
        if (!davClient.isConfigured()) {
            showStatus("请先在设置中配置坚果云！", "error");
            return;
        }

        badge.classList.add('syncing');
        btnUpload.disabled = true;
        showStatus("正在收集当前网页缓存数据...", "success");

        try {
            const customDbsStr = GM.getValue(`custom_dbs_${IDENTIFIER}`, "YuyuChatDB, ClothingRecommendDB");
            const customDbNames = customDbsStr ? customDbsStr.split(",").map(s => s.trim()) : [];
            
            const payload = await getFullBackupPayload(customDbNames);
            
            showStatus("正在上传到坚果云...", "success");
            await davClient.upload(payload);

            const now = Date.now();
            GM.setValue(`last_backup_time_${IDENTIFIER}`, now);
            valLastSync.innerText = new Date(now).toLocaleString();

            showStatus("备份成功！已覆盖云端最新版本。", "success");
        } catch (e) {
            console.error(e);
            showStatus(`上传失败: ${e.message}`, "error");
        } finally {
            badge.classList.remove('syncing');
            btnUpload.disabled = false;
        }
    });

    // 一键下载 (下载并还原)
    btnDownload.addEventListener('click', async () => {
        if (!davClient.isConfigured()) {
            showStatus("请先在设置中配置坚果云！", "error");
            return;
        }

        if (!confirm("警告：这会使用云端数据覆盖当前网页的所有缓存（并自动刷新网页），确认继续？")) {
            return;
        }

        badge.classList.add('syncing');
        btnDownload.disabled = true;
        showStatus("正在从坚果云下载最新备份...", "success");

        try {
            const payload = await davClient.download();
            if (!payload) {
                showStatus("未在云端找到该网页的备份文件！", "error");
                return;
            }

            showStatus("下载成功，正在应用缓存数据...", "success");
            await restoreFromPayload(payload);

            showStatus("数据还原完成！即将刷新网页...", "success");
            setTimeout(() => {
                window.location.reload();
            }, 1500);

        } catch (e) {
            console.error(e);
            showStatus(`还原失败: ${e.message}`, "error");
        } finally {
            badge.classList.remove('syncing');
            btnDownload.disabled = false;
        }
    });

    function showStatus(msg, type) {
        syncStatus.className = `status-msg ${type}`;
        syncStatus.innerText = msg;
    }

})();
