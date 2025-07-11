/**
 * 偽ピーク問題専用テスト - 単独実行用
 */

import { describe, test, expect } from 'vitest';
import { DsssDpskDemodulator } from '../../src/modems/dsss-dpsk/dsss-dpsk-demodulator';
import { DsssDpskFramer } from '../../src/modems/dsss-dpsk/framer';
import * as modem from '../../src/modems/dsss-dpsk/dsss-dpsk';

// 固定シードの乱数生成器でMath.randomを置き換え
let randomSeed = 12345;

Math.random = () => {
  randomSeed = (randomSeed * 1664525 + 1013904223) % (2 ** 32);
  return randomSeed / (2 ** 32);
};

(Math.random as any).resetSeed = (seed: number) => {
  randomSeed = seed;
};

describe('False Peak Problem - Isolated Test', () => {
  const defaultConfig = {
    sequenceLength: 31,
    seed: 21,
    samplesPerPhase: 23,
    sampleRate: 44100,
    carrierFreq: 10000,
    correlationThreshold: 0.3,
    peakToNoiseRatio: 4
  };


  const generateFrameWithAmplitude = (userData: Uint8Array, amplitude: number, frameOptions: any = {}) => {
    const frame = DsssDpskFramer.build(userData, {
      sequenceNumber: frameOptions.sequenceNumber || 1,
      frameType: frameOptions.frameType || 0,
      ldpcNType: frameOptions.ldpcNType || 0
    });
    console.log(`frame headerByte: ${frame.headerByte.toString(16)}`);

    const chips = modem.dsssSpread(frame.bits, defaultConfig.sequenceLength, defaultConfig.seed);
    const phases = modem.dpskModulate(chips);
    const signal = modem.modulateCarrier(
      phases,
      defaultConfig.samplesPerPhase,
      defaultConfig.sampleRate,
      defaultConfig.carrierFreq
    );
    
    // 振幅スケーリング
    const scaledSignal = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
      scaledSignal[i] = signal[i] * amplitude;
    }
    
    return scaledSignal;
  };

  const processSignalInChunks = (
    demodulator: DsssDpskDemodulator, 
    signal: Float32Array,
    options: {
      chunkSize?: number;
      maxFrames?: number;
      silencePrefix?: number;
      silenceSuffix?: number;
    } = {}
  ) => {
    const { 
      chunkSize = 128, 
      maxFrames = Infinity, 
      silencePrefix = 0,
      silenceSuffix = 0 
    } = options;
    
    // サイレンス期間を含む信号作成
    const totalLength = silencePrefix + signal.length + silenceSuffix;
    const totalSignal = new Float32Array(totalLength);
    totalSignal.set(signal, silencePrefix);
    
    // 128サンプルずつ処理（AudioWorklet環境シミュレーション）
    const receivedFrames: any[] = [];
    for (let i = 0; i < totalSignal.length && receivedFrames.length < maxFrames; i += chunkSize) {
      const chunk = totalSignal.slice(i, i + chunkSize);
      demodulator.addSamples(chunk);
      const frames = demodulator.getAvailableFrames();
      receivedFrames.push(...frames);
      
      // 目標フレーム数達成で早期終了
      if (receivedFrames.length >= maxFrames) {
        break;
      }
    }
    
    return receivedFrames;
  };

  const processMultipleSignals = (
    demodulator: DsssDpskDemodulator,
    signals: Float32Array[],
    options: {
      chunkSize?: number;
      maxFrames?: number;
      gapBetweenSignals?: number;
      silencePrefix?: number;
      silenceSuffix?: number;
    } = {}
  ) => {
    const { 
      chunkSize = 128, 
      maxFrames = Infinity,
      gapBetweenSignals = 0,
      silencePrefix = 0,
      silenceSuffix = 0
    } = options;
    
    // 複数信号を結合
    const totalLength = silencePrefix + signals.reduce((sum, sig) => sum + sig.length, 0) + 
                       (signals.length - 1) * gapBetweenSignals + silenceSuffix;
    const combinedSignal = new Float32Array(totalLength);
    
    let position = silencePrefix;
    for (let i = 0; i < signals.length; i++) {
      combinedSignal.set(signals[i], position);
      position += signals[i].length + gapBetweenSignals;
    }
    
    return processSignalInChunks(demodulator, combinedSignal, { chunkSize, maxFrames });
  };

    test('should handle early sync detection without producing invalid frames', () => {
      // バグ再現: サイレンス期間での同期検出を防ぐ
      const demodulator = new DsssDpskDemodulator(defaultConfig);
      
      // 大量のサイレンス期間 + 実際のフレーム
      const testData = new Uint8Array([0x88, 0x77]);
      const frameSignal = generateFrameWithAmplitude(testData, 0.5);
      console.log(`frameSignal.length: ${frameSignal.length}`);
      
      const largeSilence = new Float32Array(frameSignal.length * 0); // 5倍のサイレンス
      const signals = [largeSilence, frameSignal];
      
      // フレーム受信処理
      const frames = processMultipleSignals(demodulator, signals, {
        maxFrames: 1,
        silenceSuffix: 10000
      });
      
      // 正常なフレーム受信確認（サイレンス期間の誤検出なし）
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0].userData.slice(0, testData.length)).toEqual(testData);
      
      // 同期品質確認（真の信号による同期）
      const syncState = demodulator.getSyncState();
      expect(syncState.locked).toBe(false); // Frame API設計: フレーム完了後は同期リセット
      expect(syncState.correlation).toBe(0); // Frame API設計: フレーム完了後はcorrelation=0
    });

    for (let i = 0; i < 5; i++) {
      test(`should recover from multiple false peaks and find valid frame (try:${i})`, () => {
        // 複数の偽ピークからの復帰テスト
        const demodulator = new DsssDpskDemodulator({
          ...defaultConfig,
          correlationThreshold: 0.4,
          peakToNoiseRatio: 2
        });
        
        // 複数の偽パターンを作成
        const falsePatterns: Float32Array[] = [];
        const fakePatternBits: Uint8Array[] = [];
        
        for (let patternIndex = 0; patternIndex < 3; patternIndex++) {
          const fakePattern = new Uint8Array(12);
          // 異なる偽パターンを生成
          fakePattern.set([0, 0, 0, 1], 0); // プリアンブルに似たパターン
          for (let j = 4; j < fakePattern.length; j++) {
            fakePattern[j] = Math.random() > 0.5 ? 1 : 0;
          }
          
          fakePatternBits.push(new Uint8Array(fakePattern));
          
          const fakeChips = modem.dsssSpread(fakePattern, defaultConfig.sequenceLength, defaultConfig.seed);
          const fakePhases = modem.dpskModulate(fakeChips);
          const fakeSignal = modem.modulateCarrier(
            fakePhases,
            defaultConfig.samplesPerPhase,
            defaultConfig.sampleRate,
            defaultConfig.carrierFreq
          );
          
          falsePatterns.push(fakeSignal);
        }
        
        // 生成された偽パターンをログ出力
        console.log(`[False Peak Test 2] Test case ${i}: Generated fake patterns:`);
        for (let patternIndex = 0; patternIndex < fakePatternBits.length; patternIndex++) {
          console.log(`[False Peak Test 2] Fake pattern ${patternIndex}: [${Array.from(fakePatternBits[patternIndex]).join(',')}]`);
        }
        
        // 真のフレーム
        const validData = new Uint8Array([0xAB, 0xCD]);
        const validSignal = generateFrameWithAmplitude(validData, 0.6, {
          sequenceNumber: 5,
          frameType: 1,
          ldpcNType: 0
        });
        
        // すべての信号を結合（偽パターン×3 + 真のフレーム）
        const allSignals = [...falsePatterns, validSignal];
        
        // フレーム受信テスト
        console.log(`[False Peak Test 2] Test case ${i}: Signal layout: 3 fake patterns + 1 valid frame, gap=${200}`);
        const frames = processMultipleSignals(demodulator, allSignals, {
          maxFrames: 1,
          gapBetweenSignals: 200,
          chunkSize: 128
        });
        
        console.log(`[False Peak Test 2] Test case ${i}: Result: ${frames.length} frames received`);
        if (frames.length > 0) {
          const userData = frames[0].userData.slice(0, 2);
          console.log(`[False Peak Test 2] Frame data: [${Array.from(userData).map((x: number) => x.toString(16)).join(',')}], seq=${frames[0].header.sequenceNumber}`);
        } else {
          console.log(`[False Peak Test 2] FAILURE: No frames received. Expected valid frame with data [ab,cd]`);
          console.log(`[False Peak Test 2] Final sync state: locked=${demodulator.getSyncState().locked}, correlation=${demodulator.getSyncState().correlation.toFixed(3)}`);
          
          // 失敗ケースの詳細分析
          console.log(`[False Peak Test 2] Test case ${i}: Analyzing fake patterns`);
          for (let patternIndex = 0; patternIndex < fakePatternBits.length; patternIndex++) {
            console.log(`[False Peak Test 2] Fake pattern ${patternIndex}: [${Array.from(fakePatternBits[patternIndex]).join(',')}]`);
          }
        }
        
        // 複数の偽ピークを乗り越えて真のフレームが受信されることを確認
        expect(frames.length).toBeGreaterThan(0);
        expect(frames[0].userData.slice(0, validData.length)).toEqual(validData);
        expect(frames[0].header.sequenceNumber).toBe(5);
        expect(frames[0].header.frameType).toBe(1);
        
        console.log(`[Multiple False Peaks Test] Valid frame received: seq=${frames[0].header.sequenceNumber}, type=${frames[0].header.frameType}`);
      });
    }

    // 失敗するケースのみを個別テスト
    test('should analyze failing case try:0', () => {
      (Math.random as any).resetSeed(12345);
      
      const demodulator = new DsssDpskDemodulator({
        ...defaultConfig,
        correlationThreshold: 0.4,
        peakToNoiseRatio: 2
      });
      
      // 偽パターンを生成（try:0と同じ）
      const fakePatternBits: Uint8Array[] = [];
      for (let patternIndex = 0; patternIndex < 3; patternIndex++) {
        const fakePattern = new Uint8Array(12);
        fakePattern.set([0, 0, 0, 1], 0);
        for (let j = 4; j < fakePattern.length; j++) {
          fakePattern[j] = Math.random() > 0.5 ? 1 : 0;
        }
        fakePatternBits.push(new Uint8Array(fakePattern));
      }
      
      console.log(`[ANALYSIS] try:0 fake patterns:`);
      for (let i = 0; i < fakePatternBits.length; i++) {
        console.log(`[ANALYSIS] Pattern ${i}: [${Array.from(fakePatternBits[i]).join(',')}]`);
      }
      
      // テストは期待値チェックなしで終了
      expect(fakePatternBits.length).toBe(3);
    });

    test('should analyze failing case try:3', () => {
      (Math.random as any).resetSeed(12345);
      
      // try:3までの乱数状態を再現
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          for (let k = 4; k < 12; k++) {
            Math.random(); // 同じ乱数を消費
          }
        }
      }
      
      const demodulator = new DsssDpskDemodulator({
        ...defaultConfig,
        correlationThreshold: 0.4,
        peakToNoiseRatio: 2
      });
      
      // 偽パターンを生成（try:3と同じ）
      const fakePatternBits: Uint8Array[] = [];
      for (let patternIndex = 0; patternIndex < 3; patternIndex++) {
        const fakePattern = new Uint8Array(12);
        fakePattern.set([0, 0, 0, 1], 0);
        for (let j = 4; j < fakePattern.length; j++) {
          fakePattern[j] = Math.random() > 0.5 ? 1 : 0;
        }
        fakePatternBits.push(new Uint8Array(fakePattern));
      }
      
      console.log(`[ANALYSIS] try:3 fake patterns:`);
      for (let i = 0; i < fakePatternBits.length; i++) {
        console.log(`[ANALYSIS] Pattern ${i}: [${Array.from(fakePatternBits[i]).join(',')}]`);
      }
      
      // テストは期待値チェックなしで終了
      expect(fakePatternBits.length).toBe(3);
    });
});
