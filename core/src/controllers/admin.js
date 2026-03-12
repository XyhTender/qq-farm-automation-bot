const crypto = require('node:crypto');
/**
 * 管理面板 HTTP 服务
 * 改写为接收 DataProvider 模式
 */

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const express = require('express');
const fetch = require('node-fetch');
const { Server: SocketIOServer } = require('socket.io');
const { version } = require('../../package.json');
const { CONFIG } = require('../config/config');
const { getLevelExpProgress } = require('../config/gameConfig');
const { getResourcePath } = require('../config/runtime-paths');
const store = require('../models/store');
const { addOrUpdateAccount, deleteAccount } = store;
const { findAccountByRef, normalizeAccountRef, resolveAccountId } = require('../services/account-resolver');
const { createModuleLogger } = require('../services/logger');
const { MiniProgramLoginSession } = require('../services/qrlogin');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');
const userStore = require('../models/user-store');

const hashPassword = (pwd) => crypto.createHash('sha256').update(String(pwd || '')).digest('hex');
const adminLogger = createModuleLogger('admin');

let app = null;
let server = null;
let provider = null; // DataProvider
let io = null;

function emitRealtimeStatus(accountId, status) {
    if (!io) return;
    const id = String(accountId || '').trim();
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    io.to(`account:${id}`).emit('status:update', { accountId: id, status });
}

function emitRealtimeLog(entry) {
    if (!io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    io.to(`account:${id}`).emit('log:new', payload);
}

function emitRealtimeAccountLog(entry) {
    if (!io) return;
    const payload = (entry && typeof entry === 'object') ? entry : {};
    const id = String(payload.accountId || '').trim();

    // 如果没有指定账号ID，不推送给任何人（防止数据泄露）
    if (!id) return;

    // 推送到特定账号房间（只有订阅了该账号的用户能收到）
    io.to(`account:${id}`).emit('account-log:new', payload);
}

function startAdminServer(dataProvider) {
    if (app) return;
    provider = dataProvider;

    app = express();
    app.use(express.json());

    const tokens = new Set();

    const issueToken = () => crypto.randomBytes(24).toString('hex');
    const authRequired = (req, res, next) => {
        const token = req.headers['x-admin-token'];
        if (!token || !tokens.has(token)) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
        req.adminToken = token;
        req.currentUser = tokenUserMap.get(token);

        // 管理员不检查封禁和过期
        if (req.currentUser && req.currentUser.role !== 'admin') {
            // 检查用户状态（每次请求都检查）
            if (req.currentUser.card) {
                // 检查是否被封禁
                if (req.currentUser.card.enabled === false) {
                    console.log('[请求拒绝] 用户已被封禁:', req.currentUser.username);
                    tokens.delete(token);
                    tokenUserMap.delete(token);
                    return res.status(403).json({ ok: false, error: '账号已被封禁，请联系管理员' });
                }

                // 检查是否过期
                if (req.currentUser.card.expiresAt) {
                    const now = Date.now();
                    if (req.currentUser.card.expiresAt < now) {
                        console.log('[请求拒绝] 用户已过期:', req.currentUser.username);
                        tokens.delete(token);
                        tokenUserMap.delete(token);
                        return res.status(403).json({ ok: false, error: '账号已过期，请续费后重新登录' });
                    }
                }
            }
        }

        next();
    };

    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, x-account-id, x-admin-token, x-proxy-api-key, x-proxy-api-url, x-proxy-app-id');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    const webDist = path.join(__dirname, '../../../web/dist');
    if (fs.existsSync(webDist)) {
        app.use(express.static(webDist));
    } else {
        adminLogger.warn('web build not found', { webDist });
        app.get('/', (req, res) => res.send('web build not found. Please build the web project.'));
    }
    app.use('/game-config', express.static(getResourcePath('gameConfig')));

    // Token 到用户映射（用于用户系统）
    const tokenUserMap = new Map();

    // 检查用户是否有权访问（管理员或普通用户）
    const checkUserAccess = (req, res, next) => {
        const token = req.headers['x-admin-token'];
        if (!token || !tokens.has(token)) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
        req.adminToken = token;
        req.currentUser = tokenUserMap.get(token);

        // 管理员不检查封禁和过期
        if (req.currentUser && req.currentUser.role !== 'admin') {
            // 检查用户状态（每次请求都检查）
            if (req.currentUser.card) {
                // 检查是否被封禁
                if (req.currentUser.card.enabled === false) {
                    console.log('[请求拒绝] 用户已被封禁:', req.currentUser.username);
                    tokens.delete(token);
                    tokenUserMap.delete(token);
                    return res.status(403).json({ ok: false, error: '账号已被封禁，请联系管理员' });
                }

                // 检查是否过期
                if (req.currentUser.card.expiresAt) {
                    const now = Date.now();
                    if (req.currentUser.card.expiresAt < now) {
                        console.log('[请求拒绝] 用户已过期:', req.currentUser.username);
                        tokens.delete(token);
                        tokenUserMap.delete(token);
                        return res.status(403).json({ ok: false, error: '账号已过期，请续费后重新登录' });
                    }
                }
            }
        }

        next();
    };

    // 定期清理过期用户（每5分钟检查一次）
    const cleanupExpiredUsers = () => {
        const now = Date.now();
        const usersToCleanup = [];

        for (const [token, user] of tokenUserMap.entries()) {
            if (user.role === 'admin') continue; // 管理员不检查

            // 检查是否被封禁
            if (user.card && user.card.enabled === false) {
                console.log(`[自动检查] 用户 ${user.username} 已被封禁，执行清理...`);
                usersToCleanup.push({ token, username: user.username, reason: 'banned' });
                continue;
            }

            // 检查是否过期
            if (user.card && user.card.expiresAt && user.card.expiresAt < now) {
                console.log(`[自动检查] 用户 ${user.username} 已过期，执行清理...`);
                usersToCleanup.push({ token, username: user.username, reason: 'expired' });
            }
        }

        for (const { token, username, reason } of usersToCleanup) {
            tokens.delete(token);
            tokenUserMap.delete(token);
            // 断开相关 socket 连接
            if (io) {
                for (const socket of io.sockets.sockets.values()) {
                    if (String(socket.data.adminToken || '') === String(token)) {
                        socket.disconnect(true);
                    }
                }
            }
            console.log(`[自动清理] 用户 ${username} 已${reason === 'banned' ? '被封禁' : '过期'}，已强制下线`);
        }
    };

    // 启动定期清理
    setInterval(cleanupExpiredUsers, 5 * 60 * 1000); // 每5分钟检查一次

    // 登录与鉴权
    app.post('/api/login', (req, res) => {
        const { username, password } = req.body || {};

        // 如果提供了用户名，使用用户系统登录
        if (username && password) {
            const user = userStore.validateUser(username, password);
            if (!user) {
                return res.status(401).json({ ok: false, error: '用户名或密码错误' });
            }

            console.log('[登录检查] 用户:', username, '角色:', user.role, '卡密信息:', user.card);

            // 管理员不检查封禁和过期
            if (user.role !== 'admin') {
                // 检查用户是否被封禁
                if (user.card && user.card.enabled === false) {
                    console.log('[登录拒绝] 用户已被封禁:', username);
                    return res.status(403).json({ ok: false, error: '账号已被封禁，请联系管理员' });
                }

                // 检查是否过期（仅对非永久卡）
                if (user.card && user.card.expiresAt) {
                    const now = Date.now();
                    if (user.card.expiresAt < now) {
                        console.log('[登录拒绝] 用户已过期:', username);
                        return res.status(403).json({ ok: false, error: '账号已过期，请续费后重新登录' });
                    }
                }
            }

            const token = issueToken();
            tokens.add(token);
            tokenUserMap.set(token, user);
            console.log('[登录成功]', username, '角色:', user.role);
            return res.json({ 
                ok: true, 
                data: { 
                    token, 
                    role: user.role, 
                    card: user.card, 
                    accountLimit: user.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2,
                    user: { username: user.username } 
                } 
            });
        }

        // 兼容旧版：仅密码登录（管理员）
        const input = String(password || '');
        const storedHash = store.getAdminPasswordHash ? store.getAdminPasswordHash() : '';
        let ok = false;
        if (storedHash) {
            ok = hashPassword(input) === storedHash;
        } else {
            ok = input === String(CONFIG.adminPassword || '');
        }
        if (!ok) {
            return res.status(401).json({ ok: false, error: 'Invalid password' });
        }
        const token = issueToken();
        tokens.add(token);
        // 旧版登录也创建用户对象（管理员）
        const adminUser = { username: 'admin', role: 'admin', card: null, accountLimit: -1 };
        tokenUserMap.set(token, adminUser);
        res.json({ ok: true, data: { token, role: 'admin', card: null, accountLimit: -1, user: { username: 'admin' } } });
    });

    // 注册接口
    app.post('/api/register', (req, res) => {
        const { username, password, cardCode } = req.body || {};
        if (!username || !password || !cardCode) {
            return res.status(400).json({ ok: false, error: '请填写完整信息' });
        }
        const result = userStore.registerUser(username, password, cardCode);
        if (!result.ok) {
            return res.status(400).json(result);
        }
        res.json({ ok: true, data: result.user });
    });

    // 查询卡密信息接口（用于续费前预览）
    app.get('/api/card/info/:code', (req, res) => {
        try {
            const { code } = req.params;
            const cards = userStore.getAllCards();
            const card = cards.find(c => c.code === code);
            
            if (!card) {
                return res.status(404).json({ ok: false, error: '卡密不存在' });
            }
            
            if (!card.enabled) {
                return res.status(400).json({ ok: false, error: '卡密已被禁用' });
            }
            
            if (card.usedBy) {
                return res.status(400).json({ ok: false, error: '卡密已被使用' });
            }
            
            res.json({ 
                ok: true, 
                data: {
                    type: card.type || 'time',
                    days: card.days,
                    description: card.description
                }
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 用户续费接口
    app.post('/api/user/renew', checkUserAccess, (req, res) => {
        const { cardCode } = req.body || {};
        const username = req.currentUser?.username;

        if (!username) {
            return res.status(401).json({ ok: false, error: '未登录' });
        }

        if (!cardCode) {
            return res.status(400).json({ ok: false, error: '请提供卡密' });
        }

        const result = userStore.renewUser(username, cardCode);
        if (!result.ok) {
            return res.status(400).json(result);
        }

        // 更新 token 中的用户信息
        for (const [token, user] of tokenUserMap.entries()) {
            if (user.username === username) {
                user.card = result.card;
                user.accountLimit = result.accountLimit;
                tokenUserMap.set(token, user);
                break;
            }
        }

        res.json({ ok: true, data: { card: result.card, accountLimit: result.accountLimit, cardType: result.cardType } });
    });

    // 修改密码接口
    app.post('/api/user/change-password', checkUserAccess, (req, res) => {
        const { oldPassword, newPassword } = req.body || {};
        const username = req.currentUser?.username;

        if (!username) {
            return res.status(401).json({ ok: false, error: '未登录' });
        }

        if (!oldPassword || !newPassword) {
            return res.status(400).json({ ok: false, error: '请提供原密码和新密码' });
        }

        const result = userStore.changePassword(username, oldPassword, newPassword);
        res.json(result);
    });

    app.use('/api', (req, res, next) => {
        if (req.path === '/login' || req.path === '/qr/create' || req.path === '/qr/check' || req.path === '/proxy') return next();
        return authRequired(req, res, next);
    });

    // 管理员密码修改已移除，统一使用 /api/user/change-password 接口

    app.get('/api/ping', (req, res) => {
        res.json({ ok: true, data: { ok: true, uptime: process.uptime(), version } });
    });

    app.get('/api/auth/validate', (req, res) => {
        res.json({ ok: true, data: { valid: true } });
    });

    // API: 调度任务快照（用于调度收敛排查）
    app.get('/api/scheduler', async (req, res) => {
        try {
            const id = getAccId(req);

            // 检查权限（如果指定了账号ID）
            if (id && !checkAccountAccess(req, id)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            if (provider && typeof provider.getSchedulerStatus === 'function') {
                const data = await provider.getSchedulerStatus(id);
                return res.json({ ok: true, data });
            }
            return res.json({ ok: true, data: { runtime: getSchedulerRegistrySnapshot(), worker: null, workerError: 'DataProvider does not support scheduler status' } });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    app.post('/api/logout', (req, res) => {
        const token = req.adminToken;
        if (token) {
            tokens.delete(token);
            tokenUserMap.delete(token);
            if (io) {
                for (const socket of io.sockets.sockets.values()) {
                    if (String(socket.data.adminToken || '') === String(token)) {
                        socket.disconnect(true);
                    }
                }
            }
        }
        res.json({ ok: true });
    });

    const getAccountList = (username = null) => {
        try {
            if (provider && typeof provider.getAccounts === 'function') {
                const data = provider.getAccounts();
                if (data && Array.isArray(data.accounts)) {
                    // 如果指定了用户名，只返回该用户的账号
                    if (username) {
                        return data.accounts.filter(a => a.username === username);
                    }
                    return data.accounts;
                }
            }
        } catch {
            // ignore provider failures
        }
        const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
        let accounts = Array.isArray(data.accounts) ? data.accounts : [];
        // 如果指定了用户名，只返回该用户的账号
        if (username) {
            accounts = accounts.filter(a => a.username === username);
        }
        return accounts;
    };

    // 检查用户是否有权访问指定账号
    const checkAccountAccess = (req, accountId) => {
        const currentUser = req.currentUser;
        if (!currentUser) return false;
        // 管理员可以访问所有账号
        if (currentUser.role === 'admin') return true;
        // 普通用户只能访问自己的账号
        const accounts = getAccountList();
        const account = accounts.find(a => a.id === accountId);
        if (!account) return false;
        return account.username === currentUser.username;
    };

    // 获取当前用户可访问的账号ID列表
    const getAccessibleAccountIds = (req) => {
        const currentUser = req.currentUser;
        if (!currentUser) return [];
        // 管理员可以访问所有账号
        if (currentUser.role === 'admin') {
            const accounts = getAccountList();
            return accounts.map(a => a.id);
        }
        // 普通用户只能访问自己的账号
        const accounts = getAccountList(currentUser.username);
        return accounts.map(a => a.id);
    };

    // 根据用户对象获取可访问的账号ID列表（用于WebSocket）
    const getAccessibleAccountIdsForUser = (user) => {
        if (!user) return [];
        // 管理员可以访问所有账号
        if (user.role === 'admin') {
            const accounts = getAccountList();
            return accounts.map(a => a.id);
        }
        // 普通用户只能访问自己的账号
        const accounts = getAccountList(user.username);
        return accounts.map(a => a.id);
    };

    const isSoftRuntimeError = (err) => {
        const msg = String((err && err.message) || '');
        return msg === '账号未运行' || msg === 'API Timeout';
    };

    function handleApiError(res, err) {
        if (isSoftRuntimeError(err)) {
            return res.json({ ok: false, error: err.message });
        }
        return res.status(500).json({ ok: false, error: err.message });
    }

    const resolveAccId = (rawRef) => {
        const input = normalizeAccountRef(rawRef);
        if (!input) return '';

        if (provider && typeof provider.resolveAccountId === 'function') {
            const resolvedByProvider = normalizeAccountRef(provider.resolveAccountId(input));
            if (resolvedByProvider) return resolvedByProvider;
        }

        const resolved = resolveAccountId(getAccountList(), input);
        return resolved || input;
    };

    // Helper to get account ID from header
    function getAccId(req) {
        return resolveAccId(req.headers['x-account-id']);
    }

    // API: 完整状态
    app.get('/api/status', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = provider.getStatus(id);
            if (data && data.status) {
                const { level, exp } = data.status;
                const progress = getLevelExpProgress(level, exp);
                data.levelProgress = progress;
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    app.post('/api/automation', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            let lastData = null;
            for (const [k, v] of Object.entries(req.body)) {
                lastData = await provider.setAutomation(id, k, v);
            }
            res.json({ ok: true, data: lastData || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/fertilizer/buy', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const type = String(req.body?.type || 'organic');
            const count = Number(req.body?.count) || 0;
            const bought = await provider.buyFertilizer(id, type, count);
            res.json({ ok: true, bought });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 农田详情
    app.get('/api/lands', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getLands(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 好友列表
    app.get('/api/friends', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const forceSync = req.query.forceSync === 'true';

        try {
            const data = await provider.getFriends(id, forceSync);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // 访客
    app.get('/api/interact-records', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        try {
            const data = await provider.getInteractRecords(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });
    // API: 好友农田详情
    app.get('/api/friend/:gid/lands', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getFriendLands(id, req.params.gid);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 对指定好友执行单次操作（偷菜/浇水/除草/捣乱）
    app.post('/api/friend/:gid/op', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const opType = String((req.body || {}).opType || '');
            const data = await provider.doFriendOp(id, req.params.gid, opType);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 好友批量操作（一键帮助/一键偷取/一键捣乱）
    app.post('/api/friends/batch-op', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const opType = String((req.body || {}).opType || '');
            if (!opType) {
                return res.status(400).json({ ok: false, error: '缺少 opType 参数' });
            }
            const data = await provider.doBatchFriendOp(id, opType);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 好友黑名单
    app.get('/api/friend-blacklist', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const list = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
        res.json({ ok: true, data: list });
    });

    app.post('/api/friend-blacklist/toggle', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const gid = Number((req.body || {}).gid);
        if (!gid) return res.status(400).json({ ok: false, error: 'Missing gid' });
        const current = store.getFriendBlacklist ? store.getFriendBlacklist(id) : [];
        let next;
        if (current.includes(gid)) {
            next = current.filter(g => g !== gid);
        } else {
            next = [...current, gid];
        }
        const saved = store.setFriendBlacklist ? store.setFriendBlacklist(id, next) : next;
        // 同步配置到 worker 进程
        if (provider && typeof provider.broadcastConfig === 'function') {
            provider.broadcastConfig(id);
        }
        res.json({ ok: true, data: saved });
    });

    // ============ 好友GID管理 API ============
    function buildKnownFriendGidSettings(accountId) {
        return {
            knownFriendGids: store.getKnownFriendGids ? store.getKnownFriendGids(accountId) : [],
            knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec
                ? store.getKnownFriendGidSyncCooldownSec(accountId)
                : 600,
        };
    }

    // 获取已知好友GID设置
    app.get('/api/friend-known-gids', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // 保存已知好友GID设置
    app.post('/api/friend-known-gids', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            if (body.knownFriendGids !== undefined && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, body.knownFriendGids);
            }
            if (body.knownFriendGidSyncCooldownSec !== undefined && store.setKnownFriendGidSyncCooldownSec) {
                store.setKnownFriendGidSyncCooldownSec(id, body.knownFriendGidSyncCooldownSec);
            }
            // 同步配置到 worker 进程
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // 添加单个好友GID
    app.post('/api/friend-known-gids/add', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const gid = Number((req.body || {}).gid);
        if (!Number.isFinite(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: 'GID 无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const next = Array.isArray(current) ? [...current, gid] : [gid];
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            const cooldownSec = (req.body || {}).knownFriendGidSyncCooldownSec;
            if (cooldownSec !== undefined && store.setKnownFriendGidSyncCooldownSec) {
                store.setKnownFriendGidSyncCooldownSec(id, cooldownSec);
            }
            // 同步配置到 worker 进程
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // 移除单个好友GID
    app.post('/api/friend-known-gids/remove', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const gid = Number((req.body || {}).gid);
        if (!Number.isFinite(gid) || gid <= 0) {
            return res.status(400).json({ ok: false, error: 'GID 无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const next = Array.isArray(current) ? current.filter(item => Number(item) !== gid) : [];
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(id);
            }
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id) });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // 批量添加好友GID
    app.post('/api/friend-known-gids/batch-add', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.status(400).json({ ok: false, error: 'GID 列表无效' });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const currentSet = new Set(current.map(Number));
            let addedCount = 0;
            for (const gid of gids) {
                const num = Number(gid);
                if (!Number.isFinite(num) || num <= 0) continue;
                if (!currentSet.has(num)) {
                    currentSet.add(num);
                    addedCount++;
                }
            }
            const next = Array.from(currentSet);
            if (store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }
            // 同步配置到 worker 进程
            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(id);
            }
            return res.json({ 
                ok: true, 
                data: buildKnownFriendGidSettings(id),
                addedCount,
            });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // 批量删除未同步的好友GID
    app.post('/api/friend-known-gids/batch-remove', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        const gids = (req.body || {}).gids;
        if (!Array.isArray(gids) || gids.length === 0) {
            return res.json({ ok: true, data: buildKnownFriendGidSettings(id), removedCount: 0 });
        }

        try {
            const current = store.getKnownFriendGids ? store.getKnownFriendGids(id) : [];
            const removeSet = new Set(gids.map(Number).filter(n => Number.isFinite(n) && n > 0));
            const next = current.filter(gid => !removeSet.has(Number(gid)));
            const removedCount = current.length - next.length;

            if (removedCount > 0 && store.setKnownFriendGids) {
                store.setKnownFriendGids(id, next);
            }

            return res.json({ 
                ok: true, 
                data: buildKnownFriendGidSettings(id),
                removedCount,
            });
        } catch (e) {
            return handleApiError(res, e);
        }
    });

    // API: 蔬菜黑名单
    app.get('/api/plant-blacklist', authRequired, (req, res) => {
        try {
            const accountId = getAccId(req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const list = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: list });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.post('/api/plant-blacklist', authRequired, (req, res) => {
        try {
            const accountId = getAccId(req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const seedId = Number((req.body || {}).seedId);
            if (!seedId) return res.status(400).json({ ok: false, error: 'Missing seedId' });

            const current = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];

            if (!current.includes(seedId)) {
                const next = [...current, seedId];
                if (store.setPlantBlacklist) {
                    store.setPlantBlacklist(accountId, next);
                }
            }

            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(accountId);
            }

            const saved = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: saved });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    app.delete('/api/plant-blacklist/:seedId', authRequired, (req, res) => {
        try {
            const accountId = getAccId(req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing accountId' });

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const seedId = Number(req.params.seedId);
            if (!seedId) return res.status(400).json({ ok: false, error: 'Missing seedId' });

            const current = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            const next = current.filter(id => id !== seedId);

            if (store.setPlantBlacklist) {
                store.setPlantBlacklist(accountId, next);
            }

            if (provider && typeof provider.broadcastConfig === 'function') {
                provider.broadcastConfig(accountId);
            }

            const saved = store.getPlantBlacklist ? store.getPlantBlacklist(accountId) : [];
            res.json({ ok: true, data: saved });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 种子列表
    app.get('/api/seeds', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getSeeds(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 背包物品
    app.get('/api/bag', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getBag(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 使用背包物品
    app.post('/api/bag/use', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const { itemId, count } = req.body;
            if (!itemId) return res.status(400).json({ ok: false, error: '缺少 itemId' });
            const data = await provider.useItem(id, Number(itemId), Math.max(1, Number(count) || 1));
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 出售背包物品
    app.post('/api/bag/sell', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const { items } = req.body;
            if (!Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ ok: false, error: '缺少出售物品列表' });
            }
            const data = await provider.sellItems(id, items);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 获取背包种子列表
    app.get('/api/bag/seeds', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getBagSeeds(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 每日礼包状态总览
    app.get('/api/daily-gifts', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.getDailyGifts(id);
            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 启动账号
    app.post('/api/accounts/:id/start', (req, res) => {
        try {
            const accountId = resolveAccId(req.params.id);

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const ok = provider.startAccount(accountId);
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 停止账号
    app.post('/api/accounts/:id/stop', (req, res) => {
        try {
            const accountId = resolveAccId(req.params.id);

            // 检查权限
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const ok = provider.stopAccount(accountId);
            if (!ok) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 农场一键操作
    app.post('/api/farm/operate', async (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const { opType } = req.body; // 'harvest', 'clear', 'plant', 'all'
            await provider.doFarmOp(id, opType);
            res.json({ ok: true });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // API: 数据分析
    app.get('/api/analytics', async (req, res) => {
        try {
            const sortBy = req.query.sort || 'exp';
            const { getPlantRankings } = require('../services/analytics');
            const data = getPlantRankings(sortBy);
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 设置页统一保存（单次写入+单次广播）
    app.post('/api/settings/save', async (req, res) => {
        const id = getAccId(req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await provider.saveSettings(id, req.body || {});
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 设置面板主题
    app.post('/api/settings/theme', async (req, res) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 保存下线提醒配置
    app.post('/api/settings/offline-reminder', async (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const currentUser = req.currentUser;

            // 必须登录才能保存下线提醒配置
            if (!currentUser) {
                return res.status(401).json({ ok: false, error: '未登录' });
            }

            // 保存到用户隔离的配置中
            const data = store.setOfflineReminder
                ? store.setOfflineReminder(body, currentUser.username)
                : {};
            res.json({ ok: true, data: data || {} });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 测试下线提醒推送（不落盘）
    app.post('/api/settings/offline-reminder/test', async (req, res) => {
        try {
            const currentUser = req.currentUser;
            const saved = store.getOfflineReminder && currentUser
                ? store.getOfflineReminder(currentUser.username)
                : {};
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const cfg = { ...(saved || {}), ...body };

            const channel = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const token = String(cfg.token || '').trim();
            const titleBase = String(cfg.title || '账号下线提醒').trim();
            const msgBase = String(cfg.msg || '账号下线').trim();

            if (!channel) {
                return res.status(400).json({ ok: false, error: '推送渠道不能为空' });
            }
            if (channel === 'webhook' && !endpoint) {
                return res.status(400).json({ ok: false, error: 'Webhook 渠道需要填写接口地址' });
            }

            const now = new Date();
            const ts = now.toISOString().replace('T', ' ').slice(0, 19);
            const { sendPushooMessage } = require('../services/push');
            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                title: `${titleBase}（测试）`,
                content: `${msgBase}\n\n这是一条下线提醒测试消息。\n时间: ${ts}`,
            });

            if (!ret) {
                return res.status(400).json({ ok: false, error: '推送失败：无返回结果' });
            }
            
            const isSuccess = ret.ok || 
                ret.code === 'ok' || 
                ret.code === '0' || 
                String(ret.msg || '').includes('成功') ||
                String(ret.raw?.status || '').toLowerCase() === 'success';
            
            if (!isSuccess && ret.msg && !String(ret.msg).includes('成功')) {
                return res.status(400).json({ ok: false, error: ret.msg || '推送失败', data: ret });
            }
            return res.json({ ok: true, data: ret, message: ret.msg || '推送成功' });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 获取配置
    app.get('/api/settings', async (req, res) => {
        try {
            const id = getAccId(req);
            const currentUser = req.currentUser;

            // 检查权限（如果指定了账号ID）
            if (id && !checkAccountAccess(req, id)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            // 直接从主进程的 store 读取，确保即使账号未运行也能获取配置
            const intervals = store.getIntervals(id);
            const strategy = store.getPlantingStrategy(id);
            const preferredSeed = store.getPreferredSeed(id);
            const friendQuietHours = store.getFriendQuietHours(id);
            const automation = store.getAutomation(id);
            const stealDelaySeconds = (typeof store.getStealDelaySeconds === 'function') ? store.getStealDelaySeconds(id) : 0;
            const plantOrderRandom = (typeof store.getPlantOrderRandom === 'function') ? store.getPlantOrderRandom(id) : false;
            const plantDelaySeconds = (typeof store.getPlantDelaySeconds === 'function') ? store.getPlantDelaySeconds(id) : 0;
            const fertilizerBuyType = (typeof store.getFertilizerBuyType === 'function') ? store.getFertilizerBuyType(id) : 'organic';
            const fertilizerBuyCount = (typeof store.getFertilizerBuyCount === 'function') ? store.getFertilizerBuyCount(id) : 0;
            const bagSeedPriority = (typeof store.getBagSeedPriority === 'function') ? store.getBagSeedPriority(id) : [];
            const bagSeedFallbackStrategy = (typeof store.getBagSeedFallbackStrategy === 'function') ? store.getBagSeedFallbackStrategy(id) : 'level';
            const ui = store.getUI();
            // 获取用户隔离的下线提醒配置
            const offlineReminder = store.getOfflineReminder && currentUser
                ? store.getOfflineReminder(currentUser.username)
                : { channel: 'webhook', reloginUrlMode: 'none', endpoint: '', token: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 0 };
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, friendQuietHours, automation, stealDelaySeconds, plantOrderRandom, plantDelaySeconds, fertilizerBuyType, fertilizerBuyCount, bagSeedPriority, bagSeedFallbackStrategy, ui, offlineReminder } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 获取默认配置
    app.get('/api/settings/default', (req, res) => {
        try {
            const defaultConfig = store.getDefaultAccountConfig ? store.getDefaultAccountConfig() : null;
            if (!defaultConfig) {
                return res.status(500).json({ ok: false, error: '无法获取默认配置' });
            }
            res.json({ ok: true, data: defaultConfig });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 管理员权限中间件 ============
    const adminRequired = (req, res, next) => {
        if (!req.currentUser || req.currentUser.role !== 'admin') {
            return res.status(403).json({ ok: false, error: '需要管理员权限' });
        }
        next();
    };

    // ============ 公告管理 API ============
    // 获取公告（所有用户可访问）
    app.get('/api/announcement', authRequired, (req, res) => {
        try {
            const currentUser = req.currentUser;
            const announcement = store.getAnnouncement();
            const shouldShow = store.shouldShowAnnouncement(currentUser?.username);
            res.json({
                ok: true,
                data: {
                    ...announcement,
                    shouldShow,
                },
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 标记公告已读
    app.post('/api/announcement/read', authRequired, (req, res) => {
        try {
            const currentUser = req.currentUser;
            if (currentUser?.username) {
                store.markAnnouncementRead(currentUser.username);
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 设置公告（仅管理员）
    app.post('/api/admin/announcement', authRequired, adminRequired, (req, res) => {
        try {
            const { content, showOnce } = req.body || {};
            const announcement = store.setAnnouncement(content, showOnce);
            res.json({ ok: true, data: announcement });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 卡密管理 API（仅管理员） ============

    // 获取所有卡密
    app.get('/api/admin/cards', authRequired, adminRequired, (req, res) => {
        try {
            const cards = userStore.getAllCards();
            res.json({ ok: true, data: cards });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 创建卡密
    app.post('/api/admin/cards', authRequired, adminRequired, (req, res) => {
        try {
            const { description, days, count, type } = req.body || {};
            if (!description || days === undefined) {
                return res.status(400).json({ ok: false, error: '请提供描述和天数' });
            }
            
            const cardType = type === 'quota' ? 'quota' : 'time';
            
            // 批量创建
            if (count && Number.parseInt(count, 10) > 1) {
                const cards = userStore.createCardsBatch(description, days, count, cardType);
                return res.json({ ok: true, data: cards, batch: true, count: cards.length });
            }
            
            const card = userStore.createCard(description, days, cardType);
            res.json({ ok: true, data: card });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 批量删除卡密（必须放在 /:code 路由之前，避免被当作 code 参数）
    app.post('/api/admin/cards/batch-delete', authRequired, adminRequired, (req, res) => {
        try {
            const { codes } = req.body || {};
            if (!Array.isArray(codes) || codes.length === 0) {
                return res.status(400).json({ ok: false, error: '请提供要删除的卡密列表' });
            }
            const result = userStore.deleteCardsBatch(codes);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 更新卡密
    app.post('/api/admin/cards/:code', authRequired, adminRequired, (req, res) => {
        try {
            const { code } = req.params;
            const updates = req.body || {};
            const card = userStore.updateCard(code, updates);
            if (!card) {
                return res.status(404).json({ ok: false, error: '卡密不存在' });
            }
            res.json({ ok: true, data: card });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 删除卡密
    app.delete('/api/admin/cards/:code', authRequired, adminRequired, (req, res) => {
        try {
            const { code } = req.params;
            const ok = userStore.deleteCard(code);
            if (!ok) {
                return res.status(404).json({ ok: false, error: '卡密不存在' });
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 用户管理 API（仅管理员） ============
    // 获取所有用户
    app.get('/api/admin/users', authRequired, adminRequired, (req, res) => {
        try {
            const users = userStore.getAllUsers();
            res.json({ ok: true, data: users });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 获取所有用户（带密码，仅管理员）
    app.get('/api/admin/users-with-password', authRequired, adminRequired, (req, res) => {
        try {
            const users = userStore.getAllUsersWithPassword();
            res.json({ ok: true, data: users });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 更新用户
    app.post('/api/admin/users/:username', authRequired, adminRequired, (req, res) => {
        try {
            const { username } = req.params;
            const updates = req.body || {};
            const user = userStore.updateUser(username, updates);
            if (!user) {
                return res.status(404).json({ ok: false, error: '用户不存在' });
            }
            res.json({ ok: true, data: user });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 编辑用户（管理员编辑用户信息）
    app.post('/api/admin/users/:username/edit', authRequired, adminRequired, (req, res) => {
        try {
            const { username } = req.params;
            const { newUsername, password, accountLimit, expiresAt, isPermanent } = req.body || {};
            
            const result = userStore.editUser(username, {
                newUsername,
                password,
                accountLimit,
                expiresAt,
                isPermanent
            });
            
            if (!result.ok) {
                return res.status(400).json(result);
            }

            // 更新该用户所有会话中的信息
            for (const [token, user] of tokenUserMap.entries()) {
                if (user.username === username || user.username === newUsername) {
                    user.username = result.user.username;
                    user.card = result.user.card;
                    user.accountLimit = result.user.accountLimit;
                    tokenUserMap.set(token, user);
                }
            }

            res.json({ ok: true, data: result.user });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 删除用户
    app.delete('/api/admin/users/:username', authRequired, adminRequired, (req, res) => {
        try {
            const { username } = req.params;
            const result = userStore.deleteUser(username);
            if (!result.ok) {
                return res.status(400).json(result);
            }
            // 强制下线该用户的所有会话
            for (const [token, user] of tokenUserMap.entries()) {
                if (user.username === username) {
                    tokens.delete(token);
                    tokenUserMap.delete(token);
                    if (io) {
                        for (const socket of io.sockets.sockets.values()) {
                            if (String(socket.data.adminToken || '') === String(token)) {
                                socket.disconnect(true);
                            }
                        }
                    }
                }
            }
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 管理员为用户续费
    app.post('/api/admin/users/:username/renew', authRequired, adminRequired, (req, res) => {
        try {
            const { username } = req.params;
            const { cardCode } = req.body || {};

            if (!cardCode) {
                return res.status(400).json({ ok: false, error: '请提供卡密' });
            }

            const result = userStore.renewUser(username, cardCode);
            if (!result.ok) {
                return res.status(400).json(result);
            }

            // 更新该用户所有会话中的卡密信息
            for (const [token, user] of tokenUserMap.entries()) {
                if (user.username === username) {
                    user.card = result.card;
                    user.accountLimit = result.accountLimit;
                    tokenUserMap.set(token, user);
                }
            }

            res.json({ ok: true, data: { card: result.card, accountLimit: result.accountLimit, cardType: result.cardType } });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 获取当前登录用户信息
    app.get('/api/user/me', authRequired, (req, res) => {
        try {
            const user = req.currentUser;
            if (!user) {
                return res.status(401).json({ ok: false, error: '未登录' });
            }
            res.json({
                ok: true,
                data: {
                    username: user.username,
                    role: user.role,
                    card: user.card,
                    accountLimit: user.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2
                }
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 保存用户微信登录配置
    app.post('/api/user/wxlogin-config', authRequired, (req, res) => {
        try {
            const user = req.currentUser;
            if (!user) {
                return res.status(401).json({ ok: false, error: '未登录' });
            }

            const config = req.body || {};
            const result = userStore.saveWxLoginConfig(user.username, config);

            if (!result.ok) {
                return res.status(400).json(result);
            }

            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // 获取用户微信登录配置
    app.get('/api/user/wxlogin-config', authRequired, (req, res) => {
        try {
            const user = req.currentUser;
            if (!user) {
                return res.status(401).json({ ok: false, error: '未登录' });
            }

            const result = userStore.getWxLoginConfig(user.username);

            if (!result.ok) {
                return res.status(400).json(result);
            }

            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 账号管理
    app.get('/api/accounts', (req, res) => {
        try {
            const currentUser = req.currentUser;
            let data;

            if (currentUser) {
                // 管理员可以看到所有账号，普通用户只能看到自己的账号
                const allAccounts = provider.getAccounts();
                if (currentUser.role === 'admin') {
                    data = allAccounts;
                } else {
                    data = {
                        ...allAccounts,
                        accounts: allAccounts.accounts.filter(a => a.username === currentUser.username)
                    };
                }
            } else {
                // 未登录用户返回空列表
                data = { accounts: [], nextId: 1 };
            }

            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = getAccountList();
            const target = findAccountByRef(accountList, rawRef);
            if (!target || !target.id) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }

            const accountId = String(target.id);
            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (provider && typeof provider.setRuntimeAccountName === 'function') {
                provider.setRuntimeAccountName(accountId, remark);
            }
            if (provider && provider.addAccountLog) {
                provider.addAccountLog('update', `更新账号备注: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/accounts', (req, res) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const currentUser = req.currentUser;
            const isUpdate = !!body.id;

            // 检查权限：普通用户只能更新自己的账号
            if (isUpdate && currentUser && currentUser.role !== 'admin') {
                if (!checkAccountAccess(req, resolveAccId(body.id))) {
                    return res.status(403).json({ ok: false, error: '无权访问此账号' });
                }
            }

            // 检查额度：新增账号时检查用户额度限制
            if (!isUpdate && currentUser && currentUser.role !== 'admin') {
                const userAccounts = getAccountList(currentUser.username);
                const currentCount = userAccounts.length;
                const accountLimit = currentUser.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2;
                
                if (currentCount >= accountLimit) {
                    return res.status(403).json({ 
                        ok: false, 
                        error: `账号数量已达上限（${accountLimit}个），请购买额度卡密增加额度` 
                    });
                }
            }

            const resolvedUpdateId = isUpdate ? resolveAccId(body.id) : '';
            const payload = isUpdate ? { ...body, id: resolvedUpdateId || String(body.id) } : body;
            let wasRunning = false;
            if (isUpdate && provider.isAccountRunning) {
                wasRunning = provider.isAccountRunning(payload.id);
            }

            // 检查是否仅修改了备注信息
            let onlyRemarkChanged = false;
            if (isUpdate) {
                const oldAccounts = provider.getAccounts();
                const oldAccount = oldAccounts.accounts.find(a => a.id === payload.id);
                if (oldAccount) {
                    // 检查 payload 中是否只包含 id 和 name 字段
                    const payloadKeys = Object.keys(payload);
                    const onlyIdAndName = payloadKeys.length === 2 && payloadKeys.includes('id') && payloadKeys.includes('name');
                    if (onlyIdAndName) {
                        onlyRemarkChanged = true;
                    }
                }
            }

            // 如果是新增账号，自动关联当前用户
            if (!isUpdate && currentUser) {
                payload.username = currentUser.username;
            }

            const data = addOrUpdateAccount(payload);
            if (provider.addAccountLog) {
                const accountId = isUpdate ? String(payload.id) : String((data.accounts[data.accounts.length - 1] || {}).id || '');
                const accountName = payload.name || '';
                provider.addAccountLog(
                    isUpdate ? 'update' : 'add',
                    isUpdate ? `更新账号: ${accountName || accountId}` : `添加账号: ${accountName || accountId}`,
                    accountId,
                    accountName
                );
            }
            // 如果是新增，自动启动
            if (!isUpdate) {
                const newAcc = data.accounts[data.accounts.length - 1];
                if (newAcc) provider.startAccount(newAcc.id);
            } else if (wasRunning && !onlyRemarkChanged) {
                // 如果是更新，且之前在运行，且不是仅修改备注，则重启
                provider.restartAccount(payload.id);
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.delete('/api/accounts/:id', (req, res) => {
        try {
            const resolvedId = resolveAccId(req.params.id) || String(req.params.id || '');

            // 检查权限
            if (!checkAccountAccess(req, resolvedId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const before = provider.getAccounts();
            const target = findAccountByRef(before.accounts || [], req.params.id);
            provider.stopAccount(resolvedId);
            const data = deleteAccount(resolvedId);
            if (provider.addAccountLog) {
                provider.addAccountLog('delete', `删除账号: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 账号日志
    app.get('/api/account-logs', (req, res) => {
        try {
            const limit = Number.parseInt(req.query.limit) || 100;
            const currentUser = req.currentUser;

            let list = provider.getAccountLogs ? provider.getAccountLogs(limit) : [];
            if (!Array.isArray(list)) list = [];

            // 所有用户（包括管理员）只能看到自己账号的操作日志
            if (currentUser) {
                const accessibleIds = getAccessibleAccountIds(req);
                list = list.filter(log => {
                    const logAccountId = log.accountId || log.id;
                    return accessibleIds.includes(logAccountId);
                });
            }

            // 与当前 web 前端保持一致：直接返回数组
            res.json(list);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 日志
    app.get('/api/logs', (req, res) => {
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const id = queryAccountIdRaw ? (queryAccountIdRaw === 'all' ? '' : resolveAccId(queryAccountIdRaw)) : getAccId(req);
        const currentUser = req.currentUser;

        // 必须登录才能查看日志
        if (!currentUser) {
            return res.status(401).json({ ok: false, error: '未登录' });
        }

        // 如果指定了账号ID，检查权限
        if (id && !checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        // 如果没有指定账号ID，获取当前用户可访问的所有账号的日志
        if (!id) {
            // 所有用户（包括管理员）只能获取自己可访问账号的日志
            const accessibleIds = getAccessibleAccountIds(req);
            const allLogs = [];
            const options = {
                limit: Number.parseInt(req.query.limit) || 100,
                tag: req.query.tag || '',
                module: req.query.module || '',
                event: req.query.event || '',
                keyword: req.query.keyword || '',
                isWarn: req.query.isWarn,
                timeFrom: req.query.timeFrom || '',
                timeTo: req.query.timeTo || '',
            };

            // 获取每个可访问账号的日志
            for (const accId of accessibleIds) {
                const logs = provider.getLogs(accId, options);
                if (Array.isArray(logs)) {
                    allLogs.push(...logs);
                }
            }

            // 按时间排序并限制数量
            allLogs.sort((a, b) => (b.time || 0) - (a.time || 0));
            const limitedLogs = allLogs.slice(0, options.limit);

            return res.json({ ok: true, data: limitedLogs });
        }

        // 指定了账号ID且通过权限检查，返回该账号的日志
        const options = {
            limit: Number.parseInt(req.query.limit) || 100,
            tag: req.query.tag || '',
            module: req.query.module || '',
            event: req.query.event || '',
            keyword: req.query.keyword || '',
            isWarn: req.query.isWarn,
            timeFrom: req.query.timeFrom || '',
            timeTo: req.query.timeTo || '',
        };
        const list = provider.getLogs(id, options);
        res.json({ ok: true, data: list });
    });

    // API: 清空当前账号运行日志
    app.delete('/api/logs', (req, res) => {
        const id = getAccId(req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(req, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = provider.clearLogs(id);

            if (io && provider && typeof provider.getLogs === 'function') {
                const accountLogs = provider.getLogs(id, { limit: 100 });
                io.to(`account:${id}`).emit('logs:snapshot', {
                    accountId: id,
                    logs: Array.isArray(accountLogs) ? accountLogs : [],
                });

                const allLogs = provider.getLogs('', { limit: 100 });
                io.to('account:all').emit('logs:snapshot', {
                    accountId: 'all',
                    logs: Array.isArray(allLogs) ? allLogs : [],
                });
            }

            res.json({ ok: true, data });
        } catch (e) {
            handleApiError(res, e);
        }
    });

    // ============ QR Code Login APIs (无需账号选择) ============
    // 这些接口不需要 authRequired 也能调用（用于登录流程）
    app.post('/api/qr/create', async (req, res) => {
        try {
            const result = await MiniProgramLoginSession.requestLoginCode();
            res.json({ ok: true, data: result });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/qr/check', async (req, res) => {
        const { code } = req.body || {};
        if (!code) {
            return res.status(400).json({ ok: false, error: 'Missing code' });
        }

        try {
            const result = await MiniProgramLoginSession.queryStatus(code);

            if (result.status === 'OK') {
                const ticket = result.ticket;
                const uin = result.uin || '';
                const nickname = result.nickname || ''; // 获取昵称
                const appid = '1112386029'; // Farm appid

                const authCode = await MiniProgramLoginSession.getAuthCode(ticket, appid);

                let avatar = '';
                if (uin) {
                    avatar = `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640`;
                }

                res.json({ ok: true, data: { status: 'OK', code: authCode, uin, avatar, nickname } });
            } else if (result.status === 'Used') {
                res.json({ ok: true, data: { status: 'Used' } });
            } else if (result.status === 'Wait') {
                res.json({ ok: true, data: { status: 'Wait' } });
            } else {
                res.json({ ok: true, data: { status: 'Error', error: result.msg } });
            }
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ============ 微信登录代理 API ============
    // 用于转发请求到第三方微信登录 API（如 api.aineishe.com）
    app.post('/api/proxy', async (req, res) => {
        const { action, ...params } = req.body || {};

        if (!action) {
            return res.status(400).json({ code: -1, msg: '缺少 action 参数' });
        }

        // 从请求头或配置中获取 API 配置
        // 优先使用请求头中的配置（前端传入）
        const apiUrl = req.headers['x-proxy-api-url'] || process.env.WX_PROXY_API_URL || 'https://api.aineishe.com/api/wxnc';
        const apiKey = req.headers['x-proxy-api-key'] || process.env.WX_PROXY_API_KEY || '';
        const appId = req.headers['x-proxy-app-id'] || process.env.WX_PROXY_APP_ID || 'wx5306c5978fdb76e4';

        if (!apiKey) {
            return res.status(400).json({ code: -1, msg: '缺少 API Key' });
        }

        // 如果是 jslogin 动作，自动添加 appid
        if (action === 'jslogin') {
            params.appid = appId;
        }

        try {
            const url = `${apiUrl}?api_key=${encodeURIComponent(apiKey)}&action=${action}`;
            adminLogger.info('proxy request', { action, apiUrl });

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });

            const data = await response.json();
            res.json(data);
        } catch (error) {
            adminLogger.error('proxy error', { error: error.message, action });
            res.status(500).json({
                code: -1,
                msg: `代理请求失败: ${  error.message}`,
            });
        }
    });

    app.get('*', (req, res) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/game-config')) {
             return res.status(404).json({ ok: false, error: 'Not Found' });
        }
        if (fs.existsSync(webDist)) {
            res.sendFile(path.join(webDist, 'index.html'));
        } else {
            res.status(404).send('web build not found. Please build the web project.');
        }
    });

    const applySocketSubscription = (socket, accountRef = '') => {
        const incoming = String(accountRef || '').trim();
        const resolved = incoming && incoming !== 'all' ? resolveAccId(incoming) : '';

        // 获取当前用户信息
        const token = socket.data.adminToken;
        const currentUser = token ? tokenUserMap.get(token) : null;

        // 检查权限：如果指定了账号ID，检查用户是否有权访问
        if (resolved && currentUser) {
            // 管理员可以访问所有账号
            if (currentUser.role !== 'admin') {
                const accounts = getAccountList();
                const account = accounts.find(a => a.id === resolved);
                if (!account || account.username !== currentUser.username) {
                    // 无权访问，拒绝订阅
                    socket.emit('subscribed', { accountId: 'all', error: '无权访问此账号' });
                    // 只订阅all频道（空数据）
                    for (const room of socket.rooms) {
                        if (room.startsWith('account:')) socket.leave(room);
                    }
                    socket.join('account:all');
                    socket.data.accountId = '';
                    return;
                }
            }
        }

        for (const room of socket.rooms) {
            if (room.startsWith('account:')) socket.leave(room);
        }
        if (resolved) {
            socket.join(`account:${resolved}`);
            socket.data.accountId = resolved;
        } else {
            socket.join('account:all');
            socket.data.accountId = '';
        }
        socket.emit('subscribed', { accountId: socket.data.accountId || 'all' });

        try {
            const targetId = socket.data.accountId || '';
            const user = socket.data.user;

            if (targetId && provider && typeof provider.getStatus === 'function') {
                const currentStatus = provider.getStatus(targetId);
                socket.emit('status:update', { accountId: targetId, status: currentStatus });
            }
            if (provider && typeof provider.getLogs === 'function') {
                let currentLogs = provider.getLogs(targetId, { limit: 100 });
                if (!Array.isArray(currentLogs)) currentLogs = [];

                // 过滤日志：只返回用户有权限访问的账号的日志
                if (user) {
                    const accessibleIds = getAccessibleAccountIdsForUser(user);
                    currentLogs = currentLogs.filter(log => {
                        const logAccountId = log.accountId || log.id;
                        // 如果没有账号ID，只返回给用户自己的日志（系统日志）
                        if (!logAccountId) return true;
                        return accessibleIds.includes(logAccountId);
                    });
                }

                socket.emit('logs:snapshot', {
                    accountId: targetId || 'all',
                    logs: currentLogs,
                });
            }
            if (provider && typeof provider.getAccountLogs === 'function') {
                let currentAccountLogs = provider.getAccountLogs(100);
                if (!Array.isArray(currentAccountLogs)) currentAccountLogs = [];

                // 过滤账号操作日志：只返回用户有权限访问的账号的日志
                if (user) {
                    const accessibleIds = getAccessibleAccountIdsForUser(user);
                    currentAccountLogs = currentAccountLogs.filter(log => {
                        const logAccountId = log.accountId || log.id;
                        return accessibleIds.includes(logAccountId);
                    });
                }

                socket.emit('account-logs:snapshot', {
                    logs: currentAccountLogs,
                });
            }
        } catch {
            // ignore snapshot push errors
        }
    };

    const port = CONFIG.adminPort || 3007;
    server = app.listen(port, '0.0.0.0', () => {
        adminLogger.info('admin panel started', { url: `http://localhost:${port}`, port });
    });

    io = new SocketIOServer(server, {
        path: '/socket.io',
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            allowedHeaders: ['x-admin-token', 'x-account-id'],
        },
    });

    io.use((socket, next) => {
        const authToken = socket.handshake.auth && socket.handshake.auth.token
            ? String(socket.handshake.auth.token)
            : '';
        const headerToken = socket.handshake.headers && socket.handshake.headers['x-admin-token']
            ? String(socket.handshake.headers['x-admin-token'])
            : '';
        const token = authToken || headerToken;
        if (!token || !tokens.has(token)) {
            return next(new Error('Unauthorized'));
        }
        socket.data.adminToken = token;
        // 存储用户信息到socket
        socket.data.user = tokenUserMap.get(token);
        return next();
    });

    io.on('connection', (socket) => {
        const initialAccountRef = (socket.handshake.auth && socket.handshake.auth.accountId)
            || (socket.handshake.query && socket.handshake.query.accountId)
            || '';
        applySocketSubscription(socket, initialAccountRef);
        socket.emit('ready', { ok: true, ts: Date.now() });

        socket.on('subscribe', (payload) => {
            const body = (payload && typeof payload === 'object') ? payload : {};
            applySocketSubscription(socket, body.accountId || '');
        });
    });
}

module.exports = {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
};
