# 腾讯云部署

## 结构

- Docker Compose 运行 Node 22 应用，宿主机端口 `4222` 映射到容器 `4222`。
- SQLite 数据保存在部署目录的 `data/app.sqlite`，容器仅以只读根文件系统运行。
- `.env.production` 只保存在服务器，至少配置独立的 JWT 密钥、webhook 密钥和首次种子密码。
- 首次启动会创建 `local-admin`、`local-customer`、`local-recruiter` 种子账号。生产初始密码由 `REA_LOCAL_SEED_PASSWORD` 提供，部署后应立即登录并改掉管理员密码。

## 首次部署

在服务器新建项目目录并克隆代码：

```bash
sudo mkdir -p /srv/apps/city-recruitment
sudo chown "$USER":"$USER" /srv/apps/city-recruitment
cd /srv/apps/city-recruitment
git clone https://github.com/tjfeng741963/city-recruitment-mock-service.git source
cd source
```

创建仅服务器本地保存的环境文件。用密码管理器生成三个互不相同的随机值，不要把 `.env.production` 提交到 Git：

```dotenv
REA_LOCAL_JWT_SECRET=<独立的高熵随机密钥>
REA_WEBHOOK_SECRET=<独立的高熵随机密钥>
REA_LOCAL_SEED_PASSWORD=<首次管理员登录密码>
```

```bash
chmod 600 .env.production
mkdir -p data
sudo chown -R 1000:1000 data
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
```

浏览器访问 `http://<服务器公网IP>:4222/login`，账号为 `local-admin`，密码为 `REA_LOCAL_SEED_PASSWORD`。云防火墙需放行 TCP 4222；如启用 UFW，也需在服务器本机防火墙放行。

## 更新

更新前先停止应用并备份 SQLite，然后拉取目标提交、重建镜像并启动：

```bash
cd /srv/apps/city-recruitment/source
docker compose -f docker-compose.production.yml stop app
cp data/app.sqlite "data/app.sqlite.$(date +%Y%m%d%H%M%S).bak"
git fetch origin
git checkout --detach <目标提交>
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
```

数据库迁移在应用启动时执行。保留更新前 SQLite 备份和 Docker 旧镜像，确认新版本健康后再清理。

## 运维

```bash
docker compose -f docker-compose.production.yml logs --tail=100 app
docker compose -f docker-compose.production.yml restart app
curl -I http://127.0.0.1:4222/login
```

当前直接通过公网 IP 的方案使用 HTTP，仅适合临时验收，不应承载真实密码、令牌或候选人数据。正式使用应配置域名和 HTTPS 反向代理，并把云防火墙改为仅开放 80/443；应用容器端口应限制在本机或内网访问。
