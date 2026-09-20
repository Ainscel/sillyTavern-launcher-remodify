# 构建脚本说明

## sync-version.js - 版本信息同步脚本

### 功能

在构建前自动同步 `package.json` 中的版本信息到所有相关配置文件，确保版本号一致性。

### 同步的文件

1. **src-tauri/tauri.conf.json**
   - `version`: 应用版本号
   - `productName`: 产品名称

2. **src-tauri/Cargo.toml**
   - `version`: Rust 包版本号
   - `description`: 项目描述

> 注意：
> - `src/lib/config.ts` 直接从 `package.json` 导入版本信息，无需同步
> - NSIS 安装程序使用 hooks 机制，不需要自定义模板，无需同步版本信息

### 使用方法

#### 自动执行（推荐）

构建时会自动执行同步：

```bash
# 构建 Tauri 应用（会自动同步版本）
bun run tauri:build

# 或者构建前端（会自动同步版本）
bun run build
```

#### 手动执行

如果需要手动同步版本信息：

```bash
bun run sync-version
```

### 版本更新流程

1. **修改版本号**
   
   只需要修改 `package.json` 中的 `version` 字段：
   
   ```json
   {
     "version": "0.2.0"
   }
   ```

2. **运行同步脚本**
   
   ```bash
   bun run sync-version
   ```
   
   或者直接构建（会自动同步）：
   
   ```bash
   bun run tauri:build
   ```

3. **验证同步结果**
   
   脚本会输出同步状态：
   
   ```
   🔄 开始同步版本信息...
   📦 项目名称: sillyTavern-launcher-gui
   🏷️  版本号: 0.2.0
   📝 描述: SillyTavern Launcher GUI...
   ✅ 已同步到 tauri.conf.json
   ✅ 已同步到 Cargo.toml
   ✅ 已同步到 installer.nsi
   ✅ 已同步到 config.ts
   🎉 版本信息同步完成！
   ```

### 注意事项

1. **单一数据源**
   - `package.json` 是版本信息的唯一数据源
   - 不要手动修改其他文件中的版本号

2. **构建前同步**
   - 脚本已配置为构建前自动执行
   - 确保每次构建都使用最新的版本信息

3. **错误处理**
   - 如果同步失败，脚本会退出并显示错误信息
   - 检查文件路径和格式是否正确

### 自定义配置

如需修改产品名称、发布者等信息：

1. **网站地址**：修改 `package.json` 中的 `homepage` 字段
2. **产品名称和发布者**：编辑 `scripts/sync-version.js` 中的常量：

```javascript
const productName = 'SillyTavern Launcher GUI';
const publisher = 'SillyTavern Launcher';
```

### 故障排除

**问题：同步失败**

- 检查文件是否存在
- 检查文件格式是否正确
- 查看错误信息中的具体原因

**问题：版本号不一致**

- 运行 `bun run sync-version` 手动同步
- 检查 `package.json` 中的版本号是否正确

**问题：构建时没有自动同步**

- 检查 `package.json` 中的 `prebuild` 和 `tauri:build` 脚本
- 确保使用正确的构建命令

---

## make-ico.cjs - 多分辨率 ICO 生成脚本

### 功能

从一张 PNG 源图生成多尺寸的 Windows ICO 文件。

### 为什么需要它

- **在线转换站点容易下错文件**：不少站点转换后会先跳到一个自动提交的中转页，直接「保存网页」拿到的是 HTML 而不是 ICO，Windows 打不开也不报错。
- **单尺寸 ICO 在高 DPI 下会发虚**：Windows 会按缩放比例挑最接近的一帧（100% 用 16、125% 用 20/24、150% 用 24、200% 用 32），尺寸齐全才不会糊。
- **不依赖 PNG-in-ICO 解码**：内部一律用 32bpp BMP 帧，兼容性最好。

### 使用方法

```bash
# 生成应用图标（尺寸齐全，含 256）
node scripts/make-ico.cjs src-tauri/icons/source/app.png src-tauri/icons/icon.ico \
  --sizes=16,24,32,40,48,64,128,256

# 生成托盘运行态图标（只给托盘用，不需要大尺寸）
node scripts/make-ico.cjs src-tauri/icons/source/app-running.png src-tauri/icons/icon-running.ico \
  --sizes=16,24,32,40,48,64

# 只检查源图，不生成（看画布尺寸、alpha 分布、四角像素）
node scripts/make-ico.cjs src-tauri/icons/source/app.png --analyze
```

> 当前仓库里的两个 ICO 是在线工具生成的，并非本脚本产出——本脚本作为**可重复、
> 可校验的替代方案**保留：在线站点一旦流程走错（下载到中转页而不是转换结果）
> 或只产出单一尺寸，排查起来都很费劲。两种方式产出的文件格式是兼容的。

### 参数

| 参数 | 说明 |
| ---- | ---- |
| `--sizes=16,24,32,...` | 要写入 ICO 的尺寸，默认 `16,24,32,48,64,128,256` |
| `--analyze` | 只分析源图并打印信息，不生成文件 |

### 源图要求

- PNG 格式，8 位深，非隔行扫描
- 正方形（否则缩放会变形，脚本会警告）
- 建议背景透明

### 图标对应关系

设计源图放在 `src-tauri/icons/source/`，与它们生成的 ICO 放在一起。
该目录不在 `bundle.icon` 列表里，不会被打进安装包。

| 源图 | 输出 | 用途 |
| ---- | ---- | ---- |
| `src-tauri/icons/source/app.png` | `src-tauri/icons/icon.ico` | 程序/安装包图标；Windows 上 `default_window_icon()` 也取自它，因此同时是**托盘未运行态**图标 |
| `src-tauri/icons/source/app-running.png` | `src-tauri/icons/icon-running.ico` | **托盘运行态**图标（酒馆服务运行时替换显示，见 `src-tauri/src/tray.rs`） |

> 两张源图的留白比例要保持一致，否则切换运行状态时托盘图标会出现大小跳动。
