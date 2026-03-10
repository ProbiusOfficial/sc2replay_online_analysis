## StarCraft II Replay Analysis - Online

![banner](./assets/banner.png)

一个基于浏览器端的《星际争霸 II》录像在线解析工具。用户只需通过 HTTP 服务访问 `index.html`，将本地 `.SC2Replay` 录像文件拖入页面，即可在浏览器中完成解析与展示，无需任何后端服务。

### 使用方法

直接在GithubPage使用即可：https://rep.probius.xyz/

或在本地使用http服务打开 (eg.`python -m http.server`)

### 功能概述

- **纯前端运行**：使用 Pyodide 在浏览器中加载 Python 运行时与第三方库完成解析，录像文件不会上传到服务器。
- **对战信息展示**：展示地图名称、对局时长等基础信息。
- **聊天消息**：还记得那天对局你们聊了什么么？精准还原，身临其境w！
- **造兵/建筑时间轴**：按时间顺序显示双方建造顺序，可切换“开始建造时间 / 完成建造时间”两种模式。
- **升级与技能事件**：支持展示科技升级完成时间以及“星空加速（Nexus Mass Recall）”等关键技能事件。
- **中英双语名称**：通过本地 `data.json` 进行单位、建筑与升级的中文翻译，支持切换显示原始英文名称。
- **无视版本**：不管现在的客户端是否能播放，只要数据完好，都能看！（理论支持15405-95299版本，不过好像一些资料片调整没法避免，至少我测试了2018年的录像还能提取）

![我就说很有用吧.jpg](./assets/image-20260310011545460.png)

---

### 依赖说明

本项目的核心解析逻辑基于 Python 社区开源库 **sc2reader**：

- **sc2reader**：用于读取并解析 `.SC2Replay` 文件，提取玩家、单位、建筑、升级、事件等结构化数据。
- 通过 Pyodide 在浏览器中安装并运行 `sc2reader`，结合自定义脚本，将解析结果序列化为 JSON，再由前端渲染为时间轴视图。



---

### 许可证与致谢

- 感谢全科普鲁星区最温柔善良可靠的贝妮小姐w！

- **sc2reader（依赖库）**

  本项目依赖的 `sc2reader` 源码来自 `ggtracker/sc2reader`，其遵循 MIT 许可证，声明如下：

  > The MIT License, http://www.opensource.org/licenses/mit-license.php  
  >  
  > Copyright (c) 2011-2013 Graylin Kim  
  >  
  > ...
  
- **SC2ReplayAnalyzer-main（数据翻译参考来源）**

  本项目中 `data.json` 的部分中文翻译与升级时间数据参考自 `AltriaZ0/SC2ReplayAnalyzer` 项目中的`.toml`文件，其遵循 MIT 许可证，声明如下：

  > MIT License  
  >  
  > Copyright (c) 2024 AltriaZ0  
  >  
  > ...

在此对 **sc2reader** 以及 **SC2ReplayAnalyzer-main** 项目作者和贡献者表示感谢。

### 更新日志

26/03/10 为 Zerg 单位特殊处理：sc2reader 对虫族单位（通过幼虫孵化）的 started_at 没有做「建造时间回推」，导致 start_time 和 finish_time 相同，都是「孵化完成时刻」。采用回推策略，将 start_time 设置为孵化开始时刻，finish_time 设置为孵化完成时刻。
