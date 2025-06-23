/**
 * WebAudio-Modem Simple Demo
 * 
 * シンプルなテキスト送受信デモ（音声入力対応）
 */

import { WebAudioDataChannel } from '../src/webaudio/webaudio-data-channel.js';
import { DEFAULT_FSK_CONFIG } from '../src/modems/fsk.js';
import { XModemTransport } from '../src/transports/xmodem/xmodem.js';
// import { send } from 'vite';

// Global state
let audioContext = null;
let senderDataChannel = null;
let receiverDataChannel = null;
let senderTransport = null;
let receiverTransport = null;
let isReceiving = false;
let currentStream = null;

// Initialize the demo application
window.addEventListener('DOMContentLoaded', () => {
    log('WebAudio-Modem Demo loaded');
    updateUI();
});

// System initialization
async function initializeSystem() {
    try {
        log('Initializing audio system...');
        updateStatus('system-status', 'Initializing...', 'info');
       
        // Create AudioContext
        audioContext = new AudioContext();
        log(`AudioContext created: ${audioContext.sampleRate}Hz`);
        
        // Resume AudioContext (requires user interaction)
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
            log('AudioContext resumed');
        }
        
        // Add AudioWorklet module
        await WebAudioDataChannel.addModule(audioContext, '../src/webaudio/processors/fsk-processor.js');
        log('FSK processor module loaded');
        
        // Create sender and receiver data channels
        senderDataChannel = new WebAudioDataChannel(audioContext, 'fsk-processor', {
            processorOptions: {
                name: 'sender',
            }
        });
        receiverDataChannel = new WebAudioDataChannel(audioContext, 'fsk-processor', {
            processorOptions: {
                name: 'receiver',
            }
        });
        log('AudioWorkletNodes created');

//         setInterval(async () => {
//             const senderInfo = await senderDataChannel.getStatus();
//             document.getElementById('send-info').textContent = JSON.stringify(senderInfo, null, 2);
//             const receiverInfo = await receiverDataChannel.getStatus();
//             document.getElementById('receive-info').textContent = JSON.stringify(receiverInfo, null, 2);
//         }, 500);
       
        // Configure both with FSK settings
        const config = {
            ...DEFAULT_FSK_CONFIG,
            sampleRate: audioContext.sampleRate
        };
        
        log('Configuring FSK processors with settings:', config);
        await senderDataChannel.configure(config);
        await receiverDataChannel.configure(config);
        log('FSK processors configured successfully');
        
        // Create XModem transports
        senderTransport = new XModemTransport(senderDataChannel);
        receiverTransport = new XModemTransport(receiverDataChannel);
        
        // Configure XModem settings
        const xmodemConfig = {
            timeoutMs: 5000,
            maxRetries: 3,
            maxPayloadSize: 64  // Smaller packets for audio transmission
        };
        senderTransport.configure(xmodemConfig);
        receiverTransport.configure(xmodemConfig);
        log('XModem transports configured successfully');
        log(`Sender transport ready: ${senderTransport.isReady()}`);
        log(`Receiver transport ready: ${receiverTransport.isReady()}`);
        
        updateStatus('system-status', 'System initialized successfully ✓', 'success');
        updateStatus('test-status', 'Ready for testing', 'success');
        log('System initialization complete');
        updateUI();
        
    } catch (error) {
        const errorMsg = `Initialization failed: ${error.message}`;
        log(errorMsg);
        updateStatus('system-status', errorMsg, 'error');
        updateStatus('test-status', 'System initialization required', 'error');
    }
}

// Send text using XModem protocol
async function sendTextViaXModem() {
    if (!audioContext || !senderTransport) {
        updateStatus('send-status', 'System not initialized', 'error');
        return;
    }
    
    try {
        const text = document.getElementById('input-text').value.trim();
        if (!text) {
            updateStatus('send-status', 'Please enter text to send', 'error');
            return;
        }
        
        log(`Sending text via XModem: "${text}"`);
        updateStatus('send-status', 'Preparing XModem transmission...', 'info');

        // Get microphone input
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                sampleRate: audioContext.sampleRate,
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            } 
        });
        
        log(`Microphone access granted: ${audioContext.sampleRate}Hz, 1 channel`);
        
        // Connect sender to audio output for transmission
        senderDataChannel.disconnect();
        senderDataChannel.connect(audioContext.destination);
        log('Connected sender to audio output');

        // Connect: microphone -> sender
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(senderDataChannel);
        log('Connected: microphone → sender');
        
        // Convert text to bytes and send via XModem
        const data = new TextEncoder().encode(text);
        log(`Sending ${data.length} bytes via XModem protocol`);
        
        updateStatus('send-status', 'Sending via XModem...', 'info');
        await senderTransport.sendData(data);
        
        updateStatus('send-status', `✓ XModem send completed: "${text}"`, 'success');
        log('XModem transmission completed successfully');
        
    } catch (error) {
        let errorMsg = `XModem send failed: ${error.message}`;
        
        // Handle specific error cases
        if (error.message.includes('Transport busy')) {
            errorMsg = 'Sender is busy. Please wait and try again.';
            log('Sender transport is currently busy');
        } else if (error.message.includes('timeout')) {
            errorMsg = 'Send timeout. No receiver found or connection failed.';
            log('XModem send timed out - no receiver response');
        }
        
        log(errorMsg);
        updateStatus('send-status', errorMsg, 'error');
    }
}

// XModem loopback test: sender -> receiver (internal)
async function testXModemLoopback() {
    if (!audioContext || !senderTransport || !receiverTransport) {
        updateStatus('test-status', 'System not initialized', 'error');
        return;
    }
    
    try {
        const text = document.getElementById('input-text').value.trim();
        if (!text) {
            updateStatus('test-status', 'Please enter text to test', 'error');
            return;
        }
        
        log(`Starting XModem loopback test with: "${text}"`);
        updateStatus('test-status', 'Running XModem loopback test...', 'info');
        
        // Disconnect any previous connections
        senderDataChannel.disconnect();
        receiverDataChannel.disconnect();
        

        const hub = audioContext.createGain();
        hub.gain.value = 1.0; // Set gain to 1.0
        senderDataChannel.connect(hub);
        receiverDataChannel.connect(hub);
        hub.connect(audioContext.destination);

        hub.connect(senderDataChannel);
        hub.connect(receiverDataChannel);
       
        // Connect: sender -> receiver (internal loopback)
        log('Connected: sender → receiver (internal loopback)');
        
        // Convert text to bytes
        const data = new TextEncoder().encode(text);
        log(`Testing ${data.length} bytes via XModem protocol`);
        
        // Check transport states before starting
        log(`Sender state before test: ready=${senderTransport.isReady()}`);
        log(`Receiver state before test: ready=${receiverTransport.isReady()}`);
        
        log('Starting sender...');
        const sendPromise = senderTransport.sendData(data);
        
        // Wait a bit for receiver to be ready
        await new Promise(resolve => setTimeout(resolve, 500));

        log('Starting receiver...');
        const receivePromise = receiverTransport.receiveData()
        
        
        // Wait for both to complete
        const [_, receivedData] = await Promise.all([sendPromise, receivePromise]);
        
        // Process result
        const receivedText = new TextDecoder().decode(receivedData);
        log(`XModem loopback result: "${receivedText}"`);
        
        // Update UI
        updateOutput(receivedText);
        
        if (receivedText === text) {
            updateStatus('test-status', '✓ Perfect XModem loopback!', 'success');
            log('XModem loopback test: PASSED - Perfect match');
        } else {
            updateStatus('test-status', `⚠ Partial match: "${receivedText}"`, 'info');
            log(`XModem loopback test: PARTIAL - Expected: "${text}", Got: "${receivedText}"`);
        }
        
    } catch (error) {
        const errorMsg = `XModem loopback test failed: ${error.message}`;
        log(errorMsg);
        updateStatus('test-status', errorMsg, 'error');
    }
}

// Start receiving text via XModem protocol
async function startReceiving() {
    if (isReceiving) {
        log('Already receiving XModem data');
        return;
    }
    
    if (!audioContext || !receiverTransport) {
        updateStatus('receive-status', 'System not initialized', 'error');
        return;
    }
    
    try {
        log('Starting XModem reception...');
        updateStatus('receive-status', 'Starting microphone input...', 'info');
        
        // Get microphone input
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                sampleRate: audioContext.sampleRate,
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            } 
        });
        
        log(`Microphone access granted: ${audioContext.sampleRate}Hz, 1 channel`);
        
        // Disconnect previous connections
        receiverDataChannel.disconnect();
        receiverDataChannel.connect(audioContext.destination);
        
        // Connect: microphone -> receiver
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(receiverDataChannel);
        log('Connected: microphone → receiver');
        
        isReceiving = true;
        currentStream = stream;
        updateStatus('receive-status', '🎤 Listening for XModem transmission...', 'success');
        log('XModem reception started - waiting for data...');
        updateUI();
        
        // XModem reception loop
        const receiveLoop = async () => {
            while (isReceiving) {
                try {
                    log('Waiting for XModem data...');
                    updateStatus('receive-status', '🎤 Waiting for XModem transmission...', 'info');
                    
                    const receivedData = await receiverTransport.receiveData();
                    
                    if (receivedData.length > 0) {
                        const text = new TextDecoder().decode(receivedData);
                        log(`XModem received: ${receivedData.length} bytes → "${text}"`);
                        
                        updateOutput(text);
                        updateStatus('receive-status', `📡 XModem received: "${text}"`, 'success');
                        
                        // Reset status for next transmission after a delay
                        setTimeout(() => {
                            if (isReceiving) {
                                updateStatus('receive-status', '🎤 Listening for next XModem transmission...', 'info');
                            }
                        }, 2000);
                    }
                } catch (error) {
                    if (isReceiving) {
                        log(`XModem reception error: ${error.message}`);
                        
                        // Check if it's a "Transport busy" error
                        if (error.message.includes('Transport busy')) {
                            log('Receiver is busy, waiting before retry...');
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        } else {
                            updateStatus('receive-status', `Reception error: ${error.message}`, 'error');
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
        updateStatus('receive-status', errorMsg, 'error');
        isReceiving = false;
        updateUI();
    }
}

// Stop receiving XModem data
function stopReceiving() {
    if (!isReceiving) {
        log('Not currently receiving');
        return;
    }
    
    isReceiving = false;
    
    // Clean up audio resources
    if (currentStream) {
        currentStream.getTracks().forEach(track => {
            track.stop();
            log(`Stopped microphone track: ${track.kind}`);
        });
        currentStream = null;
    }
    
    // Disconnect receiver
    if (receiverDataChannel) {
        receiverDataChannel.disconnect();
        log('Disconnected receiver from microphone');
    }
    
    updateStatus('receive-status', 'Stopped receiving', 'info');
    log('XModem reception stopped');
    updateUI();
}

// UI management
function updateUI() {
    const systemReady = audioContext && senderTransport && receiverTransport && 
                       senderTransport.isReady() && receiverTransport.isReady();
    
    // Update button states
    document.getElementById('init-btn').disabled = systemReady;
    document.getElementById('send-btn').disabled = !systemReady;
    document.getElementById('loopback-btn').disabled = !systemReady;
    document.getElementById('receive-btn').disabled = !systemReady || isReceiving;
    
    // Show/hide Stop Receiving button based on receiving state
    const stopBtn = document.getElementById('stop-btn');
    if (isReceiving) {
        stopBtn.style.display = 'inline-block';
        stopBtn.disabled = false;
    } else {
        stopBtn.style.display = 'none';
        stopBtn.disabled = true;
    }
    
    // Update init button text
    if (systemReady) {
        document.getElementById('init-btn').textContent = 'System Ready ✓';
    }
}

function updateStatus(elementId, message, type = 'info') {
    const element = document.getElementById(elementId);
    if (element) {
        element.textContent = message;
        element.className = `status ${type}`;
    }
}

function updateOutput(text) {
    const outputElement = document.getElementById('output-text');
    if (outputElement) {
        const currentContent = outputElement.textContent;
        
        if (currentContent === 'No data received') {
            outputElement.textContent = text;
        } else {
            outputElement.textContent = currentContent + '\n' + text;
        }
    }
}

function clearAll() {
    // Clear received data
    const outputElement = document.getElementById('output-text');
    if (outputElement) {
        outputElement.textContent = 'No data received';
    }
    
    // Clear log
    document.getElementById('log').value = '';
    
    log('All data and logs cleared');
}

// Logging
function log(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}\n`;
    
    const logElement = document.getElementById('log');
    logElement.value += logEntry;
    logElement.scrollTop = logElement.scrollHeight;
    
    console.log(logEntry.trim());
}

// Export functions to global scope for HTML onclick handlers
window.initializeSystem = initializeSystem;
window.sendTextViaXModem = sendTextViaXModem;
window.testXModemLoopback = testXModemLoopback;
window.startReceiving = startReceiving;
window.stopReceiving = stopReceiving;
window.clearAll = clearAll;
