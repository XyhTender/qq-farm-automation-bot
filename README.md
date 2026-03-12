# QQ 农场多账号挂机 + Web 面板

- 基于 Node.js 的 QQ 农场自动化工具，支持多账号管理、Web 控制面板、实时日志与数据分析。
- 基于[Penty-d/qq-farm-bot-ui](https://github.com/Penty-d/qq-farm-bot-ui)项目二开
- 参考[wjnnone/qq-farm-bot](https://github.com/wjnnone/qq-farm-bot)部分代码，感谢wjnnone！
- 感谢[sulimu2/qq-farm-bot](https://github.com/sulimu2/qq-farm-bot)大佬提供的新版协议思路
- 感谢[DeepFal/qq-farm-bot](https://github.com/DeepFal/qq-farm-bot-ui)大佬提供的背包物品种植和好友思路
- 建议自己拉项目部署，没有测试过打包的Windows端和Mac端，docker后续整！
- 更新优化日志详见update.log 感谢支持，喜欢的点一个start吧！
- 默认账号密码都是admin，端口3007
## 倒钩这辈子都发不了财！！！
## 技术栈

**后端**

[<img src="https://skillicons.dev/icons?i=nodejs" height="48" title="Node.js 20+" />](https://nodejs.org/)
[<img src="https://skillicons.dev/icons?i=express" height="48" title="Express 4" />](https://expressjs.com/)
[<img src="https://skillicons.dev/icons?i=socketio" height="48" title="Socket.io 4" />](https://socket.io/)

**前端**

[<img src="https://skillicons.dev/icons?i=vue" height="48" title="Vue 3" />](https://vuejs.org/)
[<img src="https://skillicons.dev/icons?i=vite" height="48" title="Vite 7" />](https://vitejs.dev/)
[<img src="https://skillicons.dev/icons?i=ts" height="48" title="TypeScript 5" />](https://www.typescriptlang.org/)
[<img src="https://cdn.simpleicons.org/pinia/FFD859" height="48" title="Pinia 3" />](https://pinia.vuejs.org/)
[<img src="https://skillicons.dev/icons?i=unocss" height="48" title="UnoCSS" />](https://unocss.dev/)

**部署**

[<img src="https://skillicons.dev/icons?i=pnpm" height="48" title="pnpm 10" />](https://pnpm.io/)
[<img src="https://skillicons.dev/icons?i=githubactions" height="48" title="GitHub Actions" />](https://github.com/features/actions)

---

## 功能特性
### 功能截图
<img src="https://picui.ogmua.cn/s1/2026/03/08/69ad4e2b4a55b.webp"  alt="图片失效"/>
<img src="https://picui.ogmua.cn/s1/2026/03/08/69ad4e2b4b222.webp"  alt="图片失效"/>
<img src="https://picui.ogmua.cn/s1/2026/03/09/69aecda38dabc.webp"  alt="图片失效"/>

### 多账号管理
- 账号新增、编辑、删除、启动、停止
- 扫码登录（QQ）与手动输入 Code
- 账号被踢下线自动删除
- 账号连续离线超时自动删除
- 账号离线推送通知（支持 Bark、自定义 Webhook 等）

### 自动化能力
- 农场：收获、种植、浇水、除草、除虫、铲除、土地升级
- 仓库：收获后自动出售果实
- 好友：自动偷菜 / 帮忙 / 捣乱
- 任务：自动检查并领取
- 好友黑名单：跳过指定好友
- 静默时段：指定时间段内不执行好友操作

### Web 面板
- 概览 / 农场 / 背包 / 好友 / 分析 / 账号 / 设置页面
- 实时日志，支持按账号、模块、事件、级别、关键词、时间范围筛选
- 深色 / 浅色主题切换

### 分析页
支持按以下维度排序作物：
- 经验效率 / 普通肥经验效率
- 净利润效率 / 普通肥净利润效率
- 等级要求

---

## 环境要求

- 源码运行：Node.js 20+，pnpm（推荐通过 `corepack enable` 启用）
- 二进制发布版：无需安装 Node.js

## 安装与启动（源码方式）

### Windows

```powershell
# 1. 安装 Node.js 20+（https://nodejs.org/）并启用 pnpm
node -v
corepack enable
pnpm -v

# 2. 安装依赖并构建前端
cd D:\Projects\qq-farm-bot-ui
pnpm install
pnpm build:web

# 3. 启动
pnpm dev:core

# （可选）设置其他端口后启动
$env:ADMIN_PORT="你的新端口"
pnpm dev:core
```

### Linux（Ubuntu/Debian）
建议使用宝塔最为便捷，在网站其他项目选项中按照如图所示去部署即可

<img src="https://picui.ogmua.cn/s1/2026/03/08/69ad661353590.webp"  alt="图片失效"/>

启动后访问面板：
- 本机：`http://localhost:3007`
- 局域网：`http://<你的IP>:3007`

---

## Docker 部署（拉取不了镜像直接下载压缩包解压即可）
```
# 拉取仓库
git clone https://github.com/XyhTender/qq-farm-automation-bot.git

# 进入目录
cd /qq-farm-automation-bot-main

# 构建并后台启动
docker compose -f docker-compose.yml up -d --build

# 查看日志
docker compose logs -f

# 停止并移除容器
docker compose down

# 浏览器访问http://你的IP:3007
```

## 二进制发布版（无需 Node.js）

### 构建

```bash
pnpm install
pnpm package:release
```

产物输出在 `dist/` 目录：
- `产物在Releases中也可以下载，无需自己构建`

| 平台 | 文件名 |
|------|--------|
| Windows x64 | `qq-farm-bot.exe` |
| Linux x64 | `qq-farm-bot` |
| macOS Intel | `qq-farm-bot-x64` |
| macOS Apple Silicon | `qq-farm-bot-arm64` |

### 运行

```bash
# Windows：双击 exe 或在终端执行
.\qq-farm-bot-win-x64.exe

# Linux / macOS
chmod +x ./qq-farm-bot && ./qq-farm-bot
```

程序会在可执行文件同级目录自动创建 `data/` 并写入 `store.json`、`accounts.json`。

---

## 登录与安全

- 面板首次访问需要登录
- 默认管理账号：`admin/admin`
- **建议部署后立即修改为强密码**

---

## 项目结构

```
qq-farm-bot-ui/
├── core/                  # 后端（Node.js 机器人引擎）
│   ├── src/
│   │   ├── config/        # 配置管理
│   │   ├── controllers/   # HTTP API
│   │   ├── gameConfig/    # 游戏静态数据
│   │   ├── models/        # 数据模型与持久化
│   │   ├── proto/         # Protobuf 协议定义
│   │   ├── runtime/       # 运行时引擎与 Worker 管理
│   │   └── services/      # 业务逻辑（农场、好友、任务等）
│   ├── data/              # 运行时数据（accounts.json、store.json）
│   └── client.js          # 主进程入口
├── web/                   # 前端（Vue 3 + Vite）
│   ├── src/
│   │   ├── api/           # API 客户端
│   │   ├── components/    # Vue 组件
│   │   ├── stores/        # Pinia 状态管理
│   │   └── views/         # 页面视图
│   └── dist/              # 构建产物
├── pnpm-workspace.yaml
└── package.json
```

---

## 特别感谢
- 基于[Penty-d/qq-farm-bot-ui](https://github.com/Penty-d/qq-farm-bot-ui)二改
- 核心功能：[linguo2625469/qq-farm-bot](https://github.com/linguo2625469/qq-farm-bot)
- 部分功能：[QianChenJun/qq-farm-bot](https://github.com/QianChenJun/qq-farm-bot)
- 扫码登录：[lkeme/QRLib](https://github.com/lkeme/QRLib)
- 推送通知：[imaegoo/pushoo](https://github.com/imaegoo/pushoo)

## 免责声明

本项目仅供学习与研究用途。使用本工具可能违反游戏服务条款，由此产生的一切后果由使用者自行承担。
