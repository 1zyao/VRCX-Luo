# syntax=docker/dockerfile:1
# =============================================================================
# VRCX-K 无头运行镜像（多阶段构建）
#
# Builder  : 在 Linux 容器内完成全部构建（前端 + .NET 后端 + Electron 打包），
#            产物自带 .NET 9 runtime，运行镜像无需再装 .NET。
# Runtime  : 极简 debian 镜像 + Xvfb 虚拟显示（不装桌面）+ VRCX 可执行。
#
# 服务器无需预装任何软件，只有 Docker 即可。国内网络较慢时可参考下方注释
# 打开 npm / electron / nuget 镜像加速。
# =============================================================================

############################# Builder 阶段 ####################################
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS builder

# electron 二进制下载镜像（必须在 npm ci 之前生效——npm ci 会触发 electron postinstall）
ENV ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ENV ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

# Node.js 24（前端构建 + 项目脚本所需；项目要求 node >= 24.10）
# 国内加速：apt 源直接覆写为阿里云（用 http 避免依赖 ca-certificates）
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb http://mirrors.aliyun.com/debian/ bookworm main contrib non-free non-free-firmware\ndeb http://mirrors.aliyun.com/debian-security/ bookworm-security main contrib non-free non-free-firmware\ndeb http://mirrors.aliyun.com/debian/ bookworm-updates main contrib non-free non-free-firmware\n' > /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# 先拷贝依赖清单，利用 Docker 层缓存（改动 package.json 才重装）
COPY package.json package-lock.json .npmrc ./
# npm 用国内镜像源（加速依赖下载）
RUN npm config set registry https://registry.npmmirror.com
RUN npm ci

# 拷贝全部源码（node_modules / build / obj 等由 .dockerignore 排除）
COPY . .

# NuGet 国内镜像（dotnet restore 提速）
RUN mkdir -p /root/.nuget/NuGet && printf '%s' '<?xml version="1.0" encoding="utf-8"?><configuration><packageSources><add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" /><add key="huawei" value="https://repo.huaweicloud.com/repository/nuget/v3/index.json" protocolVersion="3" /></packageSources></configuration>' > /root/.nuget/NuGet/NuGet.Config

# 1) 前端构建（PLATFORM=linux 定义平台宏）
RUN npm run prod-linux

# 2) .NET 后端（与 CI 同命令，产物输出到 build/Electron/）
RUN dotnet build Dotnet/VRCX-Electron.csproj \
    -p:Configuration=Release -p:WarningLevel=0 -p:Platform=x64 \
    -p:PlatformTarget=x64 -p:RestorePackagesConfig=true \
    -t:"Restore;Clean;Build" -m -a x64

# 3) 下载 Linux .NET 9 runtime（打包进 resources，运行期免装 .NET）
RUN node ./src-electron/download-dotnet-runtime.js --arch=x64

# 4) electron-builder 产出 linux-unpacked 解包目录（容器友好，无 FUSE 依赖）
#    镜像变量已在阶段顶部 ENV 设置（同时覆盖 npm ci 与打包阶段的下载）
RUN npx electron-builder --linux dir --x64 --publish never

# 5) 修正 node-api-dotnet init.js（指向 app.asar.unpacked，CI 同款补丁）
RUN node ./src-electron/patch-node-api-dotnet.js --arch=x64

############################# Runtime 阶段 ####################################
FROM debian:bookworm-slim AS runtime

# Electron + Xvfb 运行依赖（虚拟显示，非桌面环境）
# 国内加速：apt 源直接覆写为阿里云
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb http://mirrors.aliyun.com/debian/ bookworm main contrib non-free non-free-firmware\ndeb http://mirrors.aliyun.com/debian-security/ bookworm-security main contrib non-free non-free-firmware\ndeb http://mirrors.aliyun.com/debian/ bookworm-updates main contrib non-free non-free-firmware\n' > /etc/apt/sources.list \
 && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates x11vnc novnc websockify \
    xvfb x11-utils dbus dbus-x11 \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 libgtk-3-0 \
    libx11-6 libx11-xcb1 libxcb1 libxss1 libxtst6 \
    fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# 拷贝解包后的 VRCX（可执行入口 /opt/vrcx/vrcx）
COPY --from=builder /src/build/linux-unpacked/ /opt/vrcx/

# 拷贝入口脚本（并转 LF，避免 Windows 编辑引入 CRLF 导致 bash 报错）
# 注意：COPY 路径相对于构建上下文根（compose 的 context=仓库根），故为 deploy/docker/entrypoint.sh
COPY deploy/docker/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENV HOME=/root \
    XDG_CONFIG_HOME=/root/.config

# VRCX 数据目录（SQLite 数据库 + 配置），务必用 volume 持久化
VOLUME /root/.config/VRCX

# 调试用 VNC 端口（默认不启用；需镜像内置 x11vnc 并设 VNC=1）
# EXPOSE 5900

ENTRYPOINT ["/entrypoint.sh"]
