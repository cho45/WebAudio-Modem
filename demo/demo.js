/**
 * WebAudio-Modem Vue3 Demo
 * 
 * Vue3 Composition APIを使用したテキスト・画像送受信デモ
 */

import { createApp, ref, reactive, computed, onMounted, nextTick } from 'https://unpkg.com/vue@3/dist/vue.esm-browser.js';
import { WebAudioDataChannel } from '../src/webaudio/webaudio-data-channel.js';
import { DEFAULT_FSK_CONFIG } from '../src/modems/fsk.js';
import { XModemTransport } from '../src/transports/xmodem/xmodem.js';


const app = createApp({
  setup() {
    // システム状態
    const audioContext = ref(null);
    const senderDataChannel = ref(null);
    const receiverDataChannel = ref(null);
    const senderTransport = ref(null);
    const receiverTransport = ref(null);
    const currentStream = ref(null);
    
    // Analyser nodes for visualization
    const senderAnalyser = ref(null);
    const receiverAnalyser = ref(null);
    
    // Canvas references
    const senderWaveformCanvas = ref(null);
    const senderSpectrumCanvas = ref(null);
    const receiverWaveformCanvas = ref(null);
    const receiverSpectrumCanvas = ref(null);
    
    // UI状態
    const systemReady = ref(false);
    const isReceiving = ref(false);
    const isSending = ref(false);
    const showDebug = ref(false);
    const sendDataType = ref('text');
    const inputText = ref('Hello World');
    const selectedImage = ref(null);
    const systemLog = ref('');
    const currentSendStream = ref(null);
    
    // ステータス管理
    const systemStatus = reactive({ message: 'Click Initialize to start', type: 'info' });
    const sendStatus = reactive({ message: 'Initialize system first', type: 'info' });
    const receiveStatus = reactive({ message: 'Initialize system first', type: 'info' });
    
    // 受信データ
    const receivedData = ref([]);
    const receivingFragments = ref([]);
    const receivingProgress = ref({
      totalFragments: 0,
      totalBytes: 0,
      estimatedTotal: 0,
      startTime: null,
      lastFragmentTime: null,
      isReceiving: false
    });
    
    // デバッグ情報
    const senderDebugInfo = ref('No debug info');
    const receiverDebugInfo = ref('No debug info');
    
    // Computed properties
    const canSend = computed(() => {
      if (!systemReady.value || isSending.value) return false;
      if (sendDataType.value === 'text') return inputText.value.trim().length > 0;
      if (sendDataType.value === 'image') return selectedImage.value !== null;
      return false;
    });
    
    // Visualization variables
    let animationId = null;
    let senderWaveformData = null;
    let senderSpectrumData = null;
    let receiverWaveformData = null;
    let receiverSpectrumData = null;
    
    // ログ出力
    const log = (message) => {
      const timestamp = new Date().toLocaleTimeString();
      const logEntry = `[${timestamp}] ${message}`;
      systemLog.value += logEntry + '\n';
      console.log(logEntry);
      
      // Auto-scroll to bottom
      nextTick(() => {
        const textarea = document.querySelector('.system-log textarea');
        if (textarea) {
          textarea.scrollTop = textarea.scrollHeight;
        }
      });
    };
    
    // ステータス更新
    const updateStatus = (statusObj, message, type = 'info') => {
      statusObj.message = message;
      statusObj.type = type;
    };
    
    // システム初期化
    const initializeSystem = async () => {
      try {
        log('Initializing audio system...');
        updateStatus(systemStatus, 'Initializing...', 'info');
        
        // AudioContext作成
        audioContext.value = new AudioContext();
        log(`AudioContext created: ${audioContext.value.sampleRate}Hz`);
        
        // AudioContextの再開
        if (audioContext.value.state === 'suspended') {
          await audioContext.value.resume();
          log('AudioContext resumed');
        }
        
        // AudioWorkletモジュール追加
        await WebAudioDataChannel.addModule(audioContext.value, '../src/webaudio/processors/fsk-processor.js');
        log('FSK processor module loaded');
        
        // データチャネル作成
        senderDataChannel.value = new WebAudioDataChannel(audioContext.value, 'fsk-processor', {
          processorOptions: { name: 'sender' }
        });
        receiverDataChannel.value = new WebAudioDataChannel(audioContext.value, 'fsk-processor', {
          processorOptions: { name: 'receiver' }
        });
        log('AudioWorkletNodes created');
        
        // Analyser nodes作成
        senderAnalyser.value = audioContext.value.createAnalyser();
        receiverAnalyser.value = audioContext.value.createAnalyser();
        senderAnalyser.value.fftSize = 2048;
        receiverAnalyser.value.fftSize = 2048;
        
        // Analyser nodesを接続
        senderDataChannel.value.connect(senderAnalyser.value);
        receiverDataChannel.value.connect(receiverAnalyser.value);
        
        // FSK設定
        const config = {
          ...DEFAULT_FSK_CONFIG,
          sampleRate: audioContext.value.sampleRate
        };
        
        log('Configuring FSK processors with settings:', config);
        await senderDataChannel.value.configure(config);
        await receiverDataChannel.value.configure(config);
        log('FSK processors configured successfully');
        
        // XModemトランスポート作成
        senderTransport.value = new XModemTransport(senderDataChannel.value);
        receiverTransport.value = new XModemTransport(receiverDataChannel.value);
        
        // XModem設定
        const xmodemConfig = {
          timeoutMs: 5000,
          maxRetries: 3,
          maxPayloadSize: 64
        };
        senderTransport.value.configure(xmodemConfig);
        receiverTransport.value.configure(xmodemConfig);
        log('XModem transports configured successfully');
        
        systemReady.value = true;
        updateStatus(systemStatus, 'System initialized successfully ✓', 'success');
        updateStatus(sendStatus, 'Ready to send', 'success');
        updateStatus(receiveStatus, 'Ready to receive', 'success');
        log('System initialization complete');
        
        // デバッグ情報の定期更新開始
        startDebugUpdates();
        
        // 可視化開始
        startVisualization();
        
      } catch (error) {
        const errorMsg = `Initialization failed: ${error.message}`;
        log(errorMsg);
        updateStatus(systemStatus, errorMsg, 'error');
        updateStatus(sendStatus, 'System initialization required', 'error');
        updateStatus(receiveStatus, 'System initialization required', 'error');
      }
    };
    
    // データ送信
    const sendData = async () => {
      if (!systemReady.value || isSending.value) {
        updateStatus(sendStatus, 'System not initialized or already sending', 'error');
        return;
      }
      
      try {
        let data;
        let description;
        
        if (sendDataType.value === 'text') {
          const text = inputText.value.trim();
          if (!text) {
            updateStatus(sendStatus, 'Please enter text to send', 'error');
            return;
          }
          data = new TextEncoder().encode(text);
          description = `text: "${text}"`;
        } else if (sendDataType.value === 'image' && selectedImage.value) {
          data = selectedImage.value.data;
          description = `image: ${selectedImage.value.name} (${selectedImage.value.size} bytes)`;
        } else {
          updateStatus(sendStatus, 'Please select data to send', 'error');
          return;
        }
        
        isSending.value = true;
        log(`Sending ${description}`);
        updateStatus(sendStatus, 'Preparing XModem transmission...', 'info');
        
        // マイク入力取得
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            sampleRate: audioContext.value.sampleRate,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          } 
        });
        
        currentSendStream.value = stream;
        log(`Microphone access granted: ${audioContext.value.sampleRate}Hz, 1 channel`);
        
        // 送信者を音声出力に接続
        senderDataChannel.value.disconnect();
        senderDataChannel.value.connect(audioContext.value.destination);
        senderDataChannel.value.connect(senderAnalyser.value);
        log('Connected sender to audio output');
        
        // マイクを送信者に接続
        const source = audioContext.value.createMediaStreamSource(stream);
        source.connect(senderDataChannel.value);
        log('Connected: microphone → sender');
        
        log(`Sending ${data.length} bytes via XModem protocol`);
        updateStatus(sendStatus, '🎤 Sending via XModem...', 'info');
        
        await senderTransport.value.sendData(data);
        
        if (isSending.value) {
          updateStatus(sendStatus, `✓ XModem send completed: ${description}`, 'success');
          log('XModem transmission completed successfully');
        }
        
      } catch (error) {
        if (isSending.value) {
          let errorMsg = `XModem send failed: ${error.message}`;
          
          if (error.message.includes('Transport busy')) {
            errorMsg = 'Sender is busy. Please wait and try again.';
            log('Sender transport is currently busy');
          } else if (error.message.includes('timeout')) {
            errorMsg = 'Send timeout. No receiver found or connection failed.';
            log('XModem send timed out - no receiver response');
          }
          
          log(errorMsg);
          updateStatus(sendStatus, errorMsg, 'error');
        }
      } finally {
        // Clean up
        if (currentSendStream.value) {
          currentSendStream.value.getTracks().forEach(track => track.stop());
          currentSendStream.value = null;
        }
        isSending.value = false;
      }
    };
    
    // 送信停止
    const stopSending = () => {
      if (!isSending.value) return;
      
      isSending.value = false;
      
      if (currentSendStream.value) {
        currentSendStream.value.getTracks().forEach(track => {
          track.stop();
          log(`Stopped microphone track: ${track.kind}`);
        });
        currentSendStream.value = null;
      }
      
      if (senderDataChannel.value) {
        senderDataChannel.value.disconnect();
        senderDataChannel.value.connect(senderAnalyser.value);
        log('Disconnected sender from microphone');
      }
      
      updateStatus(sendStatus, 'Sending stopped', 'info');
      log('XModem sending stopped');
    };
    
    // XModemループバックテスト
    const testXModemLoopback = async () => {
      if (!systemReady.value) {
        updateStatus(systemStatus, 'System not initialized', 'error');
        return;
      }
      
      try {
        let data;
        let description;
        
        if (sendDataType.value === 'text') {
          const text = inputText.value.trim();
          if (!text) {
            updateStatus(systemStatus, 'Please enter text to test', 'error');
            return;
          }
          data = new TextEncoder().encode(text);
          description = text;
        } else if (sendDataType.value === 'image' && selectedImage.value) {
          data = selectedImage.value.data;
          description = selectedImage.value.name;
        } else {
          updateStatus(systemStatus, 'Please select data to test', 'error');
          return;
        }
        
        log(`Starting XModem loopback test with: ${description}`);
        updateStatus(systemStatus, 'Running XModem loopback test...', 'info');
        
        // 接続リセット
        senderDataChannel.value.disconnect();
        receiverDataChannel.value.disconnect();
        
        // ハブ作成してループバック接続
        const hub = audioContext.value.createGain();
        hub.gain.value = 1.0;
        senderDataChannel.value.connect(hub);
        receiverDataChannel.value.connect(hub);
        hub.connect(audioContext.value.destination);
        hub.connect(senderDataChannel.value);
        hub.connect(receiverDataChannel.value);
        
        // Analyser接続も復旧
        senderDataChannel.value.connect(senderAnalyser.value);
        receiverDataChannel.value.connect(receiverAnalyser.value);
        
        log('Connected: sender → receiver (internal loopback)');
        log(`Testing ${data.length} bytes via XModem protocol`);

        receiverTransport.value.on('fragmentReceived', onFragmentReceived);
        
        // 送受信開始
        log('Starting sender...');
        const sendPromise = senderTransport.value.sendData(data);
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        log('Starting receiver...');
        const receivePromise = receiverTransport.value.receiveData();
        
        const [_, receivedData] = await Promise.all([sendPromise, receivePromise]);
        
        // 結果処理
        if (sendDataType.value === 'text') {
          const receivedText = new TextDecoder().decode(receivedData);
          log(`XModem loopback result: "${receivedText}"`);
          
          addReceivedData('text', receivedText);
          
          if (receivedText === description) {
            updateStatus(systemStatus, '✓ Perfect XModem loopback!', 'success');
            log('XModem loopback test: PASSED - Perfect match');
          } else {
            updateStatus(systemStatus, `⚠ Partial match: "${receivedText}"`, 'info');
            log(`XModem loopback test: PARTIAL - Expected: "${description}", Got: "${receivedText}"`);
          }
        } else {
          // 画像の場合
          const blob = new Blob([receivedData], { type: selectedImage.value.type });
          const url = URL.createObjectURL(blob);
          addReceivedData('image', url);
          
          if (receivedData.length === data.length) {
            updateStatus(systemStatus, '✓ Perfect XModem image loopback!', 'success');
            log('XModem image loopback test: PASSED - Size match');
          } else {
            updateStatus(systemStatus, `⚠ Size mismatch: expected ${data.length}, got ${receivedData.length}`, 'info');
            log(`XModem image loopback test: PARTIAL - Size mismatch`);
          }
        }
        
      } catch (error) {
        const errorMsg = `XModem loopback test failed: ${error.message}`;
        log(errorMsg);
        updateStatus(systemStatus, errorMsg, 'error');
      }
    };
    
    // 受信データ追加
    const addReceivedData = (type, content) => {
      receivedData.value.push({
        type,
        content,
        timestamp: new Date().toLocaleTimeString()
      });
    };
    
    // フラグメント受信リスナー
    const onFragmentReceived = (event) => {
        console.log('Fragment received:', event.data);
      const data = event.data;
      const now = Date.now();
      
      // 受信開始時刻を記録
      if (!receivingProgress.value.startTime) {
        receivingProgress.value.startTime = now;
      }
      
      // フラグメント情報を追加
      receivingFragments.value.push({
        seqNum: data.seqNum,
        size: data.fragment.length,
        timestamp: new Date(data.timestamp).toLocaleTimeString(),
        data: data.fragment
      });
      
      // 受信レートを計算
      const elapsedMs = now - receivingProgress.value.startTime;
      const bytesPerSecond = elapsedMs > 0 ? (data.totalBytesReceived * 1000) / elapsedMs : 0;
      
      // プログレス情報を更新
      receivingProgress.value = {
        totalFragments: data.totalFragments,
        totalBytes: data.totalBytesReceived,
        estimatedTotal: 0, // 終了時に分かる
        startTime: receivingProgress.value.startTime,
        lastFragmentTime: now,
        bytesPerSecond: Math.round(bytesPerSecond),
        isReceiving: true
      };
      
      // 詳細ログ出力
      log(`📦 Fragment #${data.seqNum}: ${data.fragment.length}B, total: ${data.totalBytesReceived}B (${receivingProgress.value.bytesPerSecond}B/s)`);
      
      // テキストの場合は部分的に表示
      if (isTextData(data.fragment)) {
        const partialText = new TextDecoder().decode(data.fragment);
        updateStatus(receiveStatus, `📦 Fragment #${data.seqNum}: "${partialText}" (${data.totalBytesReceived}B @ ${receivingProgress.value.bytesPerSecond}B/s)`, 'info');
      } else {
        updateStatus(receiveStatus, `📦 Fragment #${data.seqNum}: ${data.fragment.length}B (${data.totalBytesReceived}B @ ${receivingProgress.value.bytesPerSecond}B/s)`, 'info');
      }
    };
    
    // 受信開始
    const startReceiving = async () => {
      if (isReceiving.value || !systemReady.value) return;
      
      try {
        log('Starting XModem reception...');
        updateStatus(receiveStatus, 'Starting microphone input...', 'info');
        
        // フラグメント状態をリセット
        receivingFragments.value = [];
        receivingProgress.value = {
          totalFragments: 0,
          totalBytes: 0,
          estimatedTotal: 0,
          startTime: null,
          lastFragmentTime: null,
          bytesPerSecond: 0,
          isReceiving: false
        };
        
        // フラグメント受信リスナーを登録
        receiverTransport.value.on('fragmentReceived', onFragmentReceived);
        
        // マイク入力取得
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: audioContext.value.sampleRate,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });
        
        log(`Microphone access granted: ${audioContext.value.sampleRate}Hz, 1 channel`);
        
        // 受信者接続
        receiverDataChannel.value.disconnect();
        receiverDataChannel.value.connect(audioContext.value.destination);
        receiverDataChannel.value.connect(receiverAnalyser.value);
        
        const source = audioContext.value.createMediaStreamSource(stream);
        source.connect(receiverDataChannel.value);
        log('Connected: microphone → receiver');
        
        isReceiving.value = true;
        currentStream.value = stream;
        updateStatus(receiveStatus, '🎤 Listening for XModem transmission...', 'success');
        log('XModem reception started - waiting for data...');
        
        // 受信ループ
        const receiveLoop = async () => {
          while (isReceiving.value) {
            try {
              log('Waiting for XModem data...');
              updateStatus(receiveStatus, '🎤 Waiting for XModem transmission...', 'info');
              
              const receivedBytes = await receiverTransport.value.receiveData();
              
              if (receivedBytes.length > 0) {
                // 受信完了後の処理
                receivingProgress.value.isReceiving = false;
                
                // データ種別判定（簡易的）
                const isText = isTextData(receivedBytes);
                
                if (isText) {
                  const text = new TextDecoder().decode(receivedBytes);
                  log(`✅ XModem completed - received text: ${receivedBytes.length} bytes → "${text}"`);
                  addReceivedData('text', text);
                  updateStatus(receiveStatus, `📡 XModem completed: "${text}"`, 'success');
                } else {
                  // 画像として処理
                  const blob = new Blob([receivedBytes], { type: 'image/jpeg' });
                  const url = URL.createObjectURL(blob);
                  log(`✅ XModem completed - received image: ${receivedBytes.length} bytes`);
                  addReceivedData('image', url);
                  updateStatus(receiveStatus, `📡 XModem completed - image: ${receivedBytes.length} bytes`, 'success');
                }
                
                // 次の送信待機状態に戻る
                setTimeout(() => {
                  if (isReceiving.value) {
                    receivingFragments.value = []; // フラグメントリストをクリア
                    updateStatus(receiveStatus, '🎤 Listening for next XModem transmission...', 'info');
                  }
                }, 2000);
              }
            } catch (error) {
              if (isReceiving.value) {
                log(`XModem reception error: ${error.message}`);
                
                if (error.message.includes('Transport busy')) {
                  log('Receiver is busy, waiting before retry...');
                  await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                  updateStatus(receiveStatus, `Reception error: ${error.message}`, 'error');
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }
              }
            }
          }
        };
        
        receiveLoop();
        
      } catch (error) {
        const errorMsg = `Failed to start XModem reception: ${error.message}`;
        log(errorMsg);
        updateStatus(receiveStatus, errorMsg, 'error');
        isReceiving.value = false;
        receivingProgress.value.isReceiving = false;
      }
    };
    
    // 受信停止
    const stopReceiving = () => {
      if (!isReceiving.value) return;
      
      isReceiving.value = false;
      receivingProgress.value.isReceiving = false;
      
      // フラグメント受信リスナーを削除
      if (receiverTransport.value) {
        receiverTransport.value.off('fragmentReceived', onFragmentReceived);
      }
      
      if (currentStream.value) {
        currentStream.value.getTracks().forEach(track => {
          track.stop();
          log(`Stopped microphone track: ${track.kind}`);
        });
        currentStream.value = null;
      }
      
      if (receiverDataChannel.value) {
        receiverDataChannel.value.disconnect();
        receiverDataChannel.value.connect(receiverAnalyser.value);
        log('Disconnected receiver from microphone');
      }
      
      updateStatus(receiveStatus, 'Stopped receiving', 'info');
      log('XModem reception stopped');
    };
    
    // データがテキストかどうかの簡易判定
    const isTextData = (data) => {
      // ASCII範囲内の文字が多い場合はテキストと判定
      let textChars = 0;
      const sampleSize = Math.min(100, data.length);
      
      for (let i = 0; i < sampleSize; i++) {
        const byte = data[i];
        if ((byte >= 32 && byte <= 126) || byte === 10 || byte === 13 || byte === 9) {
          textChars++;
        }
      }
      
      return textChars / sampleSize > 0.7;
    };
    
    // 画像選択
    const onImageSelect = async (event) => {
      const file = event.target.files[0];
      if (!file) {
        selectedImage.value = null;
        return;
      }
      
      if (!file.type.startsWith('image/')) {
        alert('Please select an image file');
        return;
      }
      
      try {
        const arrayBuffer = await file.arrayBuffer();
        const preview = URL.createObjectURL(file);
        
        selectedImage.value = {
          name: file.name,
          size: file.size,
          type: file.type,
          data: new Uint8Array(arrayBuffer),
          preview
        };
        
        log(`Image selected: ${file.name} (${file.size} bytes)`);
      } catch (error) {
        log(`Failed to load image: ${error.message}`);
        selectedImage.value = null;
      }
    };
    
    // デバッグ切り替え
    const toggleDebug = () => {
      showDebug.value = !showDebug.value;
    };
    
    // デバッグ情報更新開始
    const startDebugUpdates = () => {
      setInterval(async () => {
        if (showDebug.value && systemReady.value) {
          try {
            if (senderDataChannel.value) {
              const senderInfo = await senderDataChannel.value.getStatus();
              senderDebugInfo.value = JSON.stringify(senderInfo, null, 2);
            }
            if (receiverDataChannel.value) {
              const receiverInfo = await receiverDataChannel.value.getStatus();
              receiverDebugInfo.value = JSON.stringify(receiverInfo, null, 2);
            }
          } catch (error) {
            // デバッグ情報取得エラーは無視
          }
        }
      }, 500);
    };
    
    // 可視化開始
    const startVisualization = () => {
      if (!senderAnalyser.value || !receiverAnalyser.value) return;
      
      const bufferLength = senderAnalyser.value.frequencyBinCount;
      senderWaveformData = new Uint8Array(bufferLength);
      senderSpectrumData = new Uint8Array(bufferLength);
      receiverWaveformData = new Uint8Array(bufferLength);
      receiverSpectrumData = new Uint8Array(bufferLength);
      
      const animate = () => {
        if (!systemReady.value) return;
        
        // データ取得
        senderAnalyser.value.getByteTimeDomainData(senderWaveformData);
        senderAnalyser.value.getByteFrequencyData(senderSpectrumData);
        receiverAnalyser.value.getByteTimeDomainData(receiverWaveformData);
        receiverAnalyser.value.getByteFrequencyData(receiverSpectrumData);
        
        // 描画
        drawWaveform(senderWaveformCanvas.value, senderWaveformData);
        drawSpectrum(senderSpectrumCanvas.value, senderSpectrumData);
        drawWaveform(receiverWaveformCanvas.value, receiverWaveformData);
        drawSpectrum(receiverSpectrumCanvas.value, receiverSpectrumData);
        
        animationId = requestAnimationFrame(animate);
      };
      
      animate();
    };
    
    // 波形描画
    const drawWaveform = (canvas, data) => {
      if (!canvas || !data) return;
      
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;
      
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#0f0';
      ctx.beginPath();
      
      const sliceWidth = width / data.length;
      let x = 0;
      
      for (let i = 0; i < data.length; i++) {
        const v = data[i] / 128.0;
        const y = v * height / 2;
        
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        
        x += sliceWidth;
      }
      
      ctx.stroke();
    };
    
    // スペクトラム描画
    const drawSpectrum = (canvas, data) => {
      if (!canvas || !data) return;
      
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;
      
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      
      const barWidth = width / data.length;
      let x = 0;
      
      for (let i = 0; i < data.length; i++) {
        const barHeight = (data[i] / 255) * height;
        
        ctx.fillStyle = `hsl(${i / data.length * 360}, 100%, 50%)`;
        ctx.fillRect(x, height - barHeight, barWidth, barHeight);
        
        x += barWidth;
      }
    };
    
    // 全クリア
    const clearAll = () => {
      receivedData.value = [];
      receivingFragments.value = [];
      receivingProgress.value = {
        totalFragments: 0,
        totalBytes: 0,
        estimatedTotal: 0,
        startTime: null,
        lastFragmentTime: null,
        bytesPerSecond: 0,
        isReceiving: false
      };
      systemLog.value = '';
      log('All data and logs cleared');
    };
    
    // マウント時の処理
    onMounted(() => {
      log('WebAudio-Modem Vue3 Demo loaded');
    });
    
    // コンポーネント破棄時の処理
    const cleanup = () => {
      if (animationId) {
        cancelAnimationFrame(animationId);
      }
      if (isReceiving.value) {
        stopReceiving();
      }
      if (isSending.value) {
        stopSending();
      }
    };
    
    return {
      // State
      systemReady,
      isReceiving,
      isSending,
      showDebug,
      sendDataType,
      inputText,
      selectedImage,
      systemLog,
      systemStatus,
      sendStatus,
      receiveStatus,
      receivedData,
      receivingFragments,
      receivingProgress,
      senderDebugInfo,
      receiverDebugInfo,
      
      // Computed
      canSend,
      
      // Canvas refs
      senderWaveformCanvas,
      senderSpectrumCanvas,
      receiverWaveformCanvas,
      receiverSpectrumCanvas,
      
      // Methods
      initializeSystem,
      sendData,
      stopSending,
      testXModemLoopback,
      startReceiving,
      stopReceiving,
      onImageSelect,
      toggleDebug,
      clearAll,
      cleanup
    };
  }
});

app.mount('#app');
