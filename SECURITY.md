# 安全政策 / Security Policy

## 报告漏洞

请**不要**在公开 issue 中描述安全漏洞。使用 GitHub 的私密漏洞报告入口：

<https://github.com/demo007x/Magpie/security/advisories/new>

会在 7 天内确认；修复发布后在同一 advisory 中同步披露细节。

## 支持版本

仅最新发布版本接收安全修复。

## 已知设计边界（非漏洞）

- API 密钥明文保存在本机 `settings.json`（面向用户的已知设计，迁移系统钥匙串在路线图中），请勿与他人共享该文件
- 应用不内置遥测，不上传划词内容；「识图配置」开启后截图会发送给你自己配置的模型服务
