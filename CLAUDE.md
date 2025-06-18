# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Modern Development Plan

**IMPORTANT**: This repository is in the process of implementing a modern FSK modem. Always refer to `MODERN_FSK_DEVELOPMENT_PLAN.md` for:
- Current development roadmap and phases
- Modern architecture design with AudioWorklet
- TypeScript implementation guidelines
- Testing strategies for Web Audio components
- Extensible modulation interface for FSK/PSK/QAM support

The existing FSK implementation in `FSK/` directory is legacy code for reference only.

## Project Overview

WebAudio-Modem is a JavaScript-based audio modem implementation using the Web Audio API. The project implements FSK (Frequency Shift Keying) modulation for data transmission over audio channels.

## Architecture

The codebase consists of several key components:

### Core FSK Implementation (`FSK/fsk.js`)
- **FSK class**: Main modulation/demodulation engine
- **Modulation**: Converts binary data to audio signals using mark/space frequencies
- **Demodulation**: Processes incoming audio to extract binary data
- **Configuration**: Supports configurable baudrate, frequencies, and bit timing

### Modem Protocol (`FSK/modem-demo.js`)
- **AModem class**: Higher-level protocol implementation
- **Dual-channel communication**: Separate channels for master/slave operation
- **Error handling**: Implements ACK/NAK protocol for reliable transmission
- **Packet structure**: Fixed-size chunks with checksums

### Web Interface (`FSK/index.html`, `FSK/demo.js`)
- **Angular.js application**: Simple modulator/demodulator interface
- **Real-time visualization**: Canvas-based waveform display using ring buffers
- **Microphone input**: getUserMedia integration for audio capture

### Utilities (`FSK/lib/ring_buffer.js`)
- **RingBuffer class**: Circular buffer implementation for audio data streaming
- **Efficient memory usage**: Fixed-size buffers for real-time processing

## Key Technical Details

### Audio Processing
- Uses Web Audio API AudioContext for all audio operations
- Downsampling factor of 8 for performance optimization
- Real-time processing with ScriptProcessorNode (legacy) or AudioWorklet

### Signal Processing
- FSK modulation with configurable mark/space frequencies
- Default frequencies: 1650Hz (mark), 1850Hz (space)
- Envelope detection for demodulation
- Threshold-based bit detection

### Protocol Implementation
- Start/stop bit framing (configurable)
- 8-bit data units with parity options
- Packet-based transmission with error correction
- Dual-frequency channels for full-duplex communication

## Legacy Implementation (Reference Only)

The `FSK/` directory contains the original implementation for reference:
- Open `FSK/index.html` or `FSK/modem.html` in a web browser
- Uses legacy ScriptProcessorNode (deprecated)
- Bootstrap 3 and Angular 1.x dependencies

**DO NOT EXTEND** the legacy implementation. All new development should follow the modern plan.

## Modern Implementation Guidelines

When working on the new implementation:

1. **Architecture**: Follow the modular design in `MODERN_FSK_DEVELOPMENT_PLAN.md`
2. **File Structure**: Use the simplified directory structure (`src/core.ts`, `src/modulators/fsk.ts`, etc.)
3. **AudioWorklet**: Always use AudioWorklet for audio processing (no ScriptProcessorNode)
4. **TypeScript**: All new code must be TypeScript with proper type definitions
5. **Testing**: Implement the multi-layer testing strategy (DSP core separation, mocking, browser integration)
6. **Extensibility**: Design for future PSK/QAM support through the IModulator interface

## Common Development Commands

When the modern implementation is started:
```bash
npm run dev      # Start development server
npm run build    # Build for production
npm run test     # Run all tests
npm run lint     # Run ESLint
```

## Key Technical Decisions

- **AudioWorklet Required**: No fallback to legacy APIs
- **Modern Browsers Only**: Chrome 90+, Firefox 90+, Safari 14+
- **No Prettier**: Code formatting managed by ESLint only
- **Modular Design**: Single file per major component to keep project simple

## 開発方針

### テストと品質への妥協なき姿勢
- **すべての機能は動作するテストと共に実装する**
- **問題が発生した場合は無効化ではなく根本原因を特定し修正する**
- **アルゴリズムの理論的正しさを数学的に検証する**
- **エッジケースと境界条件を網羅的にテストする**
- **テストを通すことではなく、正しい実装を行うことが目的である**
- **テストが失敗する場合は、実装を修正してアルゴリズムを正しく動作させる**

### コード品質基準
- **実装はアルゴリズムの理論に忠実であること**
- **すべてのパブリックAPIが完全にテストされていること**
- **エラー処理が適切に実装されていること**

テストが失敗した場合は、その原因をまずはよく考える。
一時的な無効化や回避策は技術的負債を生むため避ける。

仮のデバッグコードを書きたくなった場合はそれもテストコードとして落とし込む。
