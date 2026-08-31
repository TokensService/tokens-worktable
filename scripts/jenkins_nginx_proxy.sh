# ===== 在 Jenkins 服务器上执行 =====
set -e

# 0) 确认本机 Jenkins 可达（应输出 200/401/403 之一；timeout/refused 说明 Jenkins 不在本机 18080）
echo "== 0) 检查本机 Jenkins =="
curl -s -o /dev/null -w 'jenkins http=%{http_code}\n' -m 5 http://127.0.0.1:18080/api/json \
  || echo "!! 127.0.0.1:18080 不通，请确认 Jenkins 实际监听地址/端口"

# 1) 安装 nginx
echo "== 1) 安装 nginx =="
if command -v apt >/dev/null 2>&1; then sudo apt update && sudo apt install -y nginx;
elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y nginx;
elif command -v yum >/dev/null 2>&1; then sudo yum install -y nginx; fi

# 2) 写 CORS 反代配置（转发到本机 Jenkins 127.0.0.1:18080，对外监听 18081）
echo "== 2) 写入 /etc/nginx/conf.d/jenkins-cors.conf =="
sudo tee /etc/nginx/conf.d/jenkins-cors.conf >/dev/null <<'EOF'
upstream jenkins_upstream {
    server 127.0.0.1:18080;
}
server {
    listen 18081;
    location / {
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin "$http_origin" always;
            add_header Access-Control-Allow-Credentials "true" always;
            add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS, HEAD" always;
            add_header Access-Control-Allow-Headers "Authorization, Content-Type, Jenkins-Crumb, X-Requested-With" always;
            add_header Access-Control-Max-Age 86400 always;
            return 204;
        }
        add_header Access-Control-Allow-Origin "$http_origin" always;
        add_header Access-Control-Allow-Credentials "true" always;
        proxy_pass http://jenkins_upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

# 3) 检查配置 + 启动/重载
echo "== 3) nginx -t 并生效 =="
sudo nginx -t
sudo systemctl enable --now nginx 2>/dev/null || sudo service nginx start 2>/dev/null || sudo nginx
sudo nginx -s reload 2>/dev/null || sudo systemctl reload nginx 2>/dev/null || true

# 4) 放行 18081（firewalld 存在时）
if command -v firewall-cmd >/dev/null 2>&1; then
  echo "== 4) 放行 18081 =="
  sudo firewall-cmd --add-port=18081/tcp --permanent && sudo firewall-cmd --reload
fi

# 5) CentOS/RHEL 常见坑：SELinux 拦截 nginx 连本机端口 → 502。若第 0 步通但浏览器 502，执行：
#    sudo setsebool -P httpd_can_network_connect 1

echo "== 完成。请到本地机器做验证（见下） =="
