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
    
    // Analyser nodes for visualization
    const outputGain = ref(null);
    const inputAnalyser = ref(null);
    
    // Canvas references
    const visualizerCanvas = ref(null);
    
    // Log content refs
    const sendLogContent = ref(null);
    const receiveLogContent = ref(null);
    
    // UI状態
    const systemReady = ref(false);
    const isSending = ref(false);
    const showDebug = ref(false);
    const showVisualization = ref(true);
    const sendDataType = ref('text');
    const inputText = ref('Hello World');
    const selectedImage = ref(null);
    const sampleImageSelection = ref('');
    
    // マイク権限と入力ソース管理
    const microphonePermission = ref(false);
    const microphoneStream = ref(null);
    const inputSource = ref('loopback'); // 'loopback' | 'microphone'
    
    // サンプル画像ファイル定義
    const sampleImages = ref([
      { value: '', name: 'Custom file...', description: 'Upload your own file' },
      { value: 'jpg-interlaced.jpg', name: 'JPEG progressive (5.7K)', description: 'Progressive JPEG image' },
      { value: 'png-8.png', name: 'PNG 8-bit (9.5K)', description: '8-bit PNG image' },
      { value: 'png-interlaced.png', name: 'PNG Interlaced (12K)', description: 'Interlaced PNG image' },
      { value: 'webp.webp', name: 'WebP not progressive (3.8K)', description: 'WebP image' }
    ]);
    const systemLog = ref('');
    const sendLog = ref('');
    const receiveLog = ref('');
    
    // ステータス管理
    const systemStatus = reactive({ message: 'Click Initialize to start', type: 'info' });
    const sendStatus = reactive({ message: 'Initialize system first', type: 'info' });
    const receiveStatus = reactive({ message: 'Initialize system first', type: 'info' });
    
    // 受信データ
    const receivedData = ref([]);
    
    // 受信セッション管理（統一）
    const receivingSession = ref({
      active: false,          // セッション全体の状態
      currentTransfer: false, // 現在の転送中かどうか
      fragments: [],          // 受信フラグメント履歴
      totalReceived: 0,       // 総受信バイト数
      startTime: null,        // セッション開始時刻
      bytesPerSecond: 0,      // 受信レート
      
      // 現在の転送データ
      currentTransferData: {
        fragments: [],        // 現在の転送のフラグメント
        totalSize: 0,         // 現在の転送のサイズ
        dataType: null,       // 'text' | 'image' | null
        previewUrl: null      // 画像プレビューURL（画像の場合）
      }
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
    
    const canSendWithMic = computed(() => {
      // ループバック時は送信不要（testLoopbackのみ）
      if (inputSource.value === 'loopback') return false;
      return canSend.value && microphonePermission.value;
    });
    
    const canReceiveWithMic = computed(() => {
      // ループバック時は受信セッション不要（testLoopbackのみ）
      if (inputSource.value === 'loopback') return false;
      return systemReady.value && microphonePermission.value;
    });
    
    // テキストデータサイズ計算
    const textDataSize = computed(() => {
      if (inputText.value.trim()) {
        return new TextEncoder().encode(inputText.value).length;
      }
      return 0;
    });
    
    // Visualization variables
    let animationId = null;
    let inputWaveformData = null;
    
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
    
    // 送信ログ出力
    const logSend = (message) => {
      const timestamp = new Date().toLocaleTimeString();
      const logEntry = `[${timestamp}] ${message}`;
      sendLog.value += logEntry + '\n';
      console.log(`[SEND] ${logEntry}`);
      
      // Auto-scroll to bottom
      nextTick(() => {
        if (sendLogContent.value) {
          sendLogContent.value.scrollTop = sendLogContent.value.scrollHeight;
        }
      });
    };
    
    // 受信ログ出力
    const logReceive = (message) => {
      const timestamp = new Date().toLocaleTimeString();
      const logEntry = `[${timestamp}] ${message}`;
      receiveLog.value += logEntry + '\n';
      console.log(`[RECEIVE] ${logEntry}`);
      
      // Auto-scroll to bottom
      nextTick(() => {
        if (receiveLogContent.value) {
          receiveLogContent.value.scrollTop = receiveLogContent.value.scrollHeight;
        }
      });
    };
    
    // ステータス更新
    const updateStatus = (statusObj, message, type = 'info') => {
      statusObj.message = message;
      statusObj.type = type;
    };
    
    // データ比較機能
    const getComparisonResult = (receivedDataItem) => {
      if (receivedDataItem.type === 'text') {
        const originalText = inputText.value.trim();
        const receivedText = receivedDataItem.content;
        
        if (originalText === receivedText) {
          return '✅ Perfect Match';
        } else {
          return `❌ Mismatch (expected: "${originalText}")`;
        }
      } else if (receivedDataItem.type === 'image' && selectedImage.value) {
        // 画像の場合はサイズ比較（簡易的な比較）
        const originalSize = selectedImage.value.size;
        
        // Blob URLから実際のサイズを取得するのは困難なので、簡易的にファイル名で比較
        if (selectedImage.value.name && receivedDataItem.content) {
          return '✅ Image received (size comparison not available for blob URLs)';
        } else {
          return '❌ Image comparison failed';
        }
      }
      
      return 'ℹ️ Unable to compare';
    };
    
    // システム初期化
    const initializeSystem = async () => {
      try {
        log('Initializing audio system...');
        updateStatus(systemStatus, 'Initializing...', 'info');
        
        // AudioContext作成
        audioContext.value = new AudioContext();
        log(`AudioContext created: ${audioContext.value.sampleRate}Hz`);
        outputGain.value = audioContext.value.createGain();
        outputGain.value.gain.value = 0.5; // 初期ゲイン値 
        outputGain.value.connect(audioContext.value.destination);
        
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
        inputAnalyser.value = audioContext.value.createAnalyser();
        inputAnalyser.value.fftSize = 2048;
        outputGain.value.connect(inputAnalyser.value);
        
        // FSK設定
        const config = {
          ...DEFAULT_FSK_CONFIG,
          baudRate: 1200,
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
          maxPayloadSize: 255
        };
        senderTransport.value.configure(xmodemConfig);
        receiverTransport.value.configure(xmodemConfig);
        log('XModem transports configured successfully');
        
        systemReady.value = true;
        updateStatus(systemStatus, 'System initialized ✓ Try loopback test first!', 'success');
        updateStatus(sendStatus, 'Try loopback test first (no microphone needed)', 'info');
        updateStatus(receiveStatus, 'Try loopback test first (no microphone needed)', 'info');
        log('System initialization complete');
        
        // デバッグ情報の定期更新開始
        startDebugUpdates();
        
        // 可視化開始
        startVisualization();
        
      } catch (error) {
        const errorMsg = `Initialization failed: ${error.message}`;
        console.error(errorMsg, error);
        log(errorMsg);
        updateStatus(systemStatus, errorMsg, 'error');
        updateStatus(sendStatus, 'System initialization required', 'error');
        updateStatus(receiveStatus, 'System initialization required', 'error');
      }
    };
    
    // マイク権限要求
    const requestMicrophonePermission = async () => {
      try {
        log('Requesting microphone permission...');
        updateStatus(systemStatus, 'Requesting microphone access...', 'info');
        
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: audioContext.value.sampleRate,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });
        
        microphoneStream.value = stream;
        microphonePermission.value = true;
        inputSource.value = 'microphone'; // マイク入力に切り替え
        
        log(`Microphone permission granted: ${audioContext.value.sampleRate}Hz, 1 channel`);
        updateStatus(systemStatus, 'Microphone ready ✓ You can now use Send/Receive!', 'success');
        updateStatus(sendStatus, 'Ready to send with microphone', 'success');
        updateStatus(receiveStatus, 'Ready to receive with microphone', 'success');
        
      } catch (error) {
        const errorMsg = `Microphone access denied: ${error.message}`;
        console.error(errorMsg, error);
        log(errorMsg);
        updateStatus(systemStatus, errorMsg, 'error');
        updateStatus(sendStatus, 'Microphone required for Send', 'error');
        updateStatus(receiveStatus, 'Microphone required for Receive', 'error');
      }
    };
    
    // 入力ソース切り替え
    const toggleInputSource = () => {
      if (inputSource.value === 'loopback') {
        inputSource.value = 'microphone';
        log('Switched to microphone input mode');
        updateStatus(systemStatus, 'Using microphone input', 'info');
      } else {
        inputSource.value = 'loopback';
        log('Switched to loopback mode');
        updateStatus(systemStatus, 'Using loopback mode', 'info');
      }
    };
    
    // マイクロフォンモード切り替え（権限取得も含む）
    const toggleMicrophoneMode = async () => {
      if (!microphonePermission.value) {
        // マイク権限がない場合は権限を取得
        await requestMicrophonePermission();
      } else {
        // マイク権限がある場合は入力ソースを切り替え
        toggleInputSource();
      }
    };
    
    // データ送信
    const sendData = async () => {
      if (!canSendWithMic.value || isSending.value) {
        updateStatus(sendStatus, 'System not ready or microphone required', 'error');
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
        logSend(`Sending ${description}`);
        updateStatus(sendStatus, 'Preparing XModem transmission...', 'info');
        
        // 送信開始前にTransportを必ずリセット（プロトコルをIDLE状態から開始）
        senderTransport.value.reset();
        logSend('Sender transport reset to IDLE state');
        
        // 入力ソースに応じて接続を設定
        if (inputSource.value === 'microphone') {
          if (!microphoneStream.value) {
            throw new Error('Microphone not available');
          }
          
          // 送信者を音声出力に接続
          senderDataChannel.value.disconnect();
          senderDataChannel.value.connect(audioContext.value.outputGain);
          logSend('Connected sender to audio output');
          
          // マイクを送信者に接続
          const source = audioContext.value.createMediaStreamSource(microphoneStream.value);
          source.connect(senderDataChannel.value);
          logSend('Connected: microphone → sender');
        } else {
          // ループバックモードの接続設定は testXModemLoopback と同じ
          senderDataChannel.value.disconnect();
          receiverDataChannel.value.disconnect();
          
          const hub = audioContext.value.createGain();
          hub.gain.value = 1.0;
          senderDataChannel.value.connect(hub);
          receiverDataChannel.value.connect(hub);
          hub.connect(audioContext.value.outputGain);
          hub.connect(senderDataChannel.value);
          hub.connect(receiverDataChannel.value);
          logSend('Connected: sender → receiver (internal loopback)');
        }
        
        logSend(`Sending ${data.length} bytes via XModem protocol`);
        const modeIcon = inputSource.value === 'microphone' ? '🎤' : '🔄';
        updateStatus(sendStatus, `${modeIcon} Sending via XModem...`, 'info');
        
        await senderTransport.value.sendData(data);
        
        if (isSending.value) {
          updateStatus(sendStatus, `✓ XModem send completed: ${description}`, 'success');
          logSend('XModem transmission completed successfully');
        }
        
      } catch (error) {
        console.error(errorMsg, error);
        if (isSending.value) {
          let errorMsg = `XModem send failed: ${error.message}`;
          
          if (error.message.includes('Transport busy')) {
            errorMsg = 'Sender is busy. Please wait and try again.';
            logSend('Sender transport is currently busy');
          } else if (error.message.includes('timeout')) {
            errorMsg = 'Send timeout. No receiver found or connection failed.';
            logSend('XModem send timed out - no receiver response');
          } else if (error.message.includes('Microphone not available')) {
            errorMsg = 'Microphone required. Click "Enable Microphone" first.';
            logSend('Microphone not available for sending');
          }
          
          logSend(errorMsg);
          updateStatus(sendStatus, errorMsg, 'error');
        }
      } finally {
        isSending.value = false;
      }
    };
    
    // 送信停止
    const stopSending = () => {
      if (!isSending.value) return;
      
      isSending.value = false;
      
      // 接続をリセット（マイクストリーム自体は保持）
      if (senderDataChannel.value) {
        senderDataChannel.value.disconnect();
        logSend('Disconnected sender and reset connections');
      }
      
      updateStatus(sendStatus, 'Sending stopped', 'info');
      logSend('XModem sending stopped');
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
        hub.connect(outputGain.value);
        hub.connect(senderDataChannel.value);
        hub.connect(receiverDataChannel.value);
        
        log('Connected: sender → receiver (internal loopback)');
        log(`Testing ${data.length} bytes via XModem protocol`);

        receiverTransport.value.on('fragmentReceived', onFragmentReceived);
        
        try {
          // ループバック用の一時的セッション開始
          receivingSession.value.active = true;
          resetReceivingSession();
          receivingSession.value.active = true; // resetReceivingSessionがリセットするので再設定
          
          // ループバック前にTransportをリセット（プロトコルをIDLE状態から開始）
          senderTransport.value.reset();
          receiverTransport.value.reset();
          log('Both transports reset to IDLE state for loopback');
          
          // 送受信開始
          log('Starting sender...');
          const sendPromise = senderTransport.value.sendData(data);
          
          await new Promise(resolve => setTimeout(resolve, 500));
          
          log('Starting receiver...');
          const receivePromise = receiverTransport.value.receiveData();
          
          const [_, receivedData] = await Promise.all([sendPromise, receivePromise]);
          
          // フラグメントリスナーを削除
          receiverTransport.value.off('fragmentReceived', onFragmentReceived);
          
          // ループバックセッション終了
          receivingSession.value.active = false;
        
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
        } catch (loopbackError) {
          // リスナーを必ず削除
          receiverTransport.value.off('fragmentReceived', onFragmentReceived);
          receivingSession.value.active = false;
          throw loopbackError;
        }
        
      } catch (error) {
        const errorMsg = `XModem loopback test failed: ${error.message}`;
        console.error(errorMsg, error);
        log(errorMsg);
        updateStatus(systemStatus, errorMsg, 'error');
        
        // エラー時もリスナーをクリーンアップ
        try {
          receiverTransport.value.off('fragmentReceived', onFragmentReceived);
        } catch (cleanupError) {
          // クリーンアップエラーは無視
        }
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
    
    // フラグメント受信リスナー（統一）
    const onFragmentReceived = (event) => {
      console.log('Fragment received:', event.data);
      const data = event.data;
      const now = Date.now();
      const session = receivingSession.value;
      
      // セッションが非アクティブなら無視
      if (!session.active) return;
      
      // 転送開始時の初期化
      if (!session.currentTransfer) {
        session.currentTransfer = true;
        session.startTime = now;
        
        // データ種別判定
        const dataType = detectDataType(data.fragment);
        session.currentTransferData.dataType = dataType;
        session.currentTransferData.fragments = [];
        session.currentTransferData.totalSize = 0;
        
        if (dataType === 'image') {
          log('🖼️ Image transfer started');
        } else {
          log('📝 Text transfer started');
        }
      }
      
      // フラグメント履歴に追加
      session.fragments.push({
        seqNum: data.seqNum,
        size: data.fragment.length,
        timestamp: new Date(data.timestamp).toLocaleTimeString(),
        data: data.fragment
      });
      
      // 現在の転送データに追加
      session.currentTransferData.fragments.push(data.fragment);
      session.currentTransferData.totalSize += data.fragment.length;
      session.totalReceived = data.totalBytesReceived;
      
      // 受信レート計算
      const elapsedMs = now - session.startTime;
      session.bytesPerSecond = elapsedMs > 0 ? Math.round((data.totalBytesReceived * 1000) / elapsedMs) : 0;
      
      // 画像の場合はプレビュー更新
      if (session.currentTransferData.dataType === 'image') {
        updateImagePreview();
        const isLoopback = inputSource.value === 'loopback';
        const prefix = isLoopback ? '🔄' : '🖼️';
        log(`${prefix} Image fragment #${data.seqNum}: ${data.fragment.length}B (total: ${session.currentTransferData.totalSize}B)`);
        
        if (isLoopback) {
          updateStatus(systemStatus, `${prefix} Fragment #${data.seqNum}: ${data.fragment.length}B (${data.totalBytesReceived}B)`, 'info');
        } else {
          updateStatus(receiveStatus, `${prefix} Fragment #${data.seqNum}: ${data.fragment.length}B (${data.totalBytesReceived}B @ ${session.bytesPerSecond}B/s)`, 'info');
        }
      } else {
        const isLoopback = inputSource.value === 'loopback';
        const prefix = isLoopback ? '🔄' : '📦';
        log(`${prefix} Fragment #${data.seqNum}: ${data.fragment.length}B, total: ${data.totalBytesReceived}B (${session.bytesPerSecond}B/s)`);
        
        if (isTextData(data.fragment)) {
          const partialText = new TextDecoder().decode(data.fragment);
          if (isLoopback) {
            updateStatus(systemStatus, `${prefix} Fragment #${data.seqNum}: "${partialText}"`, 'info');
          } else {
            updateStatus(receiveStatus, `${prefix} Fragment #${data.seqNum}: "${partialText}" (${data.totalBytesReceived}B @ ${session.bytesPerSecond}B/s)`, 'info');
          }
        } else {
          if (isLoopback) {
            updateStatus(systemStatus, `${prefix} Fragment #${data.seqNum}: ${data.fragment.length}B`, 'info');
          } else {
            updateStatus(receiveStatus, `${prefix} Fragment #${data.seqNum}: ${data.fragment.length}B (${data.totalBytesReceived}B @ ${session.bytesPerSecond}B/s)`, 'info');
          }
        }
      }
    };
    
    // 受信セッション開始（マイクロフォンモードのみ）
    const startReceiving = async () => {
      if (receivingSession.value.active || !canReceiveWithMic.value) return;
      
      try {
        logReceive('Starting XModem receiving session...');
        updateStatus(receiveStatus, '🎤 Starting reception session...', 'info');

        // セッション状態をリセット
        resetReceivingSession();
        
        // 受信開始前にTransportをリセット（プロトコルをIDLE状態から開始）
        receiverTransport.value.reset();
        logReceive('Receiver transport reset to IDLE state');
        
        // フラグメント受信リスナーを登録
        receiverTransport.value.on('fragmentReceived', onFragmentReceived);
        
        // マイク接続
        if (!microphoneStream.value) {
          throw new Error('Microphone not available');
        }
        
        receiverDataChannel.value.disconnect();
        receiverDataChannel.value.connect(audioContext.value.outputGain);
        
        const source = audioContext.value.createMediaStreamSource(microphoneStream.value);
        source.connect(receiverDataChannel.value);
        logReceive('Connected: microphone → receiver');
        
        // セッション開始
        receivingSession.value.active = true;
        updateStatus(receiveStatus, '🎤 Ready for XModem transmission...', 'success');
        logReceive('Reception session started - ready for single transfers');
        
        // 単発受信を開始
        awaitSingleTransfer();
        
      } catch (error) {
        let errorMsg = `Failed to start reception session: ${error.message}`;
        
        if (error.message.includes('Microphone not available')) {
          errorMsg = 'Microphone required. Click "Enable Microphone" first.';
          logReceive('Microphone not available for receiving');
        }
        
        logReceive(errorMsg);
        updateStatus(receiveStatus, errorMsg, 'error');
        receivingSession.value.active = false;
      }
    };
    
    // 単発転送を待機
    const awaitSingleTransfer = async () => {
      if (!receivingSession.value.active) return;
      
      try {
        logReceive('Waiting for single XModem transfer...');
        updateStatus(receiveStatus, '🎤 Waiting for transmission...', 'info');
        
        const receivedBytes = await receiverTransport.value.receiveData();
        
        if (receivedBytes.length > 0 && receivingSession.value.active) {
          handleTransferComplete(receivedBytes);
          
          // 次の転送を待機（セッションがアクティブなら）
          setTimeout(() => {
            if (receivingSession.value.active) {
              resetCurrentTransfer();
              awaitSingleTransfer();
            }
          }, 1000);
        }
      } catch (error) {
        if (receivingSession.value.active) {
          logReceive(`Transfer error: ${error.message}`);
          
          if (error.message.includes('max retries exceeded')) {
            // max retries exceeded時はセッション全体を停止
            logReceive('Max retries exceeded, stopping reception session');
            updateStatus(receiveStatus, 'Reception failed: Max retries exceeded', 'error');
            stopReceiving();
            return; // 再試行しない
          } else if (error.message.includes('Transport busy')) {
            logReceive('Transport busy, retrying...');
            setTimeout(() => awaitSingleTransfer(), 2000);
          } else if (error.message.includes('timeout')) {
            logReceive('Transfer timeout, waiting for next...');
            resetCurrentTransfer();
            setTimeout(() => awaitSingleTransfer(), 1000);
          } else {
            updateStatus(receiveStatus, `Transfer error: ${error.message}`, 'error');
            setTimeout(() => awaitSingleTransfer(), 2000);
          }
        }
      }
    };
    
    // 転送完了処理
    const handleTransferComplete = (receivedBytes) => {
      const session = receivingSession.value;
      
      if (session.currentTransferData.dataType === 'image') {
        logReceive(`✅ Image transfer completed: ${receivedBytes.length} bytes`);
        
        const blob = new Blob([receivedBytes], { type: 'image/jpeg' });
        const finalUrl = URL.createObjectURL(blob);
        addReceivedData('image', finalUrl);
        
        updateStatus(receiveStatus, `✅ Image received: ${receivedBytes.length} bytes`, 'success');
      } else {
        const text = new TextDecoder().decode(receivedBytes);
        logReceive(`✅ Text transfer completed: "${text}"`);
        addReceivedData('text', text);
        updateStatus(receiveStatus, `✅ Text received: "${text}"`, 'success');
      }
    };
    
    // 現在の転送をリセット（セッションは継続）
    const resetCurrentTransfer = () => {
      const session = receivingSession.value;
      session.currentTransfer = false;
      
      // 古いプレビューURLを削除
      if (session.currentTransferData.previewUrl) {
        URL.revokeObjectURL(session.currentTransferData.previewUrl);
      }
      
      session.currentTransferData = {
        fragments: [],
        totalSize: 0,
        dataType: null,
        previewUrl: null
      };
    };
    
    // 受信セッション全体をリセット
    const resetReceivingSession = () => {
      const session = receivingSession.value;
      
      // 古いプレビューURLを削除
      if (session.currentTransferData.previewUrl) {
        URL.revokeObjectURL(session.currentTransferData.previewUrl);
      }
      
      receivingSession.value = {
        active: false,
        currentTransfer: false,
        fragments: [],
        totalReceived: 0,
        startTime: null,
        bytesPerSecond: 0,
        currentTransferData: {
          fragments: [],
          totalSize: 0,
          dataType: null,
          previewUrl: null
        }
      };
    };
    
    // 受信停止
    const stopReceiving = () => {
      if (!receivingSession.value.active) return;
      
      // セッション終了
      receivingSession.value.active = false;
      
      // フラグメント受信リスナーを削除
      if (receiverTransport.value) {
        receiverTransport.value.off('fragmentReceived', onFragmentReceived);
      }
      
      // 接続をリセット（マイクストリーム自体は保持）
      if (receiverDataChannel.value) {
        receiverDataChannel.value.disconnect();
        logReceive('Disconnected receiver and reset connections');
      }
      
      updateStatus(receiveStatus, 'Reception session stopped', 'info');
      logReceive('XModem reception session stopped');
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
    
    // 受信開始時のデータ種別を判定
    const detectDataType = (firstFragment) => {
      // 画像ファイルのマジックナンバーをチェック
      if (firstFragment.length >= 12) {
        const bytes = Array.from(firstFragment.slice(0, 12));
        console.log("Detecting data type from first fragment:", bytes);
        
        // JPEG: FF D8 FF
        if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
          return 'image';
        }
        
        // PNG: 89 50 4E 47
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
          return 'image';
        }
        
        // GIF: 47 49 46
        if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
          return 'image';
        }

        // BMP: 42 4D
        if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
          return 'image';
        }

        // WebP: 52 49 46 46 __ __ __ __ 57 45 42 50
        if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
          return 'image';
        }
      }
      
      // テキストかどうかを判定
      return isTextData(firstFragment) ? 'text' : 'image';
    };
    
    // 画像フラグメントを結合してプレビューを更新
    const updateImagePreview = () => {
      const session = receivingSession.value;
      if (!session.currentTransfer || session.currentTransferData.fragments.length === 0) return;
      
      try {
        // フラグメントを結合
        const fragments = session.currentTransferData.fragments;
        const totalSize = fragments.reduce((sum, frag) => sum + frag.length, 0);
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        
        for (const fragment of fragments) {
          combined.set(fragment, offset);
          offset += fragment.length;
        }
        
        // Blobを作成してプレビュー用URLを生成
        const blob = new Blob([combined], { type: 'image/jpeg' });
        
        // 古いURLを削除
        if (session.currentTransferData.previewUrl) {
          URL.revokeObjectURL(session.currentTransferData.previewUrl);
        }
        
        session.currentTransferData.previewUrl = URL.createObjectURL(blob);
        
      } catch (error) {
        log(`Image preview update failed: ${error.message}`);
      }
    };
    
    // カスタムファイル選択
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
          preview,
          source: 'custom'
        };
        
        // サンプル選択をリセット
        sampleImageSelection.value = '';
        
        log(`Custom image selected: ${file.name} (${file.size} bytes)`);
      } catch (error) {
        log(`Failed to load custom image: ${error.message}`);
        selectedImage.value = null;
      }
    };
    
    // サンプル画像選択
    const onSampleImageSelect = async () => {
      if (!sampleImageSelection.value) {
        selectedImage.value = null;
        return;
      }
      
      try {
        const sampleFile = sampleImages.value.find(img => img.value === sampleImageSelection.value);
        if (!sampleFile || !sampleFile.value) return;
        
        // サンプルファイルをfetchで取得
        const response = await fetch(`./assets/sample-files/${sampleFile.value}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const blob = new Blob([arrayBuffer]);
        const preview = URL.createObjectURL(blob);
        
        // ファイル名から拡張子を取得してMIMEタイプを推定
        const extension = sampleFile.value.split('.').pop().toLowerCase();
        const mimeType = extension === 'png' ? 'image/png' : 'image/jpeg';
        
        selectedImage.value = {
          name: sampleFile.value,
          size: arrayBuffer.byteLength,
          type: mimeType,
          data: new Uint8Array(arrayBuffer),
          preview,
          source: 'sample'
        };
        
        log(`Sample image selected: ${sampleFile.name} (${arrayBuffer.byteLength} bytes)`);
      } catch (error) {
        log(`Failed to load sample image: ${error.message}`);
        selectedImage.value = null;
        sampleImageSelection.value = '';
      }
    };
    
    // デバッグ切り替え
    const toggleDebug = () => {
      showDebug.value = !showDebug.value;
    };
    
    // 波形表示切り替え
    const toggleVisualization = () => {
      showVisualization.value = !showVisualization.value;
    };
    
    // ログクリア
    const clearLogs = () => {
      sendLog.value = '';
      receiveLog.value = '';
      logSend('Logs cleared');
      logReceive('Logs cleared');
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
      if (!inputAnalyser.value) return;
      
      const bufferLength = inputAnalyser.value.frequencyBinCount;
      inputWaveformData = new Uint8Array(bufferLength);
      
      const animate = () => {
        if (!systemReady.value || !showVisualization.value) {
          animationId = requestAnimationFrame(animate);
          return;
        }
        
        // 受信者（復調器入力）のデータのみ取得・表示
        inputAnalyser.value.getByteTimeDomainData(inputWaveformData);

        // 統合された可視化canvasに描画
        drawUnifiedWaveform(visualizerCanvas.value, inputWaveformData);

        animationId = requestAnimationFrame(animate);
      };
      
      animate();
    };
    
    // 統合波形描画
    const drawUnifiedWaveform = (canvas, data) => {
      if (!canvas || !data) return;
      
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;
      
      // 背景をクリア
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      
      // グリッド線を描画
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      ctx.beginPath();
      
      // 水平グリッド
      for (let i = 0; i <= 4; i++) {
        const y = (height / 4) * i;
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      
      // 垂直グリッド
      for (let i = 0; i <= 8; i++) {
        const x = (width / 8) * i;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      ctx.stroke();
      
      // 波形描画
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#00ff88';
      ctx.beginPath();
      
      const sliceWidth = width / data.length;
      let x = 0;
      
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128.0; // -1 to 1の範囲に正規化
        const y = height / 2 + (v * height / 2);
        
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        
        x += sliceWidth;
      }
      
      ctx.stroke();
      
      // 中央線
      ctx.strokeStyle = '#666';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
    };
    
    // 波形描画（レガシー - 必要時のみ使用）
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
      
      // 受信セッションをリセット
      resetReceivingSession();
      
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
      if (receivingSession.value.active) {
        stopReceiving();
      }
      if (isSending.value) {
        stopSending();
      }
      
      // マイクストリームを停止
      if (microphoneStream.value) {
        microphoneStream.value.getTracks().forEach(track => {
          track.stop();
          log(`Stopped microphone track: ${track.kind}`);
        });
        microphoneStream.value = null;
        microphonePermission.value = false;
      }
    };
    
    return {
      // State
      systemReady,
      isSending,
      showDebug,
      showVisualization,
      sendDataType,
      inputText,
      selectedImage,
      sampleImageSelection,
      sampleImages,
      systemLog,
      sendLog,
      receiveLog,
      systemStatus,
      sendStatus,
      receiveStatus,
      receivedData,
      receivingSession,
      senderDebugInfo,
      receiverDebugInfo,
      
      // マイク権限と入力ソース
      microphonePermission,
      inputSource,
      
      // Computed
      canSend,
      canSendWithMic,
      canReceiveWithMic,
      textDataSize,
      
      // Canvas refs
      visualizerCanvas,
      sendLogContent,
      receiveLogContent,
      
      // Methods
      initializeSystem,
      requestMicrophonePermission,
      toggleInputSource,
      toggleMicrophoneMode,
      sendData,
      stopSending,
      testXModemLoopback,
      startReceiving,
      stopReceiving,
      onImageSelect,
      onSampleImageSelect,
      toggleDebug,
      toggleVisualization,
      clearLogs,
      clearAll,
      getComparisonResult,
      cleanup
    };
  }
});

app.mount('#app');
