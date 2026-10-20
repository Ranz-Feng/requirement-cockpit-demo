# 需求协作台 Demo

一个本地运行的需求全流程管理演示，覆盖需求接收、需求拆解、算法实验、技术方案、开发联调和验收交付。页面通过本机 WorkBuddy 桌面端调用智能体，可选接入飞书文档与 iMa 知识库。

## 运行

前置条件：

- macOS
- Node.js 20 或更高版本
- WorkBuddy 桌面端已登录

启动：

```bash
npm start
```

打开：

```text
http://127.0.0.1:8788/index.html
```

首次启动会在本机生成演示需求和运行目录，相关文件不会进入版本库。

## 可选配置

复制配置模板：

```bash
cp bridge/.env.example bridge/.env
```

在 `bridge/.env` 中配置飞书应用或用户授权。iMa 默认读取本机 `~/.config/ima` 中的配置。

生成 MP3 需要本机可用的 `ffmpeg`。

## 需求拆解专家

`agents/algo-requirement-spec/` 是 WorkBuddy 的“算法需求拆解专家”独立专家包，包含专家定义、固定模板、参考资料、校验脚本和虚构示例。

安装到本机 WorkBuddy：

```bash
npm run agents:install
```

安装后重启 WorkBuddy，在“专家中心 → 我的专家”中选择“算法需求拆解专家”。

## 发布边界

仓库只保留可运行页面、桥接代码和安全配置模板。以下内容不会上传：

- `data/` 中的需求、知识库、运行记录与上传材料
- `artifacts/` 中的音频和其他生成产物
- 原型 PDF、录音及转写
- 飞书登录态、环境变量和其他本机凭证
