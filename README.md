## StarCraft II Replay Analysis - Online

一个基于浏览器端的《星际争霸 II》录像在线解析工具。用户只需通过 HTTP 服务访问 `index.html`，将本地 `.SC2Replay` 录像文件拖入页面，即可在浏览器中完成解析与展示，无需任何后端服务。

### 功能概述

- **纯前端运行**：使用 Pyodide 在浏览器中加载 Python 运行时与第三方库完成解析，录像文件不会上传到服务器。
- **对战信息展示**：展示地图名称、对局时长等基础信息。
- **造兵/建筑时间轴**：按时间顺序显示双方建造顺序，可切换“开始建造时间 / 完成建造时间”两种模式。
- **升级与技能事件**：支持展示科技升级完成时间以及“星空加速（Nexus Mass Recall）”等关键技能事件。
- **中英双语名称**：通过本地 `data.json` 进行单位、建筑与升级的中文翻译，支持切换显示原始英文名称。

---

### 依赖说明

本项目的核心解析逻辑基于 Python 社区开源库 **sc2reader**：

- **sc2reader**：用于读取并解析 `.SC2Replay` 文件，提取玩家、单位、建筑、升级、事件等结构化数据。
- 通过 Pyodide 在浏览器中安装并运行 `sc2reader`，结合自定义脚本，将解析结果序列化为 JSON，再由前端渲染为时间轴视图。

---

### 核心文件说明

#### `index.html`

- **用途**：本项目的主入口页面，集成了 UI、样式以及所有前端和 Pyodide + sc2reader 解析逻辑。
- **主要内容**：
  - **UI 与交互**：实现拖拽/点击上传 `.SC2Replay` 文件的拖放区域，加载状态提示、错误提示以及结果展示区域。
  - **时间轴展示**：
    - 按队伍和玩家拆分成多个面板，展示造兵/建筑/升级/技能事件列表。
    - 支持切换时间显示模式（开始建造/完成建造）与是否显示升级事件。
    - 支持切换是否显示“原始英文名称”。
  - **Pyodide 集成**：
    - 从 CDN 加载 Pyodide。
    - 在浏览器虚拟文件系统中写入上传的 `.SC2Replay` 文件。
    - 安装并调用 `sc2reader` 解析录像，使用自定义 Python 脚本抽取建造顺序、升级与技能事件等信息。
  - **本地翻译数据加载**：
    - 通过 `fetch('data.json')` 加载本地翻译与时间数据，并在前端对单位/建筑/升级名称进行中文化展示。

#### `data.json`

- **用途**：项目中使用的本地静态数据文件，主要用于将 `sc2reader` 输出的单位、建筑、升级名称（英文标识）转换为中文名称，并附带推荐的建造/研究时间参考。
- **结构概览**：
  - `unit`：各个单位（例如 SCV、Marine、Zealot 等）的中文名称与时间数据。
  - `upgrade`：升级项目（例如狗速、近战/远程/空军攻防、蟑螂速度、折跃门、追猎闪烁等）的中文名称与时间数据。
  - `build`：建筑与特殊建筑状态（如孵化场、孢子爬虫、兵营、重工厂、星港等）的中文名称与时间数据。
  - `change`：对某些单位/建筑“形态变化”“茧”“埋地状态”等的别名与显示名称映射，便于在时间轴中以更贴近玩家习惯的方式展示（如把 Hive 显示为“三本”、OrbitalCommand 显示为“星轨”等）。
- **前端使用方式**：
  - 页面加载时通过 `loadTranslationData()` 读取该文件。
  - 在渲染时间轴时调用映射，将 `sc2reader` 给出的英文 key 翻译为 `zh` 字段对应的中文显示名称，并在某些情况下附加 `[time s]` 形态的时间参考。

---

### 许可证与致谢

- **sc2reader（依赖库）**

  本项目依赖的 `sc2reader` 源码来自 `sc2reader-upstream`，其遵循 MIT 许可证，声明如下：

  > The MIT License, http://www.opensource.org/licenses/mit-license.php  
  >  
  > Copyright (c) 2011-2013 Graylin Kim  
  >  
  > Permission is hereby granted, free of charge, to any person obtaining a copy  
  > of this software and associated documentation files (the "Software"), to deal  
  > in the Software without restriction, including without limitation the rights  
  > to use, copy, modify, merge, publish, distribute, sublicense, and/or sell  
  > copies of the Software, and to permit persons to whom the Software is  
  > furnished to do so, subject to the following conditions:  
  >  
  > The above copyright notice and this permission notice shall be included in  
  > all copies or substantial portions of the Software.  
  >  
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR  
  > IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,  
  > FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE  
  > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER  
  > LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,  
  > OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN  
  > THE SOFTWARE.

- **SC2ReplayAnalyzer-main（数据翻译参考来源）**

  本项目中 `data.json` 的部分中文翻译与时间数据参考并整理自 `SC2ReplayAnalyzer-main` 项目中的.toml文件，其遵循 MIT 许可证，声明如下：

  > MIT License  
  >  
  > Copyright (c) 2024 AltriaZ0  
  >  
  > Permission is hereby granted, free of charge, to any person obtaining a copy  
  > of this software and associated documentation files (the "Software"), to deal  
  > in the Software without restriction, including without limitation the rights  
  > to use, copy, modify, merge, publish, distribute, sublicense, and/or sell  
  > copies of the Software, and to permit persons to whom the Software is  
  > furnished to do so, subject to the following conditions:  
  >  
  > The above copyright notice and this permission notice shall be included in all  
  > copies or substantial portions of the Software.  
  >  
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR  
  > IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,  
  > FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE  
  > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER  
  > LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,  
  > OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE  
  > SOFTWARE.

在此对 **sc2reader** 以及 **SC2ReplayAnalyzer-main** 项目作者和贡献者表示感谢。

---

### 使用方式（简要）

1. **准备环境**
   - 通过任意简易 HTTP 服务器（如 `python -m http.server`、VSCode Live Server 等）在项目根目录启动服务。
2. **访问页面**
   - 在浏览器中打开对应的 `index.html` 地址（例如 `http://localhost:8000/index.html`）。
3. **拖入录像**
   - 将本地 `.SC2Replay` 文件拖入页面中的拖拽区域，等待解析完成。
4. **查看结果**
   - 在下方结果区域中查看地图、时长、双人/多人的造兵、建筑、升级与技能时间轴，并可通过右侧控件切换时间模式与中英文显示。

