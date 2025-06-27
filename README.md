# WebAudio Modem

**WebAudio APIを使用したオーディオモデム実装**

音声チャンネルを通じてデータ伝送を実現する、TypeScript実装のオーディオモデムです。FSK（周波数偏移変調）とXModem風プロトコルによるデータ通信を提供します。

🎯 **[デモを試す](https://webaudio-modem.github.io/WebAudio-Modem/demo/)**

## ✨ 主要機能

### 📡 FSKモデム
- 周波数シフトキーイング
- I/Q検波による位相連続FSK変調・復調

### 🔄 XModem風プロトコル
- Stop-and-Wait ARQによる自動再送制御
- 自動データフラグメンテーション
- 可変長ペイロード

### 🎵 WebAudio統合
- AudioWorklet
- AbortController

## 🚀 クイックスタート


### 基本的な使用方法

```typescript
import { FSKCore, XModemTransport, WebAudioDataChannel } from 'webaudio-modem';

// FSKモデムの初期化
const fsk = new FSKCore({
  sampleRate: 48000,
  baud: 300,
  markFreq: 1270,
  spaceFreq: 1070
});

// XModemトランスポートの初期化
await WebAudioDataChannel.addModule(audioContext.value, 'processors/fsk-processor.js');
const dataChannel = new WebAudioDataChannel(audioContext.value, 'fsk-processor');
const transport = new XModemTransport(dataChannel);

// データ送信
const data = new TextEncoder().encode("Hello, World!");
await transport.send(data);

// データ受信
transport.on('data', (receivedData) => {
  console.log('受信:', new TextDecoder().decode(receivedData));
});
```

## 🏗️ アーキテクチャ

WebAudio-Modemは3層のモジュラーアーキテクチャを採用しています：

```
┌─────────────────────────────────────┐
│        アプリケーション層              │
├─────────────────────────────────────┤
│   データリンク層: XModem Transport    │  ← 自動再送、エラー訂正
├─────────────────────────────────────┤
│   物理層: FSK Modem                 │  ← 変調・復調、信号処理
├─────────────────────────────────────┤
│   インフラ層: WebAudio API          │  ← リアルタイム音声処理
└─────────────────────────────────────┘
```

### コアコンポーネント

| コンポーネント | 責務 | 特徴 |
|---------------|------|------|
| **XModemTransport** | プロトコル制御 | ARQ、CRC-16、フラグメンテーション |
| **WebAudioDataChannel** | FSKCore の WebAudio アダプタ | AudioWorklet、低遅延処理 |
| **FSKProcessor** | 音声I/O | AudioWorkletProcessor |
| **FSKCore** | FSK変調・復調 | 位相連続、I/Q検波、アダプティブ閾値 |

## 📊 テスト

```bash
npm run test

# ブラウザ統合テスト
npm run test:browser
```

## 🛠️ 開発者向け

### 開発環境のセットアップ

```bash
# リポジトリをクローン
git clone https://github.com/WebAudio-Modem/WebAudio-Modem.git
cd WebAudio-Modem

# 依存関係をインストール
npm install

# 開発サーバー起動
npm run dev
```

### 利用可能なコマンド

```bash
npm run dev        # 開発サーバー起動 (localhost:3000)
npm run build      # プロダクションビルド
npm run test       # 全テスト実行
npm run lint       # ESLint実行
npm run lint:fix   # ESLint自動修正
```

### プロジェクト構造

```
src/
├── core.ts                     # コアインターフェース
├── modems/fsk.ts              # FSK変調・復調エンジン
├── transports/xmodem/         # XModemプロトコル実装
├── dsp/filters.ts             # デジタル信号処理
├── webaudio/                  # WebAudio API統合
└── utils/                     # ユーティリティ関数

tests/                         # 包括的テストスイート
└── ...
```

## 📄 ライセンス

MIT License
