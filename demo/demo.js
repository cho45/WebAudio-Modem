/**
 * WebAudio-Modem Simple Demo
 * 
 * シンプルなテキスト送受信デモ（音声入力対応）
 */

import { WebAudioDataChannel } from '../src/webaudio/webaudio-data-channel.js';
import { DEFAULT_FSK_CONFIG } from '../src/modems/fsk.js';

// Global state
let audioContext = null;
let modulator = null;
let demodulator = null;
let isListening = false;
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
        
        // Create modulator and demodulator
        modulator = new WebAudioDataChannel(audioContext, 'fsk-processor');
        demodulator = new WebAudioDataChannel(audioContext, 'fsk-processor');
        log('AudioWorkletNodes created');
        
        // Configure both with FSK settings
        const config = {
            ...DEFAULT_FSK_CONFIG,
            sampleRate: audioContext.sampleRate
        };
        
        log('Configuring FSK processors with settings:', config);
        await modulator.configure(config);
        await demodulator.configure(config);
        log('FSK processors configured successfully');
        
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

// Digital loopback test: modulator -> [demodulator, destination]
async function testDigitalLoopback() {
    if (!audioContext || !modulator || !demodulator) {
        updateStatus('test-status', 'System not initialized', 'error');
        return;
    }
    
    try {
        const text = document.getElementById('input-text').value.trim();
        if (!text) {
            updateStatus('test-status', 'Please enter text to test', 'error');
            return;
        }
        
        log(`Starting digital loopback test with: "${text}"`);
        updateStatus('test-status', 'Running digital loopback test...', 'info');
        
        // Disconnect any previous connections
        modulator.disconnect();
        demodulator.disconnect();
        
        // Connect: modulator -> [demodulator, destination] (分岐)
        modulator.connect(demodulator);
        modulator.connect(audioContext.destination);
        log('Connected: modulator → [demodulator, destination]');
        
        // Convert text to bytes and modulate
        const data = new TextEncoder().encode(text);
        log(`Modulating ${data.length} bytes: [${Array.from(data).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
        
        await modulator.modulate(data);
        log('Modulation started');
        
        // IDataChannel.demodulate() blocks until data is available
        log('Waiting for demodulation (blocking call)...');
        const received = await demodulator.demodulate();
        
        // Process result
        const receivedText = new TextDecoder().decode(received);
        log(`Demodulated ${received.length} bytes: [${Array.from(received).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
        log(`Demodulated text: "${receivedText}"`);
        
        // Update UI
        updateOutput(receivedText);
        
        if (receivedText === text) {
            updateStatus('test-status', '✓ Perfect digital loopback!', 'success');
            log('Digital loopback test: PASSED - Perfect match');
        } else {
            updateStatus('test-status', `⚠ Partial match: "${receivedText}"`, 'info');
            log(`Digital loopback test: PARTIAL - Expected: "${text}", Got: "${receivedText}"`);
        }
        
    } catch (error) {
        const errorMsg = `Digital loopback test failed: ${error.message}`;
        log(errorMsg);
        updateStatus('test-status', errorMsg, 'error');
    }
}

// Play audio signal: modulator -> destination
async function playAudio() {
    if (!audioContext || !modulator) {
        updateStatus('test-status', 'System not initialized', 'error');
        return;
    }
    
    try {
        const text = document.getElementById('input-text').value.trim();
        if (!text) {
            updateStatus('test-status', 'Please enter text to play', 'error');
            return;
        }
        
        log(`Playing audio signal for: "${text}"`);
        updateStatus('test-status', 'Playing audio signal...', 'info');
        
        // Disconnect previous connections
        modulator.disconnect();
        
        // Connect: modulator -> destination (audio output)
        modulator.connect(audioContext.destination);
        log('Connected: modulator → destination (speakers)');
        
        // Convert and modulate
        const data = new TextEncoder().encode(text);
        await modulator.modulate(data);
        
        updateStatus('test-status', `✓ Audio signal played for: "${text}"`, 'success');
        log('Audio signal generation complete');
        
    } catch (error) {
        const errorMsg = `Audio playback failed: ${error.message}`;
        log(errorMsg);
        updateStatus('test-status', errorMsg, 'error');
    }
}

// Start listening for audio input: microphone -> demodulator
async function startListening() {
    if (isListening) {
        log('Already listening for audio input');
        return;
    }
    
    if (!audioContext || !demodulator) {
        updateStatus('test-status', 'System not initialized', 'error');
        return;
    }
    
    try {
        log('Starting audio listening...');
        updateStatus('test-status', 'Starting microphone input...', 'info');
        
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
        demodulator.disconnect();
        
        // Connect: microphone -> demodulator
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(demodulator);
        log('Connected: microphone → demodulator');
        
        isListening = true;
        currentStream = stream;
        updateStatus('test-status', '🎤 Listening for FSK signals...', 'success');
        log('Audio listening started - waiting for FSK signals...');
        updateUI();
        
        // Blocking reception loop (no polling delay needed)
        const listenLoop = async () => {
            while (isListening) {
                try {
                    // demodulate() blocks until data is available
                    const received = await demodulator.demodulate();
                    
                    if (received.length > 0) {
                        const text = new TextDecoder().decode(received);
                        const cleanText = text.replace(/[\x00-\x1F\x7F-\x9F]/g, ''); // Remove control characters
                        
                        log(`Received from audio: ${received.length} bytes: [${Array.from(received).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
                        log(`Received text: "${cleanText}"`);
                        
                        if (cleanText) {
                            updateOutput(cleanText);
                            updateStatus('test-status', `📡 Received: "${cleanText}"`, 'success');
                        }
                    }
                } catch (error) {
                    if (isListening) {
                        log(`Reception error: ${error.message}`);
                        // Small delay on error to prevent tight error loop
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }
            }
        };
        
        listenLoop();
        
    } catch (error) {
        const errorMsg = `Failed to start audio listening: ${error.message}`;
        log(errorMsg);
        updateStatus('test-status', errorMsg, 'error');
        isListening = false;
        updateUI();
    }
}

// Stop listening for audio input
function stopListening() {
    if (!isListening) {
        log('Not currently listening');
        return;
    }
    
    isListening = false;
    
    // Clean up audio resources
    if (currentStream) {
        currentStream.getTracks().forEach(track => {
            track.stop();
            log(`Stopped microphone track: ${track.kind}`);
        });
        currentStream = null;
    }
    
    // Disconnect demodulator
    if (demodulator) {
        demodulator.disconnect();
        log('Disconnected demodulator from microphone');
    }
    
    updateStatus('test-status', 'Stopped listening', 'info');
    log('Audio listening stopped');
    updateUI();
}

// UI management
function updateUI() {
    const systemReady = audioContext && modulator && demodulator && 
                       modulator.isReady() && demodulator.isReady();
    
    // Update button states
    document.getElementById('init-btn').disabled = systemReady;
    document.getElementById('loopback-btn').disabled = !systemReady;
    document.getElementById('play-btn').disabled = !systemReady;
    document.getElementById('listen-btn').disabled = !systemReady || isListening;
    
    // Show/hide Stop Listening button based on listening state
    const stopBtn = document.getElementById('stop-btn');
    if (isListening) {
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
        const timestamp = new Date().toLocaleTimeString();
        const currentContent = outputElement.textContent;
        
        if (currentContent === 'No data received') {
            outputElement.textContent = `[${timestamp}] ${text}`;
        } else {
            outputElement.textContent = currentContent + `\n[${timestamp}] ${text}`;
        }
    }
}

function clearReceivedData() {
    const outputElement = document.getElementById('output-text');
    if (outputElement) {
        outputElement.textContent = 'No data received';
    }
    log('Received data cleared');
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

function clearLog() {
    document.getElementById('log').value = '';
    log('Log cleared');
}

// Export functions to global scope for HTML onclick handlers
window.initializeSystem = initializeSystem;
window.testDigitalLoopback = testDigitalLoopback;
window.playAudio = playAudio;
window.startListening = startListening;
window.stopListening = stopListening;
window.clearLog = clearLog;
window.clearReceivedData = clearReceivedData;