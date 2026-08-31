# op_test

自动化测试与优化工具

## 安装

```bash
./install-deps.sh       # 检查/安装基础环境与各组成部分依赖
./dsh.sh build          # 编译 deepseek-harness 子模块
./dsh.sh install        # 在 pnpm 全局 bin 生成 dsh 命令
./install-plugins.sh    # 构建并安装 dsh-plugins/ 下的工作台插件
./apply-branding.sh     # 应用 OPTEST web 品牌补丁并重建（幂等）
./dsh.sh start          # 后台启动 dsh web（默认 http://127.0.0.1:3051）
```

`./apply-branding.sh --check` 可只检查品牌补丁的应用状态。详见 [AGENTS.md](AGENTS.md)。
