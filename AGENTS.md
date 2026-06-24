# VS Code NPU Monitor

开发前先读取 [README.md](README.md)，确认 Windows / WSL 运行方式、扫描语义和
配置项。

## 约束

- 使用 npm 管理依赖，提交 `package-lock.json`，不提交 `node_modules/`。
- Windows 使用原生 OpenSSH，WSL 使用 `/usr/bin/ssh`；跨平台逻辑必须有测试。
- 不关闭 SSH 主机密钥校验，不修改用户的 SSH config、`known_hosts` 或密钥。
- 远端扫描为只读操作，不执行安装、服务启停或容器管理命令。
- 修改采集逻辑后必须运行 `npm run check`；交付前运行 `npm run vsix`。
- 自动轮询只能访问已订阅机器，手动扫描不得改变订阅列表。
- 提交信息使用一句简短英文，格式为 `[Tag] Brief description`，并遵循已有提交记录风格。
