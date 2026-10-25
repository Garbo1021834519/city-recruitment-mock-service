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
REA_DIFY_PROVIDER=mock
REA_MESSAGE_CHANNEL_PROVIDER=mock
```

`mock` 模式用于验收第一条业务闭环：签名入站消息会写入会话，生成一条确定性的 Mock Dify 回复，并以 `simulated` 状态写入 outbound 和 delivery 记录。它不会把文字发送到真实微信。接入真实 Dify 时，将 `REA_DIFY_PROVIDER` 改为 `http`，并在对应 `agent_devices.data_json` 中配置 `dify_url` 和 `dify_key`；接入真实消息通道前，必须实现并配置对应的 `MessageChannelProvider`。

入站回调使用 HMAC-SHA256 验签，不需要用户 JWT。请求格式为：

```json
{
  "id": "unique-event-id",
  "event": "message.created",
  "data": {
    "device_code": "local-device-001",
    "customer_id": 700001,
    "content": "候选人消息"
  }
}
```

签名放在 `X-Dify-Signature` 请求头，当前实现对解析后的 JSON 使用紧凑 `JSON.stringify` 重新序列化后计算 HMAC，密钥是 `REA_WEBHOOK_SECRET`；发送方需保持字段顺序一致。

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
