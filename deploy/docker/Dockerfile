# VRCX-K headless image: build the Linux Electron bundle, then run it with Xvfb.

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS builder

ENV ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ENV ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb http://mirrors.aliyun.com/debian/ bookworm main contrib non-free non-free-firmware\ndeb http://mirrors.aliyun.com/debian-security/ bookworm-security main contrib non-free non-free-firmware\ndeb http://mirrors.aliyun.com/debian/ bookworm-updates main contrib non-free non-free-firmware\n' > /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm config set registry https://registry.npmmirror.com && npm ci
COPY . .

RUN mkdir -p /root/.nuget/NuGet \
 && printf '%s' '<?xml version="1.0" encoding="utf-8"?><configuration><packageSources><add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" /><add key="huawei" value="https://repo.huaweicloud.com/repository/nuget/v3/index.json" protocolVersion="3" /></packageSources></configuration>' > /root/.nuget/NuGet/NuGet.Config

RUN npm run prod-linux
RUN dotnet build Dotnet/VRCX-Electron.csproj \
    -p:Configuration=Release -p:WarningLevel=0 -p:Platform=x64 \
    -p:PlatformTarget=x64 -p:RestorePackagesConfig=true \
    -t:"Restore;Clean;Build" -m -a x64
RUN node ./src-electron/download-dotnet-runtime.js --arch=x64
RUN npx electron-builder --linux dir --x64 --publish never
RUN node ./src-electron/patch-node-api-dotnet.js --arch=x64

FROM debian:bookworm-slim AS runtime

RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb http://mirrors.aliyun.com/debian/ bookworm main contrib non-free non-free-firmware\ndeb http://mirrors.aliyun.com/debian-security/ bookworm-security main contrib non-free non-free-firmware\ndeb http://mirrors.aliyun.com/debian/ bookworm-updates main contrib non-free non-free-firmware\n' > /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates x11vnc novnc websockify xvfb x11-utils dbus dbus-x11 \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 libgtk-3-0 \
    libx11-6 libx11-xcb1 libxcb1 libxss1 libxtst6 fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /src/build/linux-unpacked/ /opt/vrcx/
COPY deploy/docker/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENV HOME=/root \
    XDG_CONFIG_HOME=/root/.config

VOLUME /root/.config/VRCX
EXPOSE 6080
ENTRYPOINT ["/entrypoint.sh"]
