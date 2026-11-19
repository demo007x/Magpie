# 安全政策 / Security Policy

## 报告漏洞

请**不要**在公开 issue 中描述安全漏洞，使用 GitHub 私密漏洞报告入口：
<https://github.com/demo007x/Magpie/security/advisories/new>

## 已知设计边界（非漏洞）

- API 密钥明文保存在本机 `settings.json`（已向用户明示的设计），请勿共享该文件
- 应用不内置遥测；「识图配置」开启后截图会发送给你自己配置的模型服务
