# DesignKit Commerce Visual OS

面向跨境电商卖家的商品视觉资产生产系统：上传商品图 → 自动分析 → 生成主图/场景图/卖点图 → 质检与审核 → 按项目、SKU、文件夹和版本管理 → 导出平台规格包。

当前仓库是**可运行的全栈 MVP**：多租户 Go 后端 + Web 工作台 + 平台运营后台 + 移动端 PWA。三个前端入口都是零构建的 ES Module 应用，由 Go 直接托管，一个进程一套部署。

## 技术栈

| 层 | 选择 |
| --- | --- |
| 语言 | Go 1.24+ |
| 路由 | chi v5 |
| ORM | GORM v2（底层 pgx / sqlite） |
| 数据库 | PostgreSQL 16（生产）/ SQLite（本地与测试） |
| 鉴权 | JWT（access + refresh 轮换）、Argon2id |
| 队列 | Postgres/SQLite 任务表 + 轮询 worker（可换 River） |
| 存储 | 本地文件系统（接口已抽象，可换 S3/R2） |
| 实时 | SSE `/v1/w/{slug}/events` |
| 图片 | 标准库 `image` + mock provider（可换真实模型） |
| 前端 | 原生 ES Module + 共享设计系统 CSS（零构建、无 npm） |
| 托管 | Go 直接托管 `/app/`、`/admin/`、`/m/` 三套静态资源 |

## 已实现

- **多租户**：租户 = Workspace；所有业务表带 `workspace_id`，中间件强制作用域，跨租户统一返回 404
- **认证**：注册自动建默认项目与文件夹、登录、refresh 轮换、工作区切换重签令牌
- **业务**：项目、文件夹（两级树）、SKU（按租户配额）、素材上传与版本、生成任务、幂等提交
- **生成链路**：任务入队 → worker 生成 → 落对象存储 → 基础 QC → 待审核 → 审核通过/驳回
- **导出**：已通过 QC 的结果打 ZIP，扣减导出额度并写用量流水
- **用量与成本**：`usage_ledger` 不可变流水，后台成本看板据此对账
- **平台后台**：独立 audience 令牌；租户列表/详情、套餐与配额调整、暂停恢复、失败任务重试、用量排行、审计日志
- **审计**：上传、生成、审核、导出、成员与后台操作全部留痕

## 快速开始

```bash
cd apps/api
cp ../../.env.example .env   # 可跳过，默认 sqlite

# 本地：SQLite + 自动迁移 + 进程内 worker，并托管前端
WEB_DIR=../../web MOBILE_DIR=../../mobile go run ./cmd/api
```

启动后：

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| Web 工作台 | http://localhost:8080/app/ | 注册/登录、项目、SKU、上传、生成、审核、导出 |
| 运营管理后台 | http://localhost:8080/admin/ | 平台管理员登录（独立令牌） |
| 移动端 PWA | http://localhost:8080/m/ | 拍照上传、进度、审核、分享 |
| 健康检查 | `GET /healthz` | 区分 db 与队列状态 |

工作台使用说明：注册后自动创建默认项目与「未分类 SKU」文件夹，默认 1 个 SKU 配额与 1 次导出额度，足够跑通一条完整链路。

管理员账号由 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 在首次启动时自动创建（已存在则提升为平台管理员）。

### Docker（Postgres）

```bash
docker compose up --build
```

### 测试

```bash
cd apps/api
go test -race ./...
```

覆盖：跨租户隔离、配额拦截、幂等提交、后台与租户令牌隔离、队列生成到落库。

## 前端入口

三个前端共用 `web/assets/app.css` 设计系统与 `web/assets/core.js`（会话、API、UI 组件、hash 路由）：

```text
web/app/          Web 工作台（登录、总览、项目、SKU、审核、导出、用量、成员、设置）
web/admin/        运营后台（租户、订阅、成本、任务、风控、配置、审计）
mobile/           移动端 PWA（拍摄上传、进度、审核、分享）
web/assets/       共享设计系统与核心模块
```

- 没有 node_modules、没有打包步骤；改完文件刷新即可生效。
- 素材图片通过 `/v1/w/{slug}/assets/{id}/content?access_token=...` 直接给 `<img>` 用，令牌只允许出现在 GET 请求。
- 生产环境把 `web/` 与 `mobile/` 一起打进镜像，设置 `WEB_DIR=/app/web`、`MOBILE_DIR=/app/mobile`。

## 端到端示例

```bash
# 注册（自动创建工作区、默认项目、文件夹）
curl -X POST localhost:8080/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"password123","workspace_name":"My Shop"}'

# 之后的业务请求都带租户 slug
curl localhost:8080/v1/w/my-shop/projects -H "Authorization: Bearer $TOKEN"

# 上传素材
curl -X POST localhost:8080/v1/w/my-shop/skus/$SKU/assets \
  -H "Authorization: Bearer $TOKEN" -F file=@product.png

# 创建生成任务（幂等键保证重复提交不重复扣费）
curl -X POST localhost:8080/v1/w/my-shop/jobs -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sku_id":"'$SKU'","template":"scene","idempotency_key":"order-42"}'
```

## API 一览

### 认证

| 方法 | 路径 |
| --- | --- |
| POST | `/v1/auth/register` |
| POST | `/v1/auth/login` |
| POST | `/v1/auth/refresh` |
| GET | `/v1/auth/me` |

### 工作区

| 方法 | 路径 |
| --- | --- |
| GET/POST | `/v1/workspaces` |
| POST | `/v1/workspaces/{id}/switch` |

### 租户业务（`/v1/w/{slug}`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/projects` `/folders` `/skus` `/assets` `/jobs` | 列表 |
| POST | `/projects` `/folders` `/skus` | 创建 |
| POST | `/skus/{skuID}/assets` | 上传素材 |
| GET | `/assets/{assetID}/content` | 读取素材 |
| POST | `/jobs` | 创建生成任务 |
| POST | `/jobs/{jobID}/review` | 审核（驳回须填原因） |
| GET | `/skus/{skuID}/export` | 导出 ZIP |
| GET | `/usage` | 配额与用量 |
| GET | `/events` | SSE 任务状态 |
| GET/POST | `/members` | 成员 |

### 平台后台（`/v1/admin`，需 admin audience）

| 方法 | 路径 |
| --- | --- |
| POST | `/auth/login` |
| GET | `/tenants` `/tenants/{id}` |
| PATCH | `/tenants/{id}` |
| POST | `/tenants/{id}/suspend` |
| GET | `/jobs/failed` |
| POST | `/jobs/{id}/retry` |
| GET | `/usage` `/audit` |

## 多租户设计

- 租户 = Workspace，业务数据一律 `workspace_id` 必填
- 中间件按路径 slug 解析租户并校验成员关系；不存在与无权访问都返回 404，不暴露存在性
- 仓储层每条查询显式带租户条件；Postgres 迁移中为素材、任务、用量表启用 RLS 作为第二道防线
- 唯一键按租户隔离：`(workspace_id, slug)`、`(workspace_id, code)`、`(workspace_id, idempotency_key)`
- 套餐配额按租户计：`sku_quota` / `export_quota`，超额返回 402
- 角色：owner / admin / editor / reviewer / viewer，写与审核分别由中间件控制

## 目录结构

```text
apps/api/
  cmd/api/          HTTP 入口（可选进程内 worker）
  cmd/worker/       独立队列 worker
  internal/auth/    JWT、Argon2id、refresh token
  internal/middleware/ 鉴权、租户解析、写/审核权限
  internal/handler/ 路由与业务接口
  internal/service/ provider 抽象、队列执行
  internal/storage/ 对象存储接口与本地实现
  internal/webui/   前端静态托管与 SPA 回退
  internal/model/   GORM 模型
  internal/platform/ 数据库连接
  db/migrations/    生产 SQL（含 RLS）
```

## 后续计划

全功能路线见 [PLAN.md](PLAN.md)，当前优先级：

1. 版本链（同一 SKU 同模板多版本、对比、设为主版本）
2. QC 明细（分辨率、白底、透明通道、水印风险）与修复建议
3. 真实视觉分析与图像生成供应商（可配置 OpenAI 兼容接口）
4. S3/R2 预签名直传与 CDN
5. 订阅/订单/发票与试用防滥用
6. 队列退避、死信与并发 worker

## 说明

- `MockProvider` 生成占位图，用于打通链路与验收，不代表最终图像质量
- 生产务必修改 `JWT_SECRET`，并关闭 `AUTO_MIGRATE`，改用 `db/migrations` 下的 SQL
